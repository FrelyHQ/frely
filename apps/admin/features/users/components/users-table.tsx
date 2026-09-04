"use client";

import { useMemo, useState } from "react";
import { useRouter } from "@admin/navigation";
import { DataTable, type RowSelectionState } from "@frely/console-ui/data-table";
import { Button } from "@frely/ui/components/button";
import { Textarea } from "@frely/ui/components/textarea";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import type { OwnerUserOverviewRow } from "../../../lib/teams";
import { AdminDialog, ConsoleDialogFooter } from "../../../pages/owner/_components/ui";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { updateUsersAdminNote } from "../api/user-api";
import { bulkUserFormDefaults, toBulkUserAdminNoteInputs, validateBulkUserAdminNote } from "../form/bulk-user-form-values";
import { userColumns } from "../table/user-columns";

export function UsersTable({ rows }: { rows: OwnerUserOverviewRow[] }) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const selectedRows = useMemo(() => rows.filter((row) => rowSelection[row.id]), [rowSelection, rows]);

  return <>
    <DataTable
      data={rows}
      columns={userColumns}
      getRowId={(row) => row.id}
      serverManaged
      emptyState={{ title: "No users match this search." }}
      getRowProps={() => ({ clickable: true })}
      state={{ rowSelection }}
      onStateChange={{ rowSelection: setRowSelection }}
      selection={{
        selectedLabel: "users",
        bulkAction: { onClick: () => setBulkOpen(true) }
      }}
    />
    {bulkOpen ? <BulkUsersDialog users={selectedRows} onClose={() => setBulkOpen(false)} onSaved={() => {
      setBulkOpen(false);
      setRowSelection({});
    }} /> : null}
  </>;
}

function BulkUsersDialog({ users, onClose, onSaved }: { users: OwnerUserOverviewRow[]; onClose: () => void; onSaved: () => void }) {
  const router = useRouter();
  const mutation = useMutation({
    mutationFn: updateUsersAdminNote,
    retry: false,
    onSuccess: () => {
      onSaved();
      router.refresh();
    }
  });
  const form = useForm({
    defaultValues: bulkUserFormDefaults,
    onSubmit: async ({ value }) => mutation.mutateAsync(toBulkUserAdminNoteInputs(users, value))
  });

  return <AdminDialog
    observabilityKey="user-bulk-edit"
    titleId="bulk-users-dialog-title"
    eyebrow="Users"
    title="Bulk edit"
    description={`${users.length} selected users`}
    onClose={onClose}
    closeDisabled={mutation.isPending}
  >
    <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      <div className="form-grid single">
        <form.Field name="operation">
          {(field) => <label>
            Operation
            <SearchSelect value={field.state.value} onBlur={field.handleBlur} onValueChange={(nextValue) => field.handleChange(nextValue as "set-note" | "clear-note")} searchable={false} options={[{ value: "set-note", label: "Set admin note" }, { value: "clear-note", label: "Clear admin note" }]} />
            <span>User bulk updates are limited to the existing admin note mutation.</span>
          </label>}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.operation}>
          {(operation) => operation === "set-note" ? <form.Field name="adminNote" validators={{ onSubmit: ({ value, fieldApi }) => validateBulkUserAdminNote({ operation: fieldApi.form.state.values.operation, adminNote: value }) }}>
            {(field) => <label>
              Admin Note
              <Textarea rows={4} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} />
              <span>The same note will be applied to every selected user.</span>
              {field.state.meta.errors.map((error) => <span className="field-error" key={String(error)}>{String(error)}</span>)}
            </label>}
          </form.Field> : null}
        </form.Subscribe>
      </div>
      <form.Subscribe selector={(state) => state.values.operation}>
        {(operation) => <BulkSummary rows={users.map((user) => ({ id: user.id, label: user.email, detail: operation === "clear-note" ? "Clear admin note" : "Set admin note" }))} />}
      </form.Subscribe>
      {users.length === 0 ? <div className="notice-box notice-bad">Select at least one user.</div> : null}
      <ConsoleDialogFooter feedback={mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Bulk user update failed"}</div> : null}>
        <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => <Button type="submit" disabled={!canSubmit || isSubmitting || mutation.isPending || users.length === 0}>{isSubmitting || mutation.isPending ? "Saving..." : "Save Changes"}</Button>}
        </form.Subscribe>
      </ConsoleDialogFooter>
    </form>
  </AdminDialog>;
}

function BulkSummary({ rows }: { rows: Array<{ id: string; label: string; detail: string }> }) {
  return <div className="embedded-section bulk-selection-summary">
    <strong>Selected Rows</strong>
    <div className="bulk-selection-list">{rows.map((row) => <div key={row.id}><span>{row.label}</span><code>{row.detail}</code></div>)}</div>
  </div>;
}
