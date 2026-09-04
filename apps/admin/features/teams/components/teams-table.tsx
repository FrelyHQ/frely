"use client";

import Link from "@admin/navigation";
import { useMemo, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@admin/navigation";
import { DataTable, type ColumnDef, type RowSelectionState, type SortingState } from "@frely/console-ui/data-table";
import { Button } from "@frely/ui/components/button";
import { Checkbox } from "@frely/ui/components/checkbox";
import { Input } from "@frely/ui/components/input";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { adminTeamsHref, type AdminTeamDirectoryRow, type AdminTeamsSearchState } from "../lib/team-directory-state";
import { AdminDialog, ConsoleDialogFooter, StatusBadge } from "../../../pages/owner/_components/ui";
import { FormFieldFrame, FormSubmitError } from "../../_shared/form-fields";
import { updateTeam, updateTeams } from "../api/team-api";
import { DeleteTeamControl } from "./delete-team-control";
import { createBulkTeamFormValues, createTeamSettingsFormValues, requiredTeamName, toTeamUpdateInput } from "../form/team-form-values";
import { ownerPermissionSummary } from "../table/team-table-state";

export function TeamsTable({ rows, search }: { rows: AdminTeamDirectoryRow[]; search: AdminTeamsSearchState }) {
  const router = useRouter();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<AdminTeamDirectoryRow | null>(null);
  const selectedRows = rows.filter((row) => rowSelection[row.id]);
  const columns = useMemo<Array<ColumnDef<AdminTeamDirectoryRow, unknown>>>(() => [
    { id: "name", header: "Name", accessorFn: (team) => `${team.name} ${team.id}`, cell: ({ row }) => <TeamLink team={row.original}><span className="team-avatar">{row.original.initials}</span><div><strong>{row.original.name}</strong><code>{row.original.id}</code></div></TeamLink> },
    { id: "status", header: "Status", accessorKey: "status", cell: ({ row }) => <TeamLink team={row.original}><StatusBadge tone={row.original.statusTone}>{row.original.status}</StatusBadge></TeamLink> },
    { id: "members", header: "Members", accessorFn: (team) => Number(team.members), cell: ({ row }) => <TeamLink team={row.original}>{row.original.members}</TeamLink> },
    { id: "access", header: "Mapping Coverage", accessorKey: "accessCoverage", cell: ({ row }) => <TeamLink team={row.original} stack><strong>{row.original.accessCoverage}</strong><div className="muted">Derived from AccessPoints</div></TeamLink> },
    { id: "ownerPermissions", header: "Owner Permissions", accessorFn: ownerPermissionSummary, cell: ({ row }) => <TeamLink team={row.original} stack><strong>{row.original.canManageMemberApiKeyLimit ? "Member key limit" : "Read-only limits"}</strong><div className="muted">{ownerPermissionSummary(row.original)}</div></TeamLink> },
    { id: "createdAt", header: "Created At", accessorKey: "createdAt", cell: ({ row }) => <TeamLink team={row.original}><BrowserTime value={row.original.createdAtIso} dateOnly /></TeamLink> },
    { id: "actions", header: "Actions", enableSorting: false, cell: ({ row }) => <div className="row-actions"><Button type="button" variant="outline" size="sm" aria-label={`Edit ${row.original.name}`} onClick={() => setEditingTeam(row.original)}>Edit</Button></div> }
  ], []);
  const sorting: SortingState = [{ id: search.sort, desc: search.direction === "desc" }];
  const onSortingChange = (updater: SortingState | ((current: SortingState) => SortingState)) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    const primary = next[0];
    const sort = primary?.id ?? "createdAt";
    if (!["name", "status", "members", "access", "ownerPermissions", "createdAt"].includes(sort)) return;
    setRowSelection({});
    router.push(adminTeamsHref(search, { page: 1, sort: sort as AdminTeamsSearchState["sort"], direction: primary?.desc ? "desc" : "asc" }));
  };

  return <>
    <DataTable data={rows} columns={columns} getRowId={(row) => row.id} serverManaged emptyState={{ title: "No teams match this search." }} getRowProps={() => ({ clickable: true })} state={{ rowSelection, sorting }} onStateChange={{ rowSelection: setRowSelection, sorting: onSortingChange }} selection={{ selectedLabel: "teams", strategy: "current-page", bulkAction: { onClick: () => setBulkOpen(true) } }} />
    {bulkOpen ? <BulkTeamsDialog teams={selectedRows} onClose={() => setBulkOpen(false)} onSaved={() => { setBulkOpen(false); setRowSelection({}); }} /> : null}
    {editingTeam ? <TeamEditDialog team={editingTeam} onClose={() => setEditingTeam(null)} onSaved={() => { setEditingTeam(null); router.refresh(); }} onDeleted={() => { setEditingTeam(null); setRowSelection((current) => { const next = { ...current }; delete next[editingTeam.id]; return next; }); router.refresh(); }} /> : null}
  </>;
}

