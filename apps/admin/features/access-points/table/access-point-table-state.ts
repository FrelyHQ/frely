import type { AccessPointSummary } from "../types";
export function filterAccessPoints(
  rows: AccessPointSummary[],
  scope: string,
  query: string,
) {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (scope === "all" || row.scopeRef === scope) &&
      (!q ||
        `${row.name} ${row.exposedModel} ${row.targetModel} ${row.targetProviderId ?? ""} ${row.targetProviderModelName ?? ""} ${row.targetId ?? ""}`
          .toLowerCase()
          .includes(q)),
  );
}
export function accessPointRowId(row: AccessPointSummary) {
  return row.id;
}
export function isAllowedScope(scopeRef: string, allowed: string[]) {
  return allowed.includes(scopeRef);
}
export function bulkAccessPointPreview(
  row: AccessPointSummary,
  operation: "status" | "scopeRef" | "priority" | "weight" | "fallbackOrder",
  value: string,
) {
  if (operation === "scopeRef") return `${row.scopeRef} -> ${value}`;
  if (operation === "status") return `${row.status} -> ${value}`;
  if (operation === "priority") return `priority ${row.priority} -> ${value}`;
  if (operation === "weight") return `weight ${row.weight} -> ${value}`;
  return `fallback ${row.fallbackOrder} -> ${value}`;
}
