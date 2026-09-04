"use client";

import { StatusBadge } from "@frely/console-ui";
import { AccessPointDescription } from "@frely/console-ui/access-point-description";
import { DataTable, type ColumnDef } from "@frely/console-ui/data-table";
import { BrowserTime, BrowserTimeRange } from "@frely/ui/components/browser-time";
import type { ReactNode } from "react";
import { useMemo } from "react";
import type { TeamAccessPointRow, TeamPlanRow, TeamPlanStatusFilter, TeamUserRow } from "./index.js";

interface TeamMemberTableRow {
  actions?: ReactNode;
  apiKeyLimitAction?: ReactNode;
  href?: string;
  user: TeamUserRow;
}

interface TeamMembersTableProps {
  rows: TeamMemberTableRow[];
  showActions: boolean;
}

export function TeamMembersTable({ rows, showActions }: TeamMembersTableProps) {
  const columns = useMemo<Array<ColumnDef<TeamMemberTableRow, unknown>>>(() => [
    {
      id: "user",
      header: "User",
      accessorFn: (row) => `${row.user.name} ${row.user.email} ${row.user.id}`,
      sortingFn: compareText,
      cell: ({ row }) => row.original.href ? (
        <a className="identity-cell identity-link" href={row.original.href}>
          <UserIdentity user={row.original.user} />
        </a>
      ) : (
        <div className="identity-cell"><UserIdentity user={row.original.user} /></div>
      )
    },
    { id: "role", header: "Role", accessorFn: (row) => row.user.role, sortingFn: compareText, cell: ({ row }) => row.original.user.role },
    { id: "status", header: "Status", accessorFn: (row) => row.user.status, sortingFn: compareText, cell: ({ row }) => <StatusBadge tone={row.original.user.status === "Active" ? "good" : "warn"}>{row.original.user.status}</StatusBadge> },
    { id: "apiKeys", header: "API Keys", accessorFn: (row) => numericValue(row.user.apiKeys), sortingFn: compareNumber, cell: ({ row }) => <span data-clarity-mask="true">{row.original.user.apiKeys}</span> },
    { id: "apiKeyLimit", header: "Key Limit", accessorFn: (row) => row.user.apiKeyLimit, sortingFn: compareNumber, cell: ({ row }) => row.original.apiKeyLimitAction ?? <strong data-clarity-mask="true">{row.original.user.apiKeyLimit}</strong> },
    { id: "lastSeen", header: "Last Seen", accessorFn: (row) => row.user.lastSeenAt ?? "", sortingFn: compareText, sortDescFirst: true, cell: ({ row }) => <span data-clarity-mask="true">{row.original.user.lastSeenAt ? <BrowserTime value={row.original.user.lastSeenAt} /> : row.original.user.lastSeen}</span> },
    { id: "createdAt", header: "Created At", accessorFn: (row) => row.user.createdAtIso, sortingFn: compareText, sortDescFirst: true, cell: ({ row }) => <span data-clarity-mask="true"><BrowserTime value={row.original.user.createdAtIso} dateOnly /></span> },
    ...(showActions ? [{ id: "actions", header: "Actions", enableSorting: false, cell: ({ row }: { row: { original: TeamMemberTableRow } }) => <div className="row-actions">{row.original.actions}</div> }] : [])
  ], [showActions]);

  return <DataTable serverManaged serverManagedSorting={false} data={rows} columns={columns} getRowId={(row) => row.user.id} initialState={{ sorting: [{ id: "user", desc: false }] }} table={{ minWidth: 820, stickyHeader: true }} emptyState={{ title: "No users in this team." }} />;
}

export function TeamPlansTable({ rows, planStatusFilter = "enabled" }: { rows: TeamPlanRow[]; planStatusFilter?: TeamPlanStatusFilter }) {
  const columns = useMemo<Array<ColumnDef<TeamPlanRow, unknown>>>(() => [
    { id: "plan", header: "Plan", accessorFn: (row) => `${row.templateName} ${row.planTemplateId}`, sortingFn: compareText, cell: ({ row }) => <><strong data-clarity-mask="true">{row.original.templateName}</strong><code data-clarity-mask="true">{row.original.planTemplateId}</code></> },
    { id: "terms", header: "Terms", accessorFn: (row) => `${row.billingMode} ${row.price} ${row.duration}`, sortingFn: compareText, cell: ({ row }) => <div className="model-pair" data-clarity-mask="true"><strong>{row.original.billingMode}</strong><span>{row.original.price} · {row.original.duration}</span></div> },
    { id: "entitlements", header: "Access & Budget", accessorFn: (row) => `${row.includedAccessPoints} ${row.budgetSummary}`, sortingFn: compareText, cell: ({ row }) => <div className="model-pair" data-clarity-mask="true"><span>{row.original.includedAccessPoints}</span><span>{row.original.budgetSummary}</span></div> },
    { id: "effective", header: "Effective", accessorFn: (row) => row.priority, sortingFn: comparePlanOrder, cell: ({ row }) => <div className="model-pair" data-clarity-mask="true"><BrowserTimeRange start={row.original.effectiveStart} end={row.original.effectiveEnd} /><span>priority {row.original.priority}</span></div> },
    { id: "state", header: "State", accessorFn: (row) => `${row.planStatus} ${row.status}`, sortingFn: compareText, cell: ({ row }) => <div className="model-pair"><StatusBadge tone={planStatusTone(row.original.planStatus)}>Plan {row.original.planStatus}</StatusBadge><span>Subscription {row.original.status}</span></div> }
  ], []);

  const filteredLabel = planStatusFilter === "all" ? "" : `${planStatusFilter} `;
  return <DataTable serverManaged serverManagedSorting={false} data={rows} columns={columns} getRowId={(row) => row.id} initialState={{ sorting: [{ id: "effective", desc: false }] }} table={{ minWidth: "content", stickyHeader: true }} emptyState={{ title: `No ${filteredLabel}Team Plan subscriptions.`, description: planStatusFilter === "enabled" ? "Choose another Plan status to view closed or disabled subscriptions." : "No subscriptions match the selected Plan status." }} />;
}

