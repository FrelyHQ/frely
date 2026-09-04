"use client";

import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { consoleErrorMessage } from "./api-error.js";
import type { ApiKeyCreateActionPort, CreateApiKeyInput, CreateApiKeyResult } from "./api-key-action-model.js";
import { ConsoleDialog, ConsoleDialogFooter } from "./console-dialog.js";
import { CopyApiKeyButton } from "./copy-api-key-button.js";
import { resolveConsoleMessage, type ConsoleMessageResolver } from "./messages.js";
import type { ConsoleUser } from "./index.js";

export function ApiKeyActionDialog({
  user,
  actionPort,
  messageResolver,
}: {
  user: ConsoleUser;
  actionPort: ApiKeyCreateActionPort;
  messageResolver?: ConsoleMessageResolver;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <ApiKeyDialog
      user={user}
      actionPort={actionPort}
      {...(messageResolver ? { messageResolver } : {})}
      open={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
    />
  );
}

function ApiKeyDialog({
  user,
  actionPort,
  messageResolver,
  open,
  onOpen,
  onClose
}: {
  user: ConsoleUser;
  actionPort: ApiKeyCreateActionPort;
  messageResolver?: ConsoleMessageResolver;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const titleId = "create-api-key-title";
  const [isFinishing, setIsFinishing] = useState(false);
  const mutation = useMutation<CreateApiKeyResult, Error, CreateApiKeyInput>({
    mutationFn: (input) => actionPort.createApiKey(input),
    retry: false,
    gcTime: 0,
  });
  const form = useForm({
    defaultValues: { name: "", expiresAt: "" },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync({
          userId: user.id,
          name: value.name.trim(),
          expiresAt: value.expiresAt.trim() || null,
        });
      } catch {
        // TanStack Mutation owns the user-visible error state.
      }
    },
  });
  const created = mutation.data ?? null;

  function dismiss() {
    setIsFinishing(false);
    mutation.reset();
    form.reset();
    onClose();
  }

  function finish() {
    if (!created) return dismiss();
    const result = created;
    let completion: void | Promise<void>;
    try {
      completion = actionPort.onCreated(result);
    } catch (error) {
      dismiss();
      throw error;
    }
    mutation.reset();
    form.reset();
    setIsFinishing(true);
    void Promise.resolve(completion).finally(() => {
      setIsFinishing(false);
      onClose();
    });
  }

  return (
    <ConsoleDialog
      observabilityKey="api-key-action"
      titleId={titleId}
      eyebrow="API Keys"
      title={created || isFinishing ? resolveConsoleMessage(messageResolver, "api_key.created", "API Key Created") : resolveConsoleMessage(messageResolver, "api_key.create", "Create API Key")}
      open={open}
      trigger={<Button type="button">{resolveConsoleMessage(messageResolver, "api_key.create", "Create API Key")}</Button>}
      onOpen={() => {
        setIsFinishing(false);
        mutation.reset();
        form.reset();
        onOpen();
      }}
      onClose={finish}
      closeDisabled={mutation.isPending || isFinishing}
    >
      {isFinishing ? <div className="notice-box" role="status">
        {resolveConsoleMessage(messageResolver, "api_key.created", "API Key Created")}
      </div> : created ? <div className="form-grid">
        <div className="notice-box notice-warn" role="status">
          {resolveConsoleMessage(messageResolver, "api_key.copy_once", "Copy this API key now. The full value will not be available after you leave this dialog.")}
        </div>
        <div className="key-value-control">
          <code data-clarity-mask="true">{created.rawKey}</code>
          <CopyApiKeyButton value={created.rawKey} unavailableLabel="API key unavailable" />
        </div>
        <ConsoleDialogFooter>
          <Button type="button" onClick={finish}>Done</Button>
        </ConsoleDialogFooter>
      </div> : <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="form-grid">
          <label>
            Key Name
            <form.Field name="name">{(field) => <Input aria-label="Key Name" type="text" placeholder="Auto-generated if empty" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} />}</form.Field>
            <span>Leave empty to use a random short name.</span>
          </label>
          <label>
            Expires At
            <form.Field name="expiresAt">{(field) => <Input aria-label="Expires At" type="datetime-local" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} />}</form.Field>
            <span>Leave empty for a key without an expiry.</span>
          </label>
          <label>
            User
            <Input name="user" value={user.email} readOnly />
            <span data-clarity-mask="true">{user.id}</span>
          </label>
          <div className="notice-box">
            This key follows the owner user and automatically uses the user's current global, Team, and personal Plan sources.
          </div>
        </div>

        <ConsoleDialogFooter feedback={mutation.error ? <div className="notice-box notice-bad" role="alert" data-clarity-mask="true">{consoleErrorMessage(mutation.error, resolveConsoleMessage(messageResolver, "api_key.create_failed", "Failed to create API key"))}</div> : null}>
          <Button type="button" variant="secondary" onClick={dismiss} disabled={mutation.isPending}>
            Cancel
          </Button>
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>{([canSubmit, submitting]) => <Button type="submit" disabled={!canSubmit || submitting || mutation.isPending}>{mutation.isPending ? "Creating..." : resolveConsoleMessage(messageResolver, "api_key.create", "Create API Key")}</Button>}</form.Subscribe>
        </ConsoleDialogFooter>
      </form>}
    </ConsoleDialog>
  );
}
