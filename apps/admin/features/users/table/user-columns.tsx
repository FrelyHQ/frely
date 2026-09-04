import Link from "@admin/navigation";
import type { ColumnDef } from "@frely/console-ui/data-table";
import type { OwnerUserOverviewRow } from "../../../lib/teams";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { compareUserDateRows, compareUserNumberRows, compareUserTextRows } from "./user-table-state";

export const userColumns: Array<ColumnDef<OwnerUserOverviewRow, unknown>> = [
  {
    id: "user",
    header: "User",
    accessorFn: (user) => `${user.name} ${user.email} ${user.id}`,
    sortingFn: compareUserTextRows,
    cell: ({ row }) => <Link className="cell-link identity-cell identity-link" href={`/owner/users/${row.original.id}`} aria-label={`Open ${row.original.name} details`}>
      <span className="team-avatar">{row.original.name.slice(0, 2).toUpperCase()}</span>
      <div><strong>{row.original.name}</strong><code>{row.original.email}</code></div>
    </Link>
  },
  {
    id: "team",
    header: "Team",
    accessorFn: (user) => `${user.teamName} ${user.teamId}`,
    sortingFn: compareUserTextRows,
    cell: ({ row }) => <Link className="cell-link cell-link-stack" href={`/owner/teams/${row.original.teamId}`} aria-label={`Open ${row.original.teamName} details`}>
      <strong>{row.original.teamName}</strong><code>{row.original.teamId}</code>
    </Link>
  },
  { id: "role", header: "Role", accessorKey: "role", sortingFn: compareUserTextRows },
  { id: "roleDetails", header: "Role Bindings", accessorKey: "roleDetails", sortingFn: compareUserTextRows, cell: ({ row }) => <span className="muted">{row.original.roleDetails}</span> },
  { id: "status", header: "Status", accessorKey: "status", sortingFn: compareUserTextRows, cell: ({ row }) => <StatusBadge tone={row.original.statusTone}>{row.original.status}</StatusBadge> },
  { id: "adminNote", header: "Admin Note", accessorFn: (user) => user.adminNote ?? "", sortingFn: compareUserTextRows, cell: ({ row }) => row.original.adminNote ? <span className="muted">{row.original.adminNote.slice(0, 80)}</span> : <span className="muted">None</span> },
  { id: "apiKeys", header: "API Keys", accessorFn: (user) => Number(user.apiKeys), sortingFn: compareUserNumberRows, cell: ({ row }) => row.original.apiKeys },
  { id: "lastSeen", header: "Last Seen", accessorKey: "lastSeen", sortingFn: compareUserDateRows, sortDescFirst: true, cell: ({ row }) => row.original.lastSeenAt ? <BrowserTime value={row.original.lastSeenAt} /> : "Never" },
  { id: "createdAt", header: "Created At", accessorKey: "createdAt", sortingFn: compareUserDateRows, sortDescFirst: true, cell: ({ row }) => <BrowserTime value={row.original.createdAtIso} dateOnly /> }
];
