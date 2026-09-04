import Link from "@admin/navigation";
import { ApiKeyIdentityCell, ProgressBar, StatusBadge } from "@frely/console-ui";
import type { ColumnDef } from "@frely/console-ui/data-table";
import { BrowserTime } from "@frely/ui/components/browser-time";
import type { AdminApiKeyOverviewRow } from "../../../lib/teams";

export const apiKeyColumns: Array<ColumnDef<AdminApiKeyOverviewRow, unknown>> = [
  {
    id: "key",
    header: "Key",
    accessorFn: (apiKey) => `${apiKey.name} ${apiKey.prefix} ${apiKey.id}`,
    cell: ({ row }) => <ApiKeyIdentityCell apiKey={row.original} href={`/owner/users/${row.original.userId}`} />
  },
  {
    id: "owner",
    header: "Owner",
    accessorFn: (apiKey) => `${apiKey.userName} ${apiKey.userEmail}`,
    cell: ({ row }) => <Link className="cell-link cell-link-stack" href={`/owner/users/${row.original.userId}`} aria-label={`Open ${row.original.userName} details`}><strong>{row.original.userName}</strong><code>{row.original.userEmail}</code></Link>
  },
  { id: "scopes", header: "Effective Scopes", accessorKey: "scopeSummary", cell: ({ row }) => <code>{row.original.scopeSummary}</code> },
  { id: "status", header: "Status", accessorKey: "status", cell: ({ row }) => <StatusBadge tone={row.original.statusTone}>{row.original.status}</StatusBadge> },
  {
    id: "usage",
    header: "Usage",
    accessorKey: "planUsage",
    cell: ({ row }) => <div className="usage-cell"><ProgressBar value={row.original.planUsage} tone={row.original.usageTone} /><span>{row.original.planUsage}%</span></div>
  },
  { id: "budget", header: "Budget", accessorKey: "budget" },
  { id: "lastUsed", header: "Last Used", accessorKey: "lastUsed", sortDescFirst: true, cell: ({ row }) => row.original.lastUsedAt ? <BrowserTime value={row.original.lastUsedAt} /> : "Never" }
];
