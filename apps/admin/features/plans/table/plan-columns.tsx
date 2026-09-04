import { Button } from "@frely/ui/components/button";
import type { ColumnDef } from "@frely/console-ui/data-table";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import type { PlanDirectoryRow } from "../types";
import { formatCurrency, formatPlanDuration, truncateText } from "../form/plan-model";

export function createPlanTemplateColumns(onView: (template: PlanDirectoryRow) => void): Array<ColumnDef<PlanDirectoryRow, unknown>> {
  return [
    { id: "template", header: "Template", cell: ({ row }) => <><strong>{row.original.name} v{row.original.version}</strong><code>{row.original.id}</code></> },
    { id: "duration", header: "Duration", cell: ({ row }) => formatPlanDuration(row.original) },
    { id: "purchaseAmount", header: "Unit Price", cell: ({ row }) => formatCurrency(row.original.purchaseAmount) },
    { id: "billingMode", header: "Billing", cell: ({ row }) => <StatusBadge tone={row.original.billingMode === "paygo" ? "warn" : "info"}>{row.original.billingMode === "paygo" ? "PayGo" : "Prepaid"}</StatusBadge> },
    { id: "catalogStatus", header: "Catalog", cell: ({ row }) => <StatusBadge tone={row.original.catalogStatus === "listed" ? "good" : "neutral"}>{row.original.catalogStatus}</StatusBadge> },
    { id: "rules", header: "Limits", cell: ({ row }) => row.original.budgetLimitCount ? `${row.original.budgetLimitCount} configured` : "No limits" },
    { id: "accessPoints", header: "AccessPoints", cell: ({ row }) => row.original.accessPointCount ? <>{row.original.accessPointNames.join(", ")}{row.original.accessPointCount > row.original.accessPointNames.length ? ` +${row.original.accessPointCount - row.original.accessPointNames.length}` : ""}</> : "No AP" },
    { id: "adminNote", header: "Admin Note", cell: ({ row }) => row.original.adminNote ? <span className="muted">{truncateText(row.original.adminNote, 80)}</span> : <span className="muted">None</span> },
    { id: "status", header: "Status", cell: ({ row }) => <StatusBadge tone={row.original.status === "enabled" ? "good" : row.original.status === "closed" ? "warn" : "neutral"}>{row.original.status}</StatusBadge> },
    { id: "actions", header: "Actions", cell: ({ row }) => <Button type="button" variant="secondary" onClick={() => onView(row.original)}>View</Button> }
  ];
}