export function TeamAccessPointsTable({ rows }: { rows: TeamAccessPointRow[] }) {
  const columns = useMemo<Array<ColumnDef<TeamAccessPointRow, unknown>>>(() => [
    { id: "accessPoint", header: "AccessPoint", accessorFn: (row) => `${row.name} ${row.id}`, sortingFn: compareText, cell: ({ row }) => <><strong data-clarity-mask="true">{row.original.name}</strong><AccessPointDescription description={row.original.description} /><code data-clarity-mask="true">{row.original.id}</code></> },
    { id: "exposedModel", header: "Exposed Model", accessorFn: (row) => `${row.exposedModel} ${row.apiFamily}`, sortingFn: compareText, cell: ({ row }) => <div className="model-pair"><code>{row.original.exposedModel}</code><span>{row.original.apiFamily}</span></div> },
    { id: "target", header: "Target", accessorFn: (row) => `${row.targetType} ${row.targetLabel} ${row.targetModel}`, sortingFn: compareText, cell: ({ row }) => <div className="model-pair"><strong>{row.original.targetType}</strong><code>{row.original.targetLabel}</code><span>{row.original.targetModel}</span></div> },
    { id: "order", header: "Order", accessorFn: (row) => row.priority, sortingFn: compareAccessPointOrder, cell: ({ row }) => <div className="model-pair"><span>priority {row.original.priority}</span><span>fallback {row.original.fallbackOrder}</span></div> },
    { id: "price", header: "Price", accessorKey: "price", sortingFn: compareText, cell: ({ row }) => <span data-clarity-mask="true">{row.original.price}</span> },
    { id: "status", header: "Status", accessorKey: "status", sortingFn: compareText, cell: ({ row }) => <StatusBadge tone={row.original.status === "enabled" ? "good" : "neutral"}>{row.original.status}</StatusBadge> }
  ], []);

  return <DataTable serverManaged serverManagedSorting={false} data={rows} columns={columns} getRowId={(row) => row.id} initialState={{ sorting: [{ id: "order", desc: false }] }} table={{ minWidth: 980, stickyHeader: true }} emptyState={{ title: "No team-scoped AccessPoints." }} />;
}

function UserIdentity({ user }: { user: TeamUserRow }) {
  return <><span className="team-avatar" data-clarity-mask="true">{user.name.slice(0, 2).toUpperCase()}</span><div data-clarity-mask="true"><strong>{user.name}</strong><code>{user.email}</code></div></>;
}

function compareText(left: { getValue: (columnId: string) => unknown }, right: { getValue: (columnId: string) => unknown }, columnId: string) {
  return DETAIL_TABLE_COLLATOR.compare(String(left.getValue(columnId) ?? ""), String(right.getValue(columnId) ?? ""));
}

function compareNumber(left: { getValue: (columnId: string) => unknown }, right: { getValue: (columnId: string) => unknown }, columnId: string) {
  return Number(left.getValue(columnId)) - Number(right.getValue(columnId));
}

function comparePlanOrder(left: { original: TeamPlanRow }, right: { original: TeamPlanRow }) {
  return left.original.priority - right.original.priority
    || DETAIL_TABLE_COLLATOR.compare(left.original.effectiveStart, right.original.effectiveStart)
    || DETAIL_TABLE_COLLATOR.compare(left.original.id, right.original.id);
}

function planStatusTone(status: TeamPlanRow["planStatus"]) {
  if (status === "enabled") return "good";
  if (status === "closed") return "warn";
  return "neutral";
}

function compareAccessPointOrder(left: { original: TeamAccessPointRow }, right: { original: TeamAccessPointRow }) {
  return left.original.priority - right.original.priority
    || left.original.fallbackOrder - right.original.fallbackOrder
    || DETAIL_TABLE_COLLATOR.compare(left.original.id, right.original.id);
}

function numericValue(value: string) {
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

const DETAIL_TABLE_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
