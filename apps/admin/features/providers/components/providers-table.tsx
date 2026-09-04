"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "@admin/navigation";
import { DataTable, type ColumnDef, type RowSelectionState } from "@frely/console-ui/data-table";
import { Button } from "@frely/ui/components/button";
import { Checkbox } from "@frely/ui/components/checkbox";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { SearchSelect, type SearchSelectOption } from "../../../pages/owner/_components/search-select";
import { AdminDialog, ConsoleDialogFooter, StatusBadge } from "../../../pages/owner/_components/ui";
import { reconcileVisibleProviderBindings, updateProvider } from "../api/provider-api";
import { DeleteProviderButton } from "./delete-provider-button";
import { EditProviderDialog } from "./edit-provider-dialog";
import type { ProviderRecord } from "../types";

export interface ProviderTableRow {
  id: string;
  scopeRef: string;
  name: string;
  kind: string;
  status: string;
  configJson: string;
  binding: ProviderRecord["binding"];
  modelCount: number;
  modelNames: string[];
  models?: NonNullable<ProviderRecord["models"]>;
  deletionState: {
    hasAccessPointReferences: boolean;
    hasOnlineBillingHistory: boolean;
    credentialCleared: boolean;
    retained: boolean;
  };
}

export function ProvidersTable({ rows, showRetained, hiddenRetainedCount }: { rows: ProviderTableRow[]; showRetained: boolean; hiddenRetainedCount: number }) {
  const router = useRouter();
  const refreshAttempt = useRef("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bindingRefreshNotice, setBindingRefreshNotice] = useState("");
  const bindingRefresh = useMutation({
    mutationFn: reconcileVisibleProviderBindings,
    retry: false,
    onMutate: () => setBindingRefreshNotice(""),
    onSuccess: (result) => {
      const issues = result.items.filter((item) => !["ready", "skipped"].includes(item.result));
      if (issues.length > 0) setBindingRefreshNotice(`${issues.length} Provider binding${issues.length === 1 ? " needs" : "s need"} attention after refresh.`);
      router.refresh();
    },
  });
  const selectedRows = useMemo(() => rows.filter((row) => rowSelection[row.id]), [rowSelection, rows]);
  useEffect(() => {
    const visible = new Set(rows.map((row) => row.id));
    setRowSelection((current) => Object.fromEntries(Object.entries(current).filter(([id]) => visible.has(id))));
  }, [rows]);
  useEffect(() => {
    const staleBefore = Date.now() - 60_000;
    const items = rows.flatMap((row) => row.binding?.credentialPreview && Date.parse(row.binding.updatedAt) <= staleBefore
      ? [{ providerId: row.id, expectedRevision: row.binding.revision }]
      : []);
    const signature = items.map((item) => `${item.providerId}:${item.expectedRevision}`).join("|");
    if (!signature || refreshAttempt.current === signature) return;
    refreshAttempt.current = signature;
    bindingRefresh.mutate(items);
  }, [bindingRefresh.mutate, rows]);
  const columns = useMemo<Array<ColumnDef<ProviderTableRow, unknown>>>(() => [
    {
      id: "provider",
      header: "Provider",
      enableSorting: false,
      cell: ({ row }) => (
        <>
          <strong>{row.original.name}</strong>
          <code>{row.original.id}</code>
        </>
      )
    },
    { id: "scopeRef", header: "Scope", enableSorting: false, cell: ({ row }) => <code>{row.original.scopeRef}</code> },
    { id: "connection", header: "Connection", enableSorting: false, cell: () => "CLIProxyAPI" },
    { id: "kind", header: "Kind", enableSorting: false, cell: ({ row }) => row.original.kind },
    {
      id: "resolvers",
      header: "Resolvers",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="model-pair"><span>auth {row.original.binding?.authMethod ?? "not initialized"}</span><span>binding {row.original.binding?.syncStatus ?? "not initialized"}</span></div>
      )
    },
    {
      id: "models",
      header: "Registered Models",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="model-pair">
          <strong>{row.original.modelCount} models</strong>
          <span>{row.original.modelNames.join(", ") || "No provider models"}</span>
        </div>
      )
    },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="model-pair">
          <StatusBadge tone={row.original.status === "enabled" ? "good" : "neutral"}>{row.original.status}</StatusBadge>
          {row.original.deletionState.retained ? <StatusBadge tone="warn">Retained history</StatusBadge> : null}
        </div>
      )
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="row-actions">
          <EditProviderDialog provider={row.original} />
          <DeleteProviderButton provider={row.original} deletionState={row.original.deletionState} />
        </div>
      )
    }
  ], []);

  return (
    <>
      <RetainedProvidersToggle checked={showRetained} retainedCount={hiddenRetainedCount} />
      {bindingRefresh.error ? <div className="notice-box notice-bad" role="alert">Provider status refresh failed. Use Retry Binding for an individual Provider.</div> : null}
      {bindingRefreshNotice ? <div className="notice-box notice-warn" role="status">{bindingRefreshNotice}</div> : null}
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        table={{ minWidth: 1280 }}
        emptyState={{ title: "No providers configured." }}
        state={{ rowSelection }}
        onStateChange={{ rowSelection: setRowSelection }}
        selection={{
          selectedLabel: "providers",
          bulkAction: { onClick: () => setBulkOpen(true) },
        }}
      />
      {bulkOpen ? (
        <BulkProvidersDialog
          providers={selectedRows}
          onClose={() => setBulkOpen(false)}
          onSaved={() => {
            setBulkOpen(false);
            setRowSelection({});
          }}
        />
      ) : null}
    </>
  );
}

