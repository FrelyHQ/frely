"use client";

import { DataTable } from "@frely/console-ui/data-table";
import type { AuditLogRow } from "../lib/audit-log-aggregate";
import { auditLogColumns } from "../table/audit-log-columns";

export function AuditLogsTable({ rows }: { rows: AuditLogRow[] }) {
  return <DataTable data={rows} columns={auditLogColumns} getRowId={(row) => row.id} serverManaged emptyState={{ title: "No audit events match this filter." }} />;
}
