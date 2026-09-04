"use client";

import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Alert, AlertDescription, AlertTitle } from "./alert.js";
import { Button } from "./button.js";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card.js";
import { Field, FieldError, FieldGroup, FieldLabel } from "./field.js";
import { Input } from "./input.js";
import { Spinner } from "./spinner.js";
import { cn } from "../lib/utils.js";
import { login, type AuthenticatedLoginUser } from "../lib/login-api.js";

interface LoginFormProps {
  className?: string;
  onSuccess: (user: AuthenticatedLoginUser) => void;
  registrationHref?: string | undefined;
  registrationPrompt?: string | undefined;
  registrationLabel?: string | undefined;
}

export function LoginForm({ className, onSuccess, registrationHref, registrationPrompt, registrationLabel = "Create an account" }: LoginFormProps) {
  const queryClient = useQueryClient();
  const loginGeneration = useRef(0);
  const passwordLoginInput = useRef<{ credentials: { email: string; password: string }; generation: number } | null>(null);
  const finishLogin = ({ user, generation }: { user: AuthenticatedLoginUser; generation: number }) => {
    if (generation !== loginGeneration.current) return;
    queryClient.clear();
    onSuccess(user);
  };
  const mutation = useMutation({
    mutationFn: async () => {
      const input = passwordLoginInput.current;
      if (!input) throw new Error("Password sign-in state is unavailable");
      try {
        return { user: await login(input.credentials), generation: input.generation };
      } finally {
        passwordLoginInput.current = null;
      }
    },
    retry: false,
    onSuccess: finishLogin
  });
  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      const generation = ++loginGeneration.current;
      passwordLoginInput.current = { credentials: { ...value }, generation };
      return mutation.mutateAsync();
    }
  });
  const syncVisibleValues = (formElement: HTMLFormElement, validate = false) => {
    const submitted = new FormData(formElement);
    const options = validate ? undefined : { dontRunListeners: true, dontUpdateMeta: true, dontValidate: true };
    form.setFieldValue("email", String(submitted.get("email") ?? ""), options);
    form.setFieldValue("password", String(submitted.get("password") ?? ""), options);
    if (validate) {
      form.setFieldMeta("email", (meta) => ({ ...meta, errorMap: { ...meta.errorMap, onBlur: undefined } }));
      form.setFieldMeta("password", (meta) => ({ ...meta, errorMap: { ...meta.errorMap, onBlur: undefined } }));
    }
  };

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to your Frely account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onBlurCapture={(event) => syncVisibleValues(event.currentTarget)} onSubmit={(event) => {
          event.preventDefault();
          syncVisibleValues(event.currentTarget, true);
          void form.handleSubmit().catch(() => undefined);
        }}>
          <FieldGroup>
            <form.Field name="email" validators={{ onBlur: ({ value }) => value.trim() ? undefined : "Email is required", onChange: ({ value }) => value.trim() ? undefined : "Email is required" }}>{(field) => {
              const errors = field.state.meta.errors.map(String);
              const invalid = errors.length > 0;
              return <Field data-invalid={invalid || undefined}>
                <FieldLabel htmlFor="login-name">Email</FieldLabel>
                <Input id="login-name" name="email" type="email" autoComplete="username" defaultValue={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} aria-invalid={invalid} aria-describedby={invalid ? "login-name-error" : undefined} autoFocus />
                <FieldError id="login-name-error">{errors[0]}</FieldError>
              </Field>;
            }}</form.Field>
            <form.Field name="password" validators={{ onBlur: ({ value }) => value ? undefined : "Password is required", onChange: ({ value }) => value ? undefined : "Password is required" }}>{(field) => {
              const errors = field.state.meta.errors.map(String);
              const invalid = errors.length > 0;
              return <Field data-invalid={invalid || undefined}>
                <FieldLabel htmlFor="login-password">Password</FieldLabel>
                <Input id="login-password" name="password" type="password" autoComplete="current-password" defaultValue={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} aria-invalid={invalid} aria-describedby={invalid ? "login-password-error" : undefined} />
                <FieldError id="login-password-error">{errors[0]}</FieldError>
              </Field>;
            }}</form.Field>
            {mutation.error ? <Alert variant="destructive"><AlertTitle>Unable to sign in</AlertTitle><AlertDescription>{loginErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
            <form.Subscribe selector={(state) => state.isSubmitting}>{(submitting) => <Button type="submit" className="w-full" disabled={submitting || mutation.isPending}>{submitting || mutation.isPending ? <><Spinner data-icon="inline-start" />Signing in...</> : "Sign in"}</Button>}</form.Subscribe>
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className="justify-center">
        {registrationHref ? <p className="text-center text-sm text-muted-foreground">{registrationPrompt ?? "No account yet?"} <a className="font-medium text-primary underline underline-offset-4" href={registrationHref}>{registrationLabel}</a></p> : <p className="text-center text-sm text-muted-foreground">Need access? Ask a Team owner for an invitation.</p>}
      </CardFooter>
    </Card>
  );
}

function loginErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to sign in";
}
