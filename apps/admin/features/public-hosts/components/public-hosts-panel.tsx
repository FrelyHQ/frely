"use client";

import React, { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "@admin/navigation";
import { useMutation } from "@tanstack/react-query";
import { DataTable, type ColumnDef } from "@frely/console-ui/data-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import type { InstancePublicHostPage } from "@frely/ui-application/contracts";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { Button } from "@frely/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@frely/ui/components/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@frely/ui/components/dialog";
import { Input } from "@frely/ui/components/input";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import { createPublicHost, deletePublicHost, setPublicHostEnabled } from "../api/public-host-api";

interface PublicHostRow {
  id: string;
  hostname: string;
  enabled: boolean;
  source: "default" | "alias";
  createdAt: string | null;
  updatedAt: string | null;
}

export function PublicHostsPanel({
  defaultHost,
  aliases
}: {
  defaultHost: { hostname: string; origin: string };
  aliases: InstancePublicHostPage;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [hostname, setHostname] = useState("");
  const [statusHost, setStatusHost] = useState<PublicHostRow | null>(null);
  const [deleteHost, setDeleteHost] = useState<PublicHostRow | null>(null);
  const createMutation = useMutation({ mutationFn: createPublicHost, retry: false });
  const statusMutation = useMutation({ mutationFn: setPublicHostEnabled, retry: false });
  const deleteMutation = useMutation({ mutationFn: deletePublicHost, retry: false });
  const rows: PublicHostRow[] = [
    { id: "default", hostname: defaultHost.hostname, enabled: true, source: "default", createdAt: null, updatedAt: null },
    ...aliases.items.map((host) => ({ ...host, source: "alias" as const }))
  ];
  const columns = useMemo<Array<ColumnDef<PublicHostRow, unknown>>>(() => [
    {
      id: "hostname",
      header: "Host",
      accessorKey: "hostname",
      enableSorting: false,
      cell: ({ row }) => <div><code>{row.original.hostname}</code><div className="muted">{row.original.source === "default" ? "Canonical default" : "Instance alias"}</div></div>
    },
    {
      id: "status",
      header: "Status",
      accessorKey: "enabled",
      enableSorting: false,
      cell: ({ row }) => <StatusBadge tone={row.original.enabled ? "good" : "neutral"}>{row.original.enabled ? "Enabled" : "Disabled"}</StatusBadge>
    },
    {
      id: "updated",
      header: "Updated",
      accessorKey: "updatedAt",
      enableSorting: false,
      cell: ({ row }) => row.original.updatedAt ? <BrowserTime value={row.original.updatedAt} seconds /> : <span className="muted">Configuration</span>
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => row.original.source === "default"
        ? <span className="muted">Read-only</span>
        : <div className="row-actions">
            <Button type="button" size="sm" variant="secondary" onClick={() => { statusMutation.reset(); setStatusHost(row.original); }}>{row.original.enabled ? "Disable" : "Enable"}</Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => { deleteMutation.reset(); setDeleteHost(row.original); }}>Delete</Button>
          </div>
    }
  ], [deleteMutation, statusMutation]);

  return (
    <Card className="panel">
      <CardHeader>
        <div className="panel-heading">
          <div>
            <CardTitle>Public Hosts</CardTitle>
            <p className="muted">The canonical Host is always enabled. New aliases are disabled until explicitly enabled.</p>
          </div>
          <Button type="button" onClick={() => { createMutation.reset(); setHostname(""); setCreateOpen(true); }}>Add Host</Button>
        </div>
      </CardHeader>
      <CardContent>
        <DataTable
          serverManaged
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          emptyState={{ title: "No Public Hosts", description: "The canonical default remains available." }}
          table={{ "aria-label": "Public Hosts", minWidth: "wide" }}
        />
        <MaterialTablePagination
          page={aliases.page}
          pageSize={aliases.pageSize}
          total={aliases.total}
          totalPages={aliases.totalPages}
          pageParam="publicHostsPage"
          pageSizeParam="publicHostsPageSize"
          noun="Public Host aliases"
          rangeStart={aliases.total ? (aliases.page - 1) * aliases.pageSize + 1 : 0}
          rangeEnd={Math.min(aliases.page * aliases.pageSize, aliases.total)}
          previousHref={aliases.page > 1 ? pageHref(aliases.page - 1, aliases.pageSize) : ""}
          nextHref={aliases.page < aliases.totalPages ? pageHref(aliases.page + 1, aliases.pageSize) : ""}
        />
      </CardContent>

      <Dialog observabilityKey="public-host-create" open={createOpen} onOpenChange={(open) => { if (!createMutation.isPending) setCreateOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Public Host</DialogTitle>
            <DialogDescription>Enter one public DNS hostname. It will be created Disabled and will not receive traffic yet.</DialogDescription>
          </DialogHeader>
          <form id="create-public-host-form" className="form-grid" onSubmit={submitCreate}>
            <label>Hostname<Input autoFocus aria-label="Public Host hostname" value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder="relay.example.com" disabled={createMutation.isPending} /></label>
          </form>
          <DialogFooter feedback={createMutation.error ? <div className="notice-box notice-bad" role="alert">{errorMessage(createMutation.error)}</div> : null}>
            <Button type="button" variant="secondary" disabled={createMutation.isPending} onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" form="create-public-host-form" disabled={createMutation.isPending || !hostname.trim()}>{createMutation.isPending ? "Creating…" : "Create Disabled Host"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog observabilityKey="public-host-status" open={statusHost !== null} onOpenChange={(open) => { if (!open && !statusMutation.isPending) setStatusHost(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{statusHost?.enabled ? "Disable Public Host?" : "Enable Public Host?"}</DialogTitle>
            <DialogDescription>{statusHost?.enabled ? "New Web and Gateway requests on this Host will be rejected with host_not_allowed." : "Web and Gateway requests on this Host will resolve to the platform scope."}</DialogDescription>
          </DialogHeader>
          {statusHost ? <div className="detail-list"><div><span>Hostname</span><code>{statusHost.hostname}</code></div></div> : null}
          <DialogFooter feedback={statusMutation.error ? <div className="notice-box notice-bad" role="alert">{errorMessage(statusMutation.error)}</div> : null}>
            <Button type="button" variant="secondary" disabled={statusMutation.isPending} onClick={() => setStatusHost(null)}>Cancel</Button>
            <Button type="button" variant={statusHost?.enabled ? "warning" : "default"} disabled={!statusHost || statusMutation.isPending} onClick={confirmStatus}>{statusMutation.isPending ? "Saving…" : statusHost?.enabled ? "Disable Host" : "Enable Host"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog observabilityKey="public-host-delete" open={deleteHost !== null} onOpenChange={(open) => { if (!open && !deleteMutation.isPending) setDeleteHost(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Public Host?</DialogTitle>
            <DialogDescription>This removes only the instance alias. DNS and TLS records are not managed by Frely.</DialogDescription>
          </DialogHeader>
          {deleteHost ? <div className="detail-list"><div><span>Hostname</span><code>{deleteHost.hostname}</code></div></div> : null}
          <DialogFooter feedback={deleteMutation.error ? <div className="notice-box notice-bad" role="alert">{errorMessage(deleteMutation.error)}</div> : null}>
            <Button type="button" variant="secondary" disabled={deleteMutation.isPending} onClick={() => setDeleteHost(null)}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={!deleteHost || deleteMutation.isPending} onClick={confirmDelete}>{deleteMutation.isPending ? "Deleting…" : "Delete Host"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    try {
      await createMutation.mutateAsync(hostname);
      setCreateOpen(false);
      setHostname("");
      router.refresh();
    } catch {
      // Mutation state owns the server error displayed in the Dialog footer.
    }
  }

  async function confirmStatus() {
    if (!statusHost) return;
    try {
      await statusMutation.mutateAsync({ id: statusHost.id, enabled: !statusHost.enabled });
      setStatusHost(null);
      router.refresh();
    } catch {
      // Mutation state owns the server error displayed in the Dialog footer.
    }
  }

  async function confirmDelete() {
    if (!deleteHost) return;
    try {
      await deleteMutation.mutateAsync(deleteHost.id);
      setDeleteHost(null);
      router.refresh();
    } catch {
      // Mutation state owns the server error displayed in the Dialog footer.
    }
  }
}

function pageHref(page: number, pageSize: number): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("publicHostsPage", String(page));
  if (pageSize !== 20) params.set("publicHostsPageSize", String(pageSize));
  return `/owner/system-settings${params.size ? `?${params}` : ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Public Host operation failed";
}
