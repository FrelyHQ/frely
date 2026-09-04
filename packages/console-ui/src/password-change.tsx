"use client";

import React, { useRef, useState } from "react";
import { passwordPolicyMessage } from "@frely/auth/password-policy";
import { Alert, AlertDescription, AlertTitle } from "@frely/ui/components/alert";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@frely/ui/components/field";
import { Input } from "@frely/ui/components/input";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
}

export interface PasswordChangeResult {
  changed: true;
  otherSessionsRevoked: true;
}

export interface PasswordChangeActionPort {
  changePassword(input: PasswordChangeInput): Promise<PasswordChangeResult>;
}

interface PasswordChangeFormValues extends PasswordChangeInput {
  confirmPassword: string;
}

const defaults: PasswordChangeFormValues = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: ""
};

export function PasswordChangeForm({ actionPort }: { actionPort: PasswordChangeActionPort }) {
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const pendingInputRef = useRef<PasswordChangeInput | null>(null);
  const [visibility, setVisibility] = useState<Record<keyof PasswordChangeFormValues, boolean>>({
    currentPassword: false,
    newPassword: false,
    confirmPassword: false
  });
  const form = useForm({
    defaultValues: defaults,
    onSubmit: async ({ value }) => {
      pendingInputRef.current = {
        currentPassword: value.currentPassword,
        newPassword: value.newPassword
      };
      try {
        await mutation.mutateAsync();
      } catch {
        // The mutation owns user-facing error state and field cleanup.
      }
    }
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const input = pendingInputRef.current;
      if (!input) throw new Error("Password change input is unavailable");
      return actionPort.changePassword(input);
    },
    retry: false,
    gcTime: 0,
    onSuccess: () => {
      form.reset();
      setVisibility({ currentPassword: false, newPassword: false, confirmPassword: false });
    },
    onError: (error) => {
      const details = passwordChangeErrorDetails(error);
      form.resetField("currentPassword");
      if (details.status === 401 || details.status === null || details.status >= 500) {
        form.reset();
      }
      if (details.code === "current_password_invalid") currentPasswordRef.current?.focus();
      else if (details.code === "password_policy_failed" || details.code === "password_unchanged") newPasswordRef.current?.focus();
    },
    onSettled: () => {
      pendingInputRef.current = null;
    }
  });

  return (
    <Card className="panel password-change-panel">
      <div className="panel-heading">
        <div>
          <h2>Change password</h2>
          <p className="muted">Use your current password to protect this security change.</p>
        </div>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }} noValidate>
        <FieldGroup>
          <form.Field name="currentPassword" validators={{
            onChange: ({ value }) => value.length > 0 ? undefined : "Current password is required",
            onBlur: ({ value }) => value.length > 0 ? undefined : "Current password is required"
          }}>{(field) => (
            <PasswordField
              id="password-change-current"
              label="Current password"
              autoComplete="current-password"
              field={field}
              inputRef={currentPasswordRef}
              visible={visibility.currentPassword}
              onToggle={() => setVisibility((current) => ({ ...current, currentPassword: !current.currentPassword }))}
              disabled={mutation.isPending}
            />
          )}</form.Field>
          <form.Field name="newPassword" validators={{
            onChange: ({ value }) => passwordPolicyMessage(value),
            onBlur: ({ value }) => passwordPolicyMessage(value)
          }}>{(field) => (
            <PasswordField
              id="password-change-new"
              label="New password"
              autoComplete="new-password"
              field={field}
              inputRef={newPasswordRef}
              visible={visibility.newPassword}
              onToggle={() => setVisibility((current) => ({ ...current, newPassword: !current.newPassword }))}
              disabled={mutation.isPending}
              description="Use at least 12 characters and no more than 256 UTF-8 bytes. Spaces and Unicode are preserved."
            />
          )}</form.Field>
          <form.Field name="confirmPassword" validators={{
            onChange: ({ value }) => value === form.getFieldValue("newPassword") ? undefined : "Passwords do not match",
            onBlur: ({ value }) => value === form.getFieldValue("newPassword") ? undefined : "Passwords do not match"
          }}>{(field) => (
            <PasswordField
              id="password-change-confirm"
              label="Confirm new password"
              autoComplete="new-password"
              field={field}
              inputRef={confirmPasswordRef}
              visible={visibility.confirmPassword}
              onToggle={() => setVisibility((current) => ({ ...current, confirmPassword: !current.confirmPassword }))}
              disabled={mutation.isPending}
            />
          )}</form.Field>
          <Alert>
            <AlertTitle>Other Friday sessions will sign out</AlertTitle>
            <AlertDescription>Your current device will stay signed in after the password changes.</AlertDescription>
          </Alert>
          {mutation.error ? <PasswordChangeFailure error={mutation.error} /> : null}
          {mutation.isSuccess ? (
            <Alert role="status">
              <AlertTitle>Password changed</AlertTitle>
              <AlertDescription>Your current device remains signed in. Other Friday sessions have been signed out.</AlertDescription>
            </Alert>
          ) : null}
          <form.Subscribe selector={(state) => [
            state.canSubmit,
            state.isSubmitting,
            state.values.currentPassword,
            state.values.newPassword,
            state.values.confirmPassword
          ] as const}>{([canSubmit, isSubmitting, currentPassword, newPassword, confirmPassword]) => (
            <Button
              type="submit"
              disabled={
                !canSubmit
                || isSubmitting
                || mutation.isPending
                || !currentPassword
                || newPassword !== confirmPassword
                || Boolean(passwordPolicyMessage(newPassword))
              }
            >
              {mutation.isPending ? "Changing password..." : "Change password"}
            </Button>
          )}</form.Subscribe>
        </FieldGroup>
      </form>
    </Card>
  );
}

