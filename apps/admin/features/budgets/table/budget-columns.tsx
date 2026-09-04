import type { ColumnDef } from "@frely/console-ui/data-table";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import { enabledTone, governancePolicyLabel, governancePolicyWindowLabel, policyLabel, policyLimitLabel, titleCase } from "../lib/budget-presenters";
import type { DirectAssignment, DisplayPolicy, GovernanceBudgetAssignment, GovernanceBudgetPolicy } from "../types";

export const budgetPolicyColumns: Array<ColumnDef<DisplayPolicy, unknown>> = [
  { id: "policy", header: "Policy", accessorKey: "name", cell: ({ row }) => <><strong>{row.original.name}</strong><code>{row.original.id}</code></> },
  { id: "metric", header: "Metric", accessorKey: "metric" }, { id: "limit", header: "Limit", accessorKey: "hardStopCap", cell: ({ getValue }) => <strong>{String(getValue())}</strong> },
  { id: "window", header: "Window", accessorKey: "window" }, { id: "status", header: "Status", accessorKey: "status", cell: ({ row }) => <StatusBadge tone={row.original.statusTone}>{row.original.status}</StatusBadge> }
];
export function directAssignmentColumns(): Array<ColumnDef<DirectAssignment, unknown>> { return [
  { id: "apiKey", header: "API Key", cell: ({ row }) => { const id = row.original.scopeRef.startsWith("key:") ? row.original.scopeRef.slice(4) : row.original.scopeRef; return <><strong>{row.original.apiKey?.name ?? id}</strong><code>{row.original.apiKey?.keyPrefix ?? id}</code></>; } },
  { id: "scope", header: "Scope", accessorKey: "scopeRef", cell: ({ getValue }) => <code>{String(getValue())}</code> },
  { id: "policy", header: "Policy", accessorKey: "budgetPolicyId", cell: ({ row }) => <><strong>{row.original.budgetPolicyId}</strong><div className="muted">{policyLabel(row.original.budgetPolicy)}</div></> },
  { id: "limit", header: "Limit", cell: ({ row }) => policyLimitLabel(row.original.budgetPolicy) },
  { id: "status", header: "Status", accessorKey: "status", cell: ({ row }) => <StatusBadge tone={row.original.status === "enabled" && row.original.budgetPolicy.status === "enabled" ? "good" : "neutral"}>{row.original.status}</StatusBadge> }
]; }
export const governancePolicyColumns: Array<ColumnDef<GovernanceBudgetPolicy, unknown>> = [
  { id: "policy", header: "Policy", accessorKey: "id", cell: ({ getValue }) => <strong>{String(getValue())}</strong> }, { id: "metric", header: "Metric", accessorKey: "metric", cell: ({ getValue }) => titleCase(String(getValue())) },
  { id: "limit", header: "Limit", cell: ({ row }) => policyLimitLabel(row.original) }, { id: "window", header: "Window", cell: ({ row }) => governancePolicyWindowLabel(row.original) },
  { id: "status", header: "Status", accessorKey: "status", cell: ({ row }) => <StatusBadge tone={enabledTone(row.original.status)}>{row.original.status}</StatusBadge> }
];
export const governanceAssignmentColumns: Array<ColumnDef<GovernanceBudgetAssignment, unknown>> = [
  { id: "scope", header: "Scope", accessorKey: "scopeRef", cell: ({ getValue }) => <code>{String(getValue())}</code> },
  { id: "policy", header: "Policy", accessorKey: "governanceBudgetPolicyId", cell: ({ row }) => <><strong>{row.original.governanceBudgetPolicyId}</strong><div className="muted">{governancePolicyLabel(row.original.governanceBudgetPolicy)}</div></> },
  { id: "limit", header: "Limit", cell: ({ row }) => policyLimitLabel(row.original.governanceBudgetPolicy) },
  { id: "status", header: "Status", accessorKey: "status", cell: ({ row }) => <StatusBadge tone={enabledTone(row.original.status)}>{row.original.status}</StatusBadge> }
];
