import Link from "@admin/navigation";
import type { ColumnDef } from "@frely/console-ui/data-table";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import type { AdminCreditUserRow, CreditScopeSummary } from "../types";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { creditScopeColumnIds, creditUserColumnIds } from "./credit-table-state";

export const creditUserColumns: Array<ColumnDef<AdminCreditUserRow, unknown>> = [
  { id: creditUserColumnIds[0], header: "User", accessorFn: (row) => row.userName, cell: ({ row }) => <Link className="cell-link identity-cell identity-link" href={`/owner/users/${row.original.userId}`} aria-label={`Open ${row.original.userName} details`}><span className="team-avatar">{row.original.userName.slice(0, 2).toUpperCase()}</span><div><strong>{row.original.userName}</strong><code>{row.original.userEmail}</code></div></Link> },
  { id: creditUserColumnIds[1], header: "Team", accessorFn: (row) => row.teamName, cell: ({ row }) => <Link className="cell-link cell-link-stack" href={`/owner/teams/${row.original.teamId}`} aria-label={`Open ${row.original.teamName} details`}><strong>{row.original.teamName}</strong><code>{row.original.teamId}</code></Link> },
  { id: creditUserColumnIds[2], header: "Balance", accessorKey: "balanceValue", cell: ({ row }) => <strong>{row.original.balance}</strong> },
  { id: creditUserColumnIds[3], header: "Transfer Out", accessorFn: (row) => row.transferOutEnabled ? 1 : 0, cell: ({ row }) => <StatusBadge tone={row.original.transferOutEnabled ? "good" : "warn"}>{row.original.transferOutEnabled ? "Enabled" : "Disabled"}</StatusBadge> },
  { id: creditUserColumnIds[4], header: "Account Status", accessorKey: "accountStatus", cell: ({ row }) => <><span className="muted">{row.original.accountStatus}</span><code>{row.original.accountId}</code></> },
  { id: creditUserColumnIds[5], header: "Latest Ledger", accessorKey: "latestLedgerAt", cell: ({ row }) => row.original.latestLedgerAtIso ? <BrowserTime value={row.original.latestLedgerAtIso} /> : "Never" }
];

export const creditScopeColumns: Array<ColumnDef<CreditScopeSummary, unknown>> = [
  { id: creditScopeColumnIds[0], header: "Scope", accessorKey: "scopeRef", cell: ({ row }) => <><strong>{row.original.scopeRef}</strong><code>{row.original.id}</code></> },
  { id: creditScopeColumnIds[1], header: "Balance", accessorKey: "balance" },
  { id: creditScopeColumnIds[2], header: "Status", accessorKey: "status" },
  { id: creditScopeColumnIds[3], header: "Latest Ledger", accessorKey: "latestLedgerAt", cell: ({ row }) => row.original.latestLedgerAtIso ? <BrowserTime value={row.original.latestLedgerAtIso} /> : "Never" }
];
