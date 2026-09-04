"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "./alert.js";
import { Button } from "./button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./dialog.js";
import { Field, FieldGroup, FieldLabel } from "./field.js";
import { Input } from "./input.js";
import { Spinner } from "./spinner.js";
import { browserSupportsPasskeys, deletePasskey, listPasskeys, passkeyUserMessage, registerPasskey, renamePasskey, type AccountPasskey } from "../lib/passkey-api.js";

const PASSKEY_QUERY_KEY = ["account", "security", "passkeys"] as const;

export function PasskeyManagement() {
  const queryClient = useQueryClient();
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(browserSupportsPasskeys()), []);
  const query = useQuery({ queryKey: PASSKEY_QUERY_KEY, queryFn: listPasskeys, retry: false });
  const [name, setName] = useState("");
  const [registrationPassword, setRegistrationPassword] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const registrationInput = useRef<{ name: string; currentPassword: string } | null>(null);
  const deletionInput = useRef<{ id: string; currentPassword: string } | null>(null);

  const refresh = async () => queryClient.invalidateQueries({ queryKey: PASSKEY_QUERY_KEY });
  const registration = useMutation({
    mutationFn: async () => {
      const input = registrationInput.current;
      if (!input) throw new Error("Passkey registration state is unavailable");
      try {
        return await registerPasskey(input);
      } finally {
        registrationInput.current = null;
        setRegistrationPassword("");
      }
    },
    retry: false,
    onSuccess: async () => {
      setName("");
      setRegistrationPassword("");
      setNotice("Passkey added.");
      await refresh();
    }
  });
  const rename = useMutation({
    mutationFn: ({ id, nextName }: { id: string; nextName: string }) => renamePasskey(id, nextName),
    retry: false,
    onSuccess: async () => {
      setEditingId(null);
      setEditingName("");
      setNotice("Passkey renamed.");
      await refresh();
    }
  });
  const remove = useMutation({
    mutationFn: async () => {
      const input = deletionInput.current;
      if (!input) throw new Error("Passkey deletion state is unavailable");
      try {
        await deletePasskey(input.id, input.currentPassword);
      } finally {
        deletionInput.current = null;
        setDeletePassword("");
      }
    },
    retry: false,
    onSuccess: async () => {
      setDeletingId(null);
      setDeletePassword("");
      setNotice("Passkey deleted. Other Friday sessions were signed out.");
      queryClient.clear();
      await query.refetch();
    }
  });
  const error = registration.error ?? rename.error ?? remove.error ?? query.error;
  const canAdd = query.data?.canAdd ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>Add an optional Passkey for faster sign-in. Your password remains available for sign-in and recovery.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!supported ? <Alert><AlertTitle>Passkeys unavailable in this browser</AlertTitle><AlertDescription>You can still manage names and delete existing Passkeys, or continue using your password.</AlertDescription></Alert> : null}
        {notice ? <Alert role="status" aria-live="polite"><AlertTitle>Security settings updated</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertTitle>Unable to update Passkeys</AlertTitle><AlertDescription>{passkeyUserMessage(error)}</AlertDescription></Alert> : null}
        {!query.isPending && !canAdd ? <Alert><AlertTitle>Passkey limit reached</AlertTitle><AlertDescription>Delete an existing Passkey before adding another one on this sign-in domain.</AlertDescription></Alert> : null}

        <form onSubmit={(event) => {
          event.preventDefault();
          setNotice(null);
          registrationInput.current = { name, currentPassword: registrationPassword };
          void registration.mutateAsync().catch(() => undefined);
        }}>
          <FieldGroup>
            <Field><FieldLabel htmlFor="passkey-name">Passkey name</FieldLabel><Input id="passkey-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="MacBook Touch ID" maxLength={64} disabled={!supported || !canAdd || registration.isPending} /></Field>
            <Field><FieldLabel htmlFor="passkey-current-password">Current password</FieldLabel><Input id="passkey-current-password" type="password" autoComplete="current-password" value={registrationPassword} onChange={(event) => setRegistrationPassword(event.target.value)} disabled={!supported || !canAdd || registration.isPending} /></Field>
            <Button type="submit" disabled={!supported || !canAdd || !name.trim() || !registrationPassword || registration.isPending}>{registration.isPending ? <><Spinner data-icon="inline-start" />Waiting for authenticator...</> : "Add Passkey"}</Button>
          </FieldGroup>
        </form>

        <section className="space-y-3" aria-label="Your Passkeys">
          <h3 className="text-sm font-medium">Your Passkeys</h3>
          {query.isPending ? <p className="text-sm text-muted-foreground">Loading Passkeys...</p> : null}
          {!query.isPending && (query.data?.passkeys.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">No Passkeys added yet.</p> : null}
          {query.data?.passkeys.map((passkey) => <PasskeyRow
            key={passkey.id}
            passkey={passkey}
            editing={editingId === passkey.id}
            deleting={deletingId === passkey.id}
            editingName={editingName}
            deletePassword={deletePassword}
            pending={rename.isPending || remove.isPending}
            onEdit={() => { setEditingId(passkey.id); setEditingName(passkey.name); setDeletingId(null); setNotice(null); }}
            onCancelEdit={() => setEditingId(null)}
            onEditingNameChange={setEditingName}
            onRename={() => void rename.mutateAsync({ id: passkey.id, nextName: editingName }).catch(() => undefined)}
            onDelete={() => { setDeletingId(passkey.id); setDeletePassword(""); setEditingId(null); setNotice(null); }}
            onCancelDelete={() => setDeletingId(null)}
            onDeletePasswordChange={setDeletePassword}
            onConfirmDelete={() => {
              deletionInput.current = { id: passkey.id, currentPassword: deletePassword };
              void remove.mutateAsync().catch(() => undefined);
            }}
          />)}
        </section>
      </CardContent>
    </Card>
  );
}

