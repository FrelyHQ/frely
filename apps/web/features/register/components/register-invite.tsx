"use client";

import React from "react";
import { Alert, AlertDescription, AlertTitle } from "@frely/ui/components/alert";
import { Badge } from "@frely/ui/components/badge";
import { Button } from "@frely/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@frely/ui/components/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@frely/ui/components/field";
import { Input } from "@frely/ui/components/input";
import { Spinner } from "@frely/ui/components/spinner";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { acceptInvite, acceptLandingInvite, registerSelf } from "../api/register-api";
import { buildInviteLoginHref, registerFormDefaults, validateRegisterField, validateRegisterPasswordPresence } from "../form/register-form-values";

interface RegisterInviteProps {
  inviteToken?: string;
  landingEntry?: boolean;
  registrationEntry?: "global" | "partner";
  teamName: string;
  memberInvitesEnabled: boolean;
  inviteEmailDomainRestricted: boolean;
  currentUserEmail: string | null;
}

export function RegisterInvite({ inviteToken, landingEntry = false, registrationEntry, teamName, memberInvitesEnabled, inviteEmailDomainRestricted, currentUserEmail }: RegisterInviteProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({ mutationFn: (body: { email?: string; password?: string }) => registrationEntry ? registerSelf({ entry: registrationEntry, email: body.email ?? "", password: body.password ?? "" }) : landingEntry ? acceptLandingInvite(body) : acceptInvite({ inviteToken: inviteToken!, ...body }), retry: false, gcTime: 0, onSuccess: () => queryClient.getQueryCache().clear() });
  const form = useForm({
    defaultValues: registerFormDefaults,
    onSubmit: ({ value }) => {
      if (value.password !== value.confirmPassword) return;
      return mutation.mutateAsync({ email: value.email, password: value.password });
    }
  });
  const loginHref = registrationEntry ? `/login?entry=${registrationEntry}&next=/user` : landingEntry ? "/login?entry=landing&next=/user" : buildInviteLoginHref(inviteToken!);
  const outcome = mutation.data?.outcome;
  const accountOutcome = mutation.data?.accountOutcome;

  return (
    <Card className="w-full">
      <CardHeader>
        <Badge variant="secondary" className="w-fit">{registrationEntry ? "Self registration" : "Team invitation"}</Badge>
        <CardTitle>{registrationEntry ? `Create an account and join ${teamName}` : `Join ${teamName}`}</CardTitle>
        <CardDescription>{currentUserEmail ? "Confirm this invitation to join the Team." : "Enter your email and password. If the email is already registered, we’ll use the existing account."}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {outcome ? <InviteSuccess teamName={teamName} alreadyJoined={outcome === "already_joined"} accountAlreadyRegistered={accountOutcome === "already_registered"} /> : <>
          <Alert>
            <AlertTitle>Review Team access before joining</AlertTitle>
            <AlertDescription>
              <p>Joining may let you use resources this Team grants to members and may consume its plans, budgets, or balance.</p>
              {memberInvitesEnabled ? <p>You will also be able to create your own invitation link and invite more people.</p> : null}
            </AlertDescription>
          </Alert>
          {inviteEmailDomainRestricted ? <Alert><AlertTitle>Email domain restricted</AlertTitle><AlertDescription>Registration is restricted to an approved email domain.</AlertDescription></Alert> : null}
          {currentUserEmail ? <SignedInConfirmation email={currentUserEmail} teamName={teamName} pending={mutation.isPending} onConfirm={() => mutation.mutate({})} /> : <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
            <FieldGroup>
              <form.Field name="email" validators={{ onBlur: ({ value }) => validateRegisterField(value, "Email"), onChange: ({ value }) => validateRegisterField(value, "Email") }}>{(field) => {
                const errors = field.state.meta.errors.map(String);
                const invalid = errors.length > 0;
                return <Field data-invalid={invalid || undefined}>
                  <FieldLabel htmlFor="register-email">Email</FieldLabel>
                  <Input id="register-email" type="email" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} autoComplete="email" aria-invalid={invalid} aria-describedby={invalid ? "register-email-error" : undefined} />
                  <FieldError id="register-email-error">{errors[0]}</FieldError>
                </Field>;
              }}</form.Field>
              <form.Field name="password" validators={{ onBlur: ({ value }) => validateRegisterPasswordPresence(value), onChange: ({ value }) => validateRegisterPasswordPresence(value) }}>{(field) => {
                const errors = field.state.meta.errors.map(String);
                const invalid = errors.length > 0;
                return <Field data-invalid={invalid || undefined}>
                  <FieldLabel htmlFor="register-password">Password</FieldLabel>
                  <Input id="register-password" type="password" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} autoComplete="new-password" aria-invalid={invalid} aria-describedby={invalid ? "register-password-error" : undefined} />
                  <FieldDescription>New accounts use at least 12 characters and no more than 256 UTF-8 bytes.</FieldDescription>
                  <FieldError id="register-password-error">{errors[0]}</FieldError>
                </Field>;
              }}</form.Field>
              <form.Field name="confirmPassword" validators={{ onBlur: ({ value }) => validateRegisterPasswordPresence(value, "Password confirmation"), onChange: ({ value }) => validateRegisterPasswordPresence(value, "Password confirmation") }}>{(field) => {
                const requiredErrors = field.state.meta.errors.map(String);
                const mismatch = Boolean(field.state.value) && field.state.value !== form.getFieldValue("password");
                const errors = mismatch ? ["Passwords do not match"] : requiredErrors;
                const invalid = errors.length > 0;
                return <Field data-invalid={invalid || undefined}>
                  <FieldLabel htmlFor="register-confirm-password">Confirm password</FieldLabel>
                  <Input id="register-confirm-password" type="password" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} autoComplete="new-password" aria-invalid={invalid} aria-describedby={invalid ? "register-confirm-password-error" : undefined} />
                  <FieldError id="register-confirm-password-error">{errors[0]}</FieldError>
                </Field>;
              }}</form.Field>
              <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting, state.values.password, state.values.confirmPassword] as const}>{([canSubmit, submitting, password, confirmPassword]) => <Button type="submit" className="h-auto min-h-9 w-full whitespace-normal py-2 text-center" disabled={!canSubmit || password !== confirmPassword || submitting || mutation.isPending}>{mutation.isPending ? <><Spinner data-icon="inline-start" />{registrationEntry ? "Creating account..." : "Joining..."}</> : registrationEntry ? `Create account and join ${teamName}` : `Continue and join ${teamName}`}</Button>}</form.Subscribe>
            </FieldGroup>
          </form>}
          {mutation.error ? <Alert variant="destructive"><AlertTitle>{registrationEntry ? "Unable to register" : "Unable to accept invitation"}</AlertTitle><AlertDescription>{mutation.error instanceof Error ? mutation.error.message : registrationEntry ? "Failed to register" : "Failed to accept invite"}</AlertDescription></Alert> : null}
        </>}
      </CardContent>
      {!currentUserEmail && !outcome ? <CardFooter className="justify-center"><p className="text-center text-sm text-muted-foreground">Already have an account? <a className="font-medium text-primary underline underline-offset-4" href={loginHref}>Sign in to accept this invitation.</a></p></CardFooter> : null}
    </Card>
  );
}

