import type { RowSelectionState } from "@frely/console-ui/data-table";

export function stablePlanTemplateRowId(template: { id: string }) { return template.id; }

export function selectedPlanTemplateIds(selection: RowSelectionState) {
  return new Set(Object.keys(selection).filter((id) => selection[id]));
}

export function reconcilePlanTemplateSelection(selection: RowSelectionState, rows: Array<{ id: string }>): RowSelectionState {
  const valid = new Set(rows.map((row) => row.id));
  return Object.fromEntries(Object.entries(selection).filter(([id, selected]) => selected && valid.has(id)));
}
