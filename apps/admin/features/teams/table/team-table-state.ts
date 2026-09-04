import type { AdminTeamDirectoryRow, AdminTeamRow } from "../../../lib/teams";

interface TeamTableRow { original: AdminTeamRow; getValue: (columnId: string) => unknown }

export const teamTableInitialState = { sorting: [{ id: "createdAt", desc: false }] };
export const TEAM_SORT_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function compareTeamTextRows(left: TeamTableRow, right: TeamTableRow, columnId: string) {
  return stable(left, right, TEAM_SORT_COLLATOR.compare(String(left.getValue(columnId)), String(right.getValue(columnId))));
}

export function compareTeamNumberRows(left: TeamTableRow, right: TeamTableRow, columnId: string) {
  return stable(left, right, Number(left.getValue(columnId)) - Number(right.getValue(columnId)));
}

export function compareTeamBudgetRows(left: TeamTableRow, right: TeamTableRow) {
  const state = TEAM_SORT_COLLATOR.compare(left.original.budgetState, right.original.budgetState);
  return stable(left, right, state || parseTeamCurrency(left.original.budget) - parseTeamCurrency(right.original.budget));
}

export function ownerPermissionSummary(team: AdminTeamDirectoryRow | AdminTeamRow) {
  const permissions = [
    team.canManageMemberApiKeyLimit ? "limits" : "",
    team.canManageMemberCredit ? "credit" : "",
    team.teamOwnerCanCreateAccessPoint ? "access points" : ""
  ].filter(Boolean);
  return permissions.length > 0 ? permissions.join(", ") : "No delegated writes";
}

export function parseTeamCurrency(value: string) {
  if (value.toLowerCase() === "no cap") return Number.POSITIVE_INFINITY;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function stable(left: TeamTableRow, right: TeamTableRow, result: number) {
  return result || TEAM_SORT_COLLATOR.compare(left.original.id, right.original.id);
}