function PasskeyRow(props: {
  passkey: AccountPasskey;
  editing: boolean;
  deleting: boolean;
  editingName: string;
  deletePassword: string;
  pending: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onEditingNameChange: (value: string) => void;
  onRename: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onDeletePasswordChange: (value: string) => void;
  onConfirmDelete: () => void;
}) {
  const { passkey } = props;
  return <div className="rounded-lg border p-4 space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="font-medium">{passkey.name}</p><p className="text-sm text-muted-foreground">Added {formatDate(passkey.createdAt)} · Available on {surfaceLabel(passkey.availableOn)}</p>{passkey.lastUsedAt ? <p className="text-xs text-muted-foreground">Last used {formatDate(passkey.lastUsedAt)}</p> : null}</div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" aria-label={`Rename ${passkey.name}`} onClick={props.onEdit} disabled={props.pending}>Rename</Button>
        <Dialog observabilityKey={`passkey-delete-${passkey.id}`} open={props.deleting} onOpenChange={(open) => { if (open) props.onDelete(); else if (!props.pending) props.onCancelDelete(); }}>
          <DialogTrigger asChild><Button type="button" variant="destructive" size="sm" aria-label={`Delete ${passkey.name}`} disabled={props.pending}>Delete</Button></DialogTrigger>
          <DialogContent autoFocusFirstElement>
            <DialogHeader><DialogTitle>Delete “{passkey.name}”?</DialogTitle><DialogDescription>Deleting this Passkey signs out your other Friday sessions. Also remove the entry from your password manager if it remains there.</DialogDescription></DialogHeader>
            <Field><FieldLabel htmlFor={`delete-password-${passkey.id}`}>Current password</FieldLabel><Input id={`delete-password-${passkey.id}`} type="password" autoComplete="current-password" value={props.deletePassword} onChange={(event) => props.onDeletePasswordChange(event.target.value)} /></Field>
            <DialogFooter><Button type="button" variant="destructive" aria-label={`Confirm delete ${passkey.name}`} onClick={props.onConfirmDelete} disabled={!props.deletePassword || props.pending}>Confirm delete</Button><Button type="button" variant="ghost" aria-label={`Cancel deleting ${passkey.name}`} onClick={props.onCancelDelete} disabled={props.pending}>Cancel</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
    {props.editing ? <div className="flex flex-wrap gap-2"><Input aria-label={`New name for ${passkey.name}`} value={props.editingName} onChange={(event) => props.onEditingNameChange(event.target.value)} maxLength={64} /><Button type="button" size="sm" aria-label={`Save name for ${passkey.name}`} onClick={props.onRename} disabled={!props.editingName.trim() || props.pending}>Save</Button><Button type="button" size="sm" variant="ghost" aria-label={`Cancel renaming ${passkey.name}`} onClick={props.onCancelEdit}>Cancel</Button></div> : null}
  </div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function surfaceLabel(surfaces: Array<"web" | "admin">): string {
  if (surfaces.length === 0) return "a previous RP configuration";
  return surfaces.map((surface) => surface === "admin" ? "Admin" : "Web").join(" and ");
}
