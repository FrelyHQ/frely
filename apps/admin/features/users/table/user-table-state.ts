import type { OwnerUserOverviewRow } from "../../../lib/teams";

interface UserTableRow {
  original: OwnerUserOverviewRow;
  getValue: (columnId: string) => unknown;
}

export const userTableInitialState: { sorting: Array<{ id: string; desc: boolean }> } = { sorting: [{ id: "user", desc: false }] };

export function compareUserTextRows(left: UserTableRow, right: UserTableRow, columnId: string) {
  return compareWithStableId(left, right, String(left.getValue(columnId)), String(right.getValue(columnId)));
}

export function compareUserNumberRows(left: UserTableRow, right: UserTableRow, columnId: string) {
  const leftValue = Number(left.getValue(columnId));
  const rightValue = Number(right.getValue(columnId));
  const result = Number.isNaN(leftValue) ? (Number.isNaN(rightValue) ? 0 : 1) : Number.isNaN(rightValue) ? -1 : leftValue - rightValue;
  return result || compareIds(left, right);
}

export function compareUserDateRows(left: UserTableRow, right: UserTableRow, columnId: string) {
  const leftValue = String(left.getValue(columnId));
  const rightValue = String(right.getValue(columnId));
  const result = leftValue === "Never" ? (rightValue === "Never" ? 0 : 1) : rightValue === "Never" ? -1 : USER_SORT_COLLATOR.compare(leftValue, rightValue);
  return result || compareIds(left, right);
}

function compareWithStableId(left: UserTableRow, right: UserTableRow, leftValue: string, rightValue: string) {
  return USER_SORT_COLLATOR.compare(leftValue, rightValue) || compareIds(left, right);
}

function compareIds(left: UserTableRow, right: UserTableRow) {
  return USER_SORT_COLLATOR.compare(left.original.id, right.original.id);
}

const USER_SORT_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
