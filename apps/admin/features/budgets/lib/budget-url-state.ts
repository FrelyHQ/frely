import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";

export interface BudgetPoliciesUrlState {
  policyQuery: string;
  policyPage: number;
  policyPageSize: TablePageSize;
  assignmentQuery: string;
  assignmentPage: number;
  assignmentPageSize: TablePageSize;
}

export function parseBudgetPoliciesUrlState(
  params?: Record<string, string | string[] | undefined>,
): BudgetPoliciesUrlState {
  return {
    policyQuery: first(params?.policyQ).trim().slice(0, 100),
    policyPage: pageNumber(params?.policyPage),
    policyPageSize: normalizeTablePageSize(params?.policyPageSize),
    assignmentQuery: first(params?.assignmentQ).trim().slice(0, 100),
    assignmentPage: pageNumber(params?.assignmentPage),
    assignmentPageSize: normalizeTablePageSize(params?.assignmentPageSize),
  };
}

export function budgetPoliciesHref(state: BudgetPoliciesUrlState) {
  const params = new URLSearchParams();
  if (state.policyQuery) params.set("policyQ", state.policyQuery);
  if (state.policyPage > 1) params.set("policyPage", String(state.policyPage));
  if (state.policyPageSize !== 20) params.set("policyPageSize", String(state.policyPageSize));
  if (state.assignmentQuery) params.set("assignmentQ", state.assignmentQuery);
  if (state.assignmentPage > 1) params.set("assignmentPage", String(state.assignmentPage));
  if (state.assignmentPageSize !== 20) params.set("assignmentPageSize", String(state.assignmentPageSize));
  return `/owner/plans-and-budgets/budget-policies${params.size > 0 ? `?${params}` : ""}`;
}

export interface GovernanceBudgetsUrlState {
  policyPage: number;
  policyPageSize: TablePageSize;
  assignmentPage: number;
  assignmentPageSize: TablePageSize;
}

export function parseGovernanceBudgetsUrlState(
  params?: Record<string, string | string[] | undefined>,
): GovernanceBudgetsUrlState {
  return {
    policyPage: pageNumber(params?.policyPage),
    policyPageSize: normalizeTablePageSize(params?.policyPageSize),
    assignmentPage: pageNumber(params?.assignmentPage),
    assignmentPageSize: normalizeTablePageSize(params?.assignmentPageSize),
  };
}

export function governanceBudgetsHref(state: GovernanceBudgetsUrlState) {
  const params = new URLSearchParams();
  if (state.policyPage > 1) params.set("policyPage", String(state.policyPage));
  if (state.policyPageSize !== 20) params.set("policyPageSize", String(state.policyPageSize));
  if (state.assignmentPage > 1) params.set("assignmentPage", String(state.assignmentPage));
  if (state.assignmentPageSize !== 20) params.set("assignmentPageSize", String(state.assignmentPageSize));
  return `/owner/plans-and-budgets/governance-budgets${params.size > 0 ? `?${params}` : ""}`;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function pageNumber(value: string | string[] | undefined) {
  const raw = first(value);
  return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}
