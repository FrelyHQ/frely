"use client";

import React, { useState } from "react";
import { ConsoleDialog, ConsoleDialogFooter } from "@frely/console-ui/console-dialog";
import { Notice } from "@frely/console-ui";
import { Button } from "@frely/ui/components/button";
import { Tooltip } from "@frely/ui/components/tooltip";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@admin/navigation";
import { deleteProvider as deleteProviderRequest } from "../api/provider-api";
import { providerDeletionBlockerMessage } from "../lib/provider-retention";

interface Provider {
  id: string;
  name: string;
  status: string;
}

export function DeleteProviderButton({ provider, deletionState }: { provider: Provider; deletionState: { hasAccessPointReferences: boolean; hasOnlineBillingHistory: boolean; credentialCleared: boolean } }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation({
    mutationFn: () => deleteProviderRequest(provider.id),
    onSuccess: () => router.refresh()
  });
  const blocker = providerDeletionBlockerMessage({ ...deletionState, providerDisabled: provider.status === "disabled" });

  return (
    <>
      <Tooltip content={blocker ?? undefined} wrapTrigger={Boolean(blocker)}>
        <Button type="button" variant="destructive" onClick={() => setConfirming(true)} disabled={mutation.isPending || Boolean(blocker)}>
          Delete
        </Button>
      </Tooltip>
      {confirming ? (
        <ConsoleDialog
          observabilityKey="provider-delete"
          titleId="delete-provider-title"
          eyebrow="Danger zone"
          title={`Delete ${provider.name}`}
          description="This archives the Provider structure for audit and recovery, then permanently removes the online Provider configuration. Credentials are never archived."
          closeDisabled={mutation.isPending}
          onClose={() => setConfirming(false)}
        >
          <Notice tone="bad">
            Confirm deletion of Provider <strong>{provider.name}</strong> (<code>{provider.id}</code>).
          </Notice>
          <ConsoleDialogFooter feedback={mutation.error ? <Notice tone="bad" live="alert">{mutation.error instanceof Error ? mutation.error.message : "Delete provider failed"}</Notice> : null}>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={mutation.isPending}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={() => mutation.mutate()} disabled={mutation.isPending}>{mutation.isPending ? "Deleting..." : "Delete Provider"}</Button>
          </ConsoleDialogFooter>
        </ConsoleDialog>
      ) : null}
    </>
  );
}
