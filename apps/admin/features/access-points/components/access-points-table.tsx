"use client";
import { useMemo, useState } from "react";
import { useRouter } from "@admin/navigation";
import { useMutation } from "@tanstack/react-query";
import {
  DataTable,
  type ColumnDef,
  type RowSelectionState,
} from "@frely/console-ui/data-table";
import { AccessPointDescription } from "@frely/console-ui/access-point-description";
import { ConsoleDialog, ConsoleDialogFooter } from "@frely/console-ui/console-dialog";
import { Notice } from "@frely/console-ui";
import { Button } from "@frely/ui/components/button";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import { deleteAccessPoint } from "../api/access-point-api";
import { accessPointRowId } from "../table/access-point-table-state";
import type { AccessPointPageData, AccessPointSummary } from "../types";
import { AccessPointDialog } from "./access-point-dialog";
import { BulkAccessPointsDialog } from "./bulk-access-points-dialog";

export function AccessPointsTable({ data }: { data: AccessPointPageData }) {
  const router = useRouter();
  const [selection, setSelection] = useState<RowSelectionState>({}),
    [editing, setEditing] = useState<AccessPointSummary>(),
    [deleting, setDeleting] = useState<AccessPointSummary>(),
    [bulkOpen, setBulkOpen] = useState(false);
  const rows = data.accessPoints;
  const selected = useMemo(
    () => data.accessPoints.filter((row) => selection[row.id]),
    [data.accessPoints, selection],
  );
  const remove = useMutation({
    mutationFn: deleteAccessPoint,
    retry: false,
    onSuccess: () => {
      setDeleting(undefined);
      router.refresh();
    },
  });
  const columns = useMemo<Array<ColumnDef<AccessPointSummary, unknown>>>(
    () => [
      {
        id: "accessPoint",
        header: "Access Point",
        accessorFn: (r) => `${r.name} ${r.id}`,
        cell: ({ row }) => (
          <>
            <strong>{row.original.name}</strong>
            <AccessPointDescription description={row.original.description} />
            <code>{row.original.id}</code>
          </>
        ),
      },
      {
        id: "exposedModel",
        header: "Exposed Model",
        accessorKey: "exposedModel",
        cell: ({ row }) => <code>{row.original.exposedModel}</code>,
      },
      {
        id: "targetModel",
        header: "Target Model",
        accessorKey: "targetModel",
        cell: ({ row }) => (
          <div className="model-pair">
            <code>{row.original.targetModel}</code>
            <span>
              {row.original.exposedModel === row.original.targetModel
                ? "same as exposed"
                : "mapped target"}
            </span>
          </div>
        ),
      },
      {
        id: "upstreamTarget",
        header: "Upstream Target",
        accessorFn: (r) => `${r.targetType} ${targetLabel(r)}`,
        cell: ({ row }) => (
          <div className="model-pair">
            <strong>{row.original.targetType}</strong>
            <code>{targetLabel(row.original)}</code>
          </div>
        ),
      },
      {
        id: "scope",
        header: "Scopes",
        accessorFn: (r) => `${r.ownerId} ${r.scopeRef}`,
        cell: ({ row }) => (
          <div className="model-pair">
            <span>
              owner <code>{row.original.ownerId}</code>
            </span>
            <span>
              scope <code>{row.original.scopeRef}</code>
            </span>
          </div>
        ),
      },
      {
        id: "order",
        header: "Order",
        accessorFn: (r) => r.priority,
        cell: ({ row }) => (
          <div className="model-pair">
            <span>priority {row.original.priority}</span>
            <span>
              weight {row.original.weight} / fallback{" "}
              {row.original.fallbackOrder}
            </span>
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorKey: "status",
        cell: ({ row }) => (
          <StatusBadge
            tone={row.original.status === "enabled" ? "good" : "neutral"}
          >
            {row.original.status}
          </StatusBadge>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="row-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditing(row.original)}
            >
              Edit
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => setDeleting(row.original)}
            >
              {remove.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        ),
      },
    ],
    [remove.isPending],
  );
  return (
    <>
      {remove.error ? (
        <div className="notice-box notice-bad">
          {remove.error instanceof Error
            ? remove.error.message
            : "Delete failed"}
        </div>
      ) : null}
      <DataTable
        data={rows}
        columns={columns}
        getRowId={accessPointRowId}
        table={{ minWidth: 1320 }}
        emptyState={{ title: "No access points match the current filters." }}
        serverManaged
        state={{ rowSelection: selection }}
        onStateChange={{ rowSelection: setSelection }}
        selection={{
          selectedLabel: "AccessPoints",
          bulkAction: { onClick: () => setBulkOpen(true) },
        }}
      />
      {editing ? (
        <AccessPointDialog
          data={data}
          row={editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
      {bulkOpen ? (
        <BulkAccessPointsDialog
          rows={selected}
          onClose={() => setBulkOpen(false)}
          onSaved={() => {
            setBulkOpen(false);
            setSelection({});
          }}
        />
      ) : null}
      {deleting ? (
        <ConsoleDialog
          observabilityKey="access-point-delete"
          titleId="delete-access-point-title"
          eyebrow="Danger zone"
          title={`Delete ${deleting.name}`}
          description="This permanently removes the AccessPoint configuration and cannot be undone."
          closeDisabled={remove.isPending}
          onClose={() => setDeleting(undefined)}
        >
          <Notice tone="bad">
            Calls to exposed model <code>{deleting.exposedModel}</code> through this AccessPoint will stop resolving.
          </Notice>
          <ConsoleDialogFooter feedback={remove.error ? <Notice tone="bad" live="alert">{remove.error instanceof Error ? remove.error.message : "Delete failed"}</Notice> : null}>
            <Button type="button" variant="secondary" disabled={remove.isPending} onClick={() => setDeleting(undefined)}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(deleting.id)}>{remove.isPending ? "Deleting..." : "Delete AccessPoint"}</Button>
          </ConsoleDialogFooter>
        </ConsoleDialog>
      ) : null}
    </>
  );
}
function targetLabel(row: AccessPointSummary) {
  return row.targetType === "provider-model"
    ? `${row.targetProviderId ?? "unknown"} / ${row.targetProviderModelName ?? "unknown"}`
    : (row.targetId ?? "unknown");
}