function TeamLink({ team, stack = false, children }: { team: AdminTeamDirectoryRow; stack?: boolean; children: React.ReactNode }) {
  return <Link className={`cell-link${stack ? " cell-link-stack" : ""}${team.id ? "" : ""}`} href={`/owner/teams/${team.id}`} aria-label={`Open ${team.name} details`}>{children}</Link>;
}

function TeamEditDialog({ team, onClose, onSaved, onDeleted }: { team: AdminTeamDirectoryRow; onClose: () => void; onSaved: () => void; onDeleted: () => void }) {
  const saveMutation = useMutation({ mutationFn: (input: object) => updateTeam(team.id, input, `Update ${team.name} failed`), retry: false, onSuccess: onSaved });
  const form = useForm({ defaultValues: createTeamSettingsFormValues(team), onSubmit: ({ value }) => saveMutation.mutateAsync(toTeamUpdateInput(value)) });
  const busy = saveMutation.isPending;
  return <AdminDialog observabilityKey="team-edit" titleId={`edit-team-${team.id}`} eyebrow="Team" title="Edit Team" description={`${team.name} (${team.id})`} onClose={onClose} closeDisabled={busy}>
    <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
      <div className="form-grid single">
        <form.Field name="name" validators={{ onBlur: ({ value }) => requiredTeamName(value), onSubmit: ({ value }) => requiredTeamName(value) }}>{(field) => <FormFieldFrame label="Team name" errors={field.state.meta.errors}><Input value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={busy} /></FormFieldFrame>}</form.Field>
        <TeamBooleanFields form={form} disabled={busy} />
      </div>
      <DeleteTeamControl team={team} blockers={team.deleteBlockers} deletionLifecycle={team.deletionLifecycle} onDeleted={onDeleted} />
      <ConsoleDialogFooter feedback={saveMutation.error?.message ? <FormSubmitError message={saveMutation.error.message} /> : null}><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}>{saveMutation.isPending ? "Saving..." : "Save Changes"}</Button></ConsoleDialogFooter>
    </form>
  </AdminDialog>;
}

function BulkTeamsDialog({ teams, onClose, onSaved }: { teams: AdminTeamDirectoryRow[]; onClose: () => void; onSaved: () => void }) {
  const router = useRouter();
  const mutation = useMutation({ mutationFn: (input: object) => updateTeams(teams.map((team) => team.id), input), retry: false, onSuccess: () => { onSaved(); router.refresh(); } });
  const form = useForm({ defaultValues: createBulkTeamFormValues(), onSubmit: ({ value }) => mutation.mutateAsync(value) });
  return <AdminDialog observabilityKey="team-bulk-edit" titleId="bulk-teams-dialog-title" eyebrow="Teams" title="Bulk edit" description={`${teams.length} selected teams`} onClose={onClose} closeDisabled={mutation.isPending}>
    <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}><div className="form-grid single"><TeamBooleanFields form={form} disabled={mutation.isPending} /></div><BulkSummary rows={teams.map((team) => ({ id: team.id, label: team.name, detail: "Owner capability configuration" }))} /><ConsoleDialogFooter feedback={mutation.error?.message ? <FormSubmitError message={mutation.error.message} /> : null}><Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button type="submit" disabled={mutation.isPending || teams.length === 0}>{mutation.isPending ? "Saving..." : "Save Changes"}</Button></ConsoleDialogFooter></form>
  </AdminDialog>;
}

function TeamBooleanFields({ form, disabled }: { form: any; disabled: boolean }) {
  const fields = [
    ["teamOwnerCanManageMemberApiKeyLimit", "Team Owner can edit member API key limits", "Controls whether Team Owners can change userApiKeyLimit for members in this team."],
    ["teamOwnerCanManageMemberCredit", "Team Owner can manage member credit", "Allows Team Owners to view member balances and change member transfer-out policy."],
    ["teamOwnerCanCreateAccessPoint", "Team Owner can create AccessPoints", "Allows Team Owners to create team-scoped AccessPoints."]
  ] as const;
  return <>{fields.map(([name, label, description]) => <form.Field key={name} name={name}>{(field: any) => <label className="check-row"><Checkbox checked={field.state.value} disabled={disabled} onCheckedChange={(checked) => field.handleChange(checked === true)} />{label}<span>{description}</span></label>}</form.Field>)}</>;
}

function BulkSummary({ rows }: { rows: Array<{ id: string; label: string; detail: string }> }) { return <div className="embedded-section bulk-selection-summary"><strong>Selected Rows</strong><div className="bulk-selection-list">{rows.map((row) => <div key={row.id}><span>{row.label}</span><code>{row.detail}</code></div>)}</div></div>; }