function RetainedProvidersToggle({ checked, retainedCount }: { checked: boolean; retainedCount: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (
    <label className="check-row provider-retained-toggle">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => {
          const next = new URLSearchParams(searchParams.toString());
          if (value === true) next.set("showRetained", "1");
          else next.delete("showRetained");
          const query = next.toString();
          router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
        }}
      />
      Show retained Providers
      <span>{retainedCount} retained by online billing history</span>
    </label>
  );
}

function BulkProvidersDialog({ providers, onClose, onSaved }: { providers: ProviderTableRow[]; onClose: () => void; onSaved: () => void }) {
  const router = useRouter();
  const scopeOptions = useMemo(() => buildProviderScopeOptions(providers), [providers]);
  const mutation = useMutation({
    mutationFn: async (scopeRef: string) => {
      await Promise.all(providers.map(async (provider) => {
        await updateProvider({
          id: provider.id,
          scopeRef,
          name: provider.name,
          kind: provider.kind,
          ...(provider.binding?.authMethod ? { authMethod: provider.binding.authMethod } : {}),
          status: provider.status,
          config: JSON.parse(provider.configJson || "{}") as Record<string, unknown>,
        });
      }));
    },
    onSuccess: () => {
      onSaved();
      router.refresh();
    }
  });
  const form = useForm({
    defaultValues: { scopeRef: providers[0]?.scopeRef ?? "" },
    onSubmit: async ({ value }) => mutation.mutateAsync(value.scopeRef.trim())
  });
  const selectedCount = providers.length;

  return (
    <AdminDialog
      observabilityKey="provider-bulk-edit"
      titleId="bulk-providers-dialog-title"
      eyebrow="Upstream Providers"
      title="Bulk edit"
      description={`${providers.length} selected providers`}
      onClose={onClose}
      closeDisabled={mutation.isPending}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="form-grid single">
          <form.Field name="scopeRef" validators={{ onSubmit: ({ value }) => value.trim() ? undefined : "Scope is required." }}>
            {(field) => <label>
              Scope
              <SearchSelect value={field.state.value} options={scopeOptions} onValueChange={field.handleChange} placeholder={providers[0]?.scopeRef ?? "Select scope"} allowCustomValue />
              <span>Moves selected Providers to this scope. Existing credentials stay stored server-side.</span>
              {field.state.meta.errors.map((error) => <span className="field-error" key={String(error)}>{String(error)}</span>)}
            </label>}
          </form.Field>
        </div>
        <div className="embedded-section bulk-selection-summary">
          <strong>Selected Providers</strong>
          <div className="bulk-selection-list">
            {providers.map((provider) => (
              <div key={provider.id}>
                <span>{provider.name}</span>
                <form.Subscribe selector={(state) => state.values.scopeRef}>
                  {(scopeRef) => <code>{provider.scopeRef}{" -> "}{scopeRef}</code>}
                </form.Subscribe>
              </div>
            ))}
          </div>
        </div>
        <ConsoleDialogFooter feedback={mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Bulk provider update failed"}</div> : null}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => <Button type="submit" disabled={!canSubmit || isSubmitting || mutation.isPending || selectedCount === 0}>{isSubmitting || mutation.isPending ? "Saving..." : "Save Changes"}</Button>}
          </form.Subscribe>
        </ConsoleDialogFooter>
      </form>
    </AdminDialog>
  );
}

function buildProviderScopeOptions(providers: ProviderTableRow[]): SearchSelectOption[] {
  const options: SearchSelectOption[] = [];
  const seen = new Set(options.map((option) => option.value));
  for (const provider of providers) {
    if (seen.has(provider.scopeRef)) continue;
    seen.add(provider.scopeRef);
    options.push({
      value: provider.scopeRef,
      label: provider.scopeRef,
      description: "Currently selected Provider scope",
      searchText: provider.scopeRef
    });
  }
  return options;
}
