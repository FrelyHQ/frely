import type { ColumnDef } from "@frely/console-ui/data-table";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import type { AuditLogRow } from "../lib/audit-log-aggregate";

export const auditLogColumns: Array<ColumnDef<AuditLogRow, unknown>> = [
  { id: "time", header: "Time", accessorKey: "time", enableSorting: false, cell: ({ row }) => <BrowserTime value={row.original.createdAt} seconds /> },
  { id: "actor", header: "Actor", accessorKey: "actor", enableSorting: false },
  { id: "source", header: "Source", accessorKey: "source", enableSorting: false },
  { id: "action", header: "Action", accessorKey: "action", enableSorting: false },
  { id: "resource", header: "Resource", accessorKey: "resource", enableSorting: false, cell: ({ row }) => <code>{row.original.resource}</code> },
  { id: "result", header: "Result", accessorKey: "result", enableSorting: false, cell: ({ row }) => <StatusBadge tone={row.original.resultTone}>{row.original.result}</StatusBadge> }
];