function SignedInConfirmation({ email, teamName, pending, onConfirm }: { email: string; teamName: string; pending: boolean; onConfirm: () => void }) {
  return <FieldGroup>
    <Field>
      <FieldDescription>Signed in as</FieldDescription>
      <p className="font-medium break-words">{email}</p>
    </Field>
    <Button type="button" className="h-auto min-h-9 w-full whitespace-normal py-2 text-center" onClick={onConfirm} disabled={pending}>{pending ? <><Spinner data-icon="inline-start" />Joining...</> : `Confirm and join ${teamName}`}</Button>
  </FieldGroup>;
}

function InviteSuccess({ teamName, alreadyJoined, accountAlreadyRegistered }: { teamName: string; alreadyJoined: boolean; accountAlreadyRegistered: boolean }) {
  const title = alreadyJoined
    ? `You’re already a member of ${teamName}.`
    : accountAlreadyRegistered
      ? `Your account was already registered, and you joined ${teamName}.`
      : `You joined ${teamName}.`;
  const description = alreadyJoined
    ? "No membership changes were needed."
    : accountAlreadyRegistered
      ? "We used your existing account; no new account was created."
      : "Your account can now use the Team resources available to you.";
  return <div className="flex flex-col gap-4">
    <Alert role="status"><AlertTitle>{title}</AlertTitle><AlertDescription>{description}</AlertDescription></Alert>
    <Button asChild><a href="/user">Go to User Console</a></Button>
  </div>;
}
