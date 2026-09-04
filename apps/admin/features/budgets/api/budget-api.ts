import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { PolicyFormValues, DirectAssignmentFormValues, GovernanceAssignmentFormValues } from "../form/budget-form-values";
import { toDirectAssignmentInput, toPolicyInput } from "../form/budget-form-values";
import type { ApiKeySummary, BudgetPolicy, BudgetPolicyCandidate, DirectoryPage, DirectAssignment, GovernanceBudgetAssignment, GovernanceBudgetPolicy } from "../types";

async function post<T>(url: string, input: object, fallback: string) { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); return readConsoleApiResponse<T>(response, fallback); }
export const createBudgetPolicy = (value: PolicyFormValues) => post<BudgetPolicy>("/api/owner/budgets", toPolicyInput(value), "Create budget policy failed");
export const assignDirectBudgetPolicy = (value: DirectAssignmentFormValues) => post<Omit<DirectAssignment, "budgetPolicy" | "apiKey">>("/api/owner/scope-budget-policies", toDirectAssignmentInput(value), "Assign direct limit failed");
export const createGovernanceBudgetPolicy = (value: PolicyFormValues) => post<GovernanceBudgetPolicy>("/api/owner/governance-budgets", toPolicyInput(value), "Create governance budget failed");
export const assignGovernanceBudgetPolicy = (value: GovernanceAssignmentFormValues) => post<Omit<GovernanceBudgetAssignment, "governanceBudgetPolicy">>("/api/owner/scope-governance-budget-policies", value, "Assign governance budget failed");

export async function fetchBudgetApiKeyCandidates(query: string, page: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await fetch(`/api/owner/api-key-candidates?${params}`, signal ? { signal } : undefined);
  return readConsoleApiResponse<DirectoryPage<ApiKeySummary>>(response, "Load API key candidates failed");
}

export async function fetchBudgetPolicyCandidates(query: string, page: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await fetch(`/api/owner/budget-policy-candidates?${params}`, signal ? { signal } : undefined);
  return readConsoleApiResponse<DirectoryPage<BudgetPolicyCandidate>>(response, "Load Budget Policy candidates failed");
}

export async function fetchGovernanceBudgetPolicyCandidates(query: string, page: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await fetch(`/api/owner/governance-budget-policy-candidates?${params}`, signal ? { signal } : undefined);
  return readConsoleApiResponse<DirectoryPage<BudgetPolicyCandidate>>(response, "Load Governance Budget candidates failed");
}