function PasswordField({
  id,
  label,
  autoComplete,
  field,
  inputRef,
  visible,
  onToggle,
  disabled,
  description
}: {
  id: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  field: {
    state: { value: string; meta: { errors: unknown[] } };
    handleBlur(): void;
    handleChange(value: string): void;
  };
  inputRef: React.RefObject<HTMLInputElement | null>;
  visible: boolean;
  onToggle(): void;
  disabled: boolean;
  description?: string;
}) {
  const errors = field.state.meta.errors.map(String);
  const errorId = `${id}-error`;
  const descriptionId = `${id}-description`;
  const describedBy = [description ? descriptionId : null, errors.length ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <Field data-invalid={errors.length > 0 || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="password-field-control">
        <Input
          ref={inputRef}
          id={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(event) => field.handleChange(event.target.value)}
          disabled={disabled}
          aria-invalid={errors.length > 0}
          aria-describedby={describedBy}
        />
        <Button type="button" variant="secondary" onClick={onToggle} disabled={disabled} aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}>
          {visible ? "Hide" : "Show"}
        </Button>
      </div>
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      <FieldError id={errorId}>{errors[0]}</FieldError>
    </Field>
  );
}

function PasswordChangeFailure({ error }: { error: unknown }) {
  const details = passwordChangeErrorDetails(error);
  const message = details.code === "current_password_invalid"
    ? "The current password is incorrect."
    : details.code === "password_policy_failed"
      ? "The new password does not meet the password policy."
      : details.code === "password_unchanged"
        ? "Choose a new password that differs from the current password."
        : details.code === "rate_limited"
          ? `Too many attempts. Try again${details.retryAfterSeconds ? ` in ${details.retryAfterSeconds} seconds` : " later"}.`
          : details.status === 401
            ? "Your session expired. Sign in again to continue."
            : "Password change failed. Try again.";
  return <Alert variant="destructive" role="alert"><AlertTitle>Unable to change password</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
}

function passwordChangeErrorDetails(error: unknown): {
  status: number | null;
  code: string | null;
  retryAfterSeconds: number | null;
} {
  if (!error || typeof error !== "object") return { status: null, code: null, retryAfterSeconds: null };
  const record = error as Record<string, unknown>;
  return {
    status: typeof record.status === "number" ? record.status : null,
    code: typeof record.code === "string" ? record.code : null,
    retryAfterSeconds: typeof record.retryAfterSeconds === "number" ? record.retryAfterSeconds : null
  };
}
