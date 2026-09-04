"use client";

import { useMemo, useState } from "react";
import { useRouter } from "@admin/navigation";
import { DataTable, type RowSelectionState } from "@frely/console-ui/data-table";
import { Button } from "@frely/ui/components/button";
import { Tooltip } from "@frely/ui/components/tooltip";
import { useMutation } from "@tanstack/react-query";
import type { AdminApiKeyOverviewRow } from "../../../lib/teams";
import { AdminDialog, ConsoleDialogFooter } from "../../../pages/owner/_components/ui";
import { revokeApiKeys } from "../api/api-key-api";
import { apiKeyColumns } from "../table/api-key-columns";

export function ApiKeysTable({ rows }: { rows: AdminApiKeyOverviewRow[] }) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const selectedRows = useMemo(() => rows.filter((row) => rowSelection[row.id]), [rowSelection, rows]);

  return <>
    <DataTable data={rows} columns={apiKeyColumns} getRowId={(row) => row.id} serverManaged table={{ minWidth: "wide" }} emptyState={{ title: "No keys match this search." }} getRowProps={() => ({ clickable: true })} state={{ rowSelection }} onStateChange={{ rowSelection: setRowSelection }} selection={{ selectedLabel: "API keys", bulkAction: { onClick: () => setBulkOpen(true) } }} />
    {bulkOpen ? <BulkKeysDialog apiKeys={selectedRows} onClose={() => setBulkOpen(false)} onSaved={() => { setBulkOpen(false); setRowSelection({}); }} /> : null}
  </>;
}

function BulkKeysDialog({ apiKeys, onClose, onSaved }: { apiKeys: AdminApiKeyOverviewRow[]; onClose: () => void; onSaved: () => void }) {
  const router = useRouter();
  const revocableKeys = apiKeys.filter((apiKey) => apiKey.status !== "Revoked");
  const disabledReason = revocableKeys.length === 0 ? "Select at least one non-revoked API key." : "";
  const mutation = useMutation({
    mutationFn: revokeApiKeys,
    retry: false,
    onSuccess: () => { onSaved(); router.refresh(); }
  });

  return <AdminDialog observabilityKey="api-key-bulk-edit" titleId="bulk-keys-dialog-title" eyebrow="Keys" title="Bulk edit" description={`${apiKeys.length} selected API keys`} onClose={onClose} closeDisabled={mutation.isPending}>
    <form onSubmit={(event) => { event.preventDefault(); if (disabledReason) return; void mutation.mutateAsync(revocableKeys.map((apiKey) => ({ apiKeyId: apiKey.id, failureLabel: apiKey.name }))); }}>
      <div className="notice-box notice-warn">Selected non-revoked API keys will be revoked. This is irreversible with the current Owner API.</div>
      <div className="embedded-section bulk-selection-summary"><strong>Selected API Keys</strong><div className="bulk-selection-list">{apiKeys.map((apiKey) => <div key={apiKey.id}><span>{apiKey.name}</span><code>{apiKey.prefix} / {apiKey.status}</code></div>)}</div></div>
      {disabledReason ? <div className="notice-box notice-bad">{disabledReason}</div> : null}
      <ConsoleDialogFooter feedback={mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Bulk key revoke failed"}</div> : null}>
        <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
        <Tooltip content={disabledReason} wrapTrigger><Button type="submit" variant="destructive" disabled={mutation.isPending || Boolean(disabledReason)}>{mutation.isPending ? "Revoking..." : `Revoke ${revocableKeys.length} Keys`}</Button></Tooltip>
      </ConsoleDialogFooter>
    </form>
  </AdminDialog>;
}
