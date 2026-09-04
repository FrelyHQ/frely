"use client";

import React, { useMemo, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@admin/navigation";
import { ConsoleDialog, ConsoleDialogFooter } from "@frely/console-ui/console-dialog";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { passwordPolicyMessage } from "@frely/auth/password-policy";
import { createOwnerUser } from "../api/user-api";
import { createUserFormDefaults, toCreateUserInput, type CreateUserTeamOption } from "../form/create-user-values";

export function CreateUserDialog({ teams }: { teams: CreateUserTeamOption[] }) {
  const [open, setOpen] = useState(false);

  return <>
    <Button type="button" disabled={teams.length === 0} onClick={() => setOpen(true)}>Create User</Button>
    {open ? <CreateUserForm teams={teams} onClose={() => setOpen(false)} /> : null}
  </>;
}

function CreateUserForm({ teams, onClose }: { teams: CreateUserTeamOption[]; onClose: () => void }) {
  const router = useRouter();
  const defaultValues = useMemo(() => createUserFormDefaults(teams), [teams]);
  const mutation = useMutation({ mutationFn: createOwnerUser, retry: false, gcTime: 0, onSuccess: () => { onClose(); router.refresh(); } });
  const form = useForm({ defaultValues, onSubmit: ({ value }) => mutation.mutateAsync(toCreateUserInput(value)) });

  return <ConsoleDialog observabilityKey="user-create" titleId="create-user-title" eyebrow="User Overview" title="Create User" description="Create a platform user and add them to an enabled Team." closeDisabled={mutation.isPending} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
        <div className="form-grid single">
          <form.Field name="teamId" validators={{ onSubmit: ({ value }) => value ? undefined : "Select a Team" }}>{(field) => <label>Team *<SearchSelect value={field.state.value} onValueChange={field.handleChange} disabled={mutation.isPending} options={teams.map((team) => ({ value: team.id, label: team.name, description: team.id }))} placeholder="Select Team" />{field.state.meta.errors.map((error) => <span className="field-error" key={String(error)}>{String(error)}</span>)}</label>}</form.Field>
          <form.Field name="email" validators={{ onBlur: ({ value }) => value.trim() ? undefined : "Email is required" }}>{(field) => <label>Email *<Input type="email" placeholder="user@example.com" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={mutation.isPending} />{field.state.meta.errors.map((error) => <span className="field-error" key={String(error)}>{String(error)}</span>)}</label>}</form.Field>
          <form.Field name="password" validators={{ onBlur: ({ value }) => passwordPolicyMessage(value), onChange: ({ value }) => passwordPolicyMessage(value) }}>{(field) => <label>Temporary Password *<Input type="password" autoComplete="new-password" required value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={mutation.isPending} /><span>Generated in this browser when the dialog opens. Use at least 12 characters and no more than 256 UTF-8 bytes, then share it securely.</span>{field.state.meta.errors.map((error) => <span className="field-error" key={String(error)}>{String(error)}</span>)}</label>}</form.Field>
        </div>
        <ConsoleDialogFooter feedback={mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error.message}</div> : null}><Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>{([canSubmit, submitting]) => <Button type="submit" disabled={!canSubmit || submitting || mutation.isPending}>{mutation.isPending ? "Creating..." : "Create User"}</Button>}</form.Subscribe></ConsoleDialogFooter>
      </form>
    </ConsoleDialog>;
}
