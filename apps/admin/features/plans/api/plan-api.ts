import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { AccessPointSummary, BudgetPolicy, DirectoryPage, Plan, PlanBudgetLimit, PlanTemplate, PlanTemplateDetailPage } from "../types";
import { planSubscriptionCancelInput } from "../form/plan-form-values";

export interface BudgetPolicyInput { metric: string; limitValue: number; windowType: string; windowSeconds: number | null; status: string; }
export interface PlanPriceTierInput { serviceTier?: string; tierKey: string; minInputTokens: number; maxInputTokens: number | null; inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number; }
export interface PlanTemplateInput { ownerId?: string; scopeRef?: string; name: string; description: string; adminNote: string; billingMode: "prepaid" | "paygo"; purchaseAmount: number; durationSeconds: number; catalogStatus: "listed" | "unlisted"; budgetLimits: PlanBudgetLimit[]; accessPointIds: string[]; accessPointPriceOverrides: Array<{ accessPointId: string; inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number; tiers?: PlanPriceTierInput[] }>; }
export interface PlanTemplateUpdateInput extends Partial<Omit<PlanTemplateInput, "name" | "billingMode" | "purchaseAmount" | "durationSeconds">> { id: string; status?: "enabled" | "closed" | "disabled"; }
export type PlanTemplateMutationResult = Omit<PlanTemplate, "budgetLimits" | "accessPoints"> & Partial<Pick<PlanTemplate, "budgetLimits" | "accessPoints">>;
export interface PlanSubscriptionInput { planTemplateId: string; scopeRef: string; units: number; paymentMode: string; paymentAccountId: string | null; priority: number; effectiveStart?: string; }
export interface PlanCardReplacementResult { sourcePlanId: string; targetPlanId: string; replacedCount: number; }

async function jsonRequest<T>(url: string, method: "POST" | "PATCH", input: object, fallback: string) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return readConsoleApiResponse<T>(response, fallback);
}

export const createBudgetPolicy = (input: BudgetPolicyInput) => jsonRequest<BudgetPolicy>("/api/owner/budgets", "POST", input, "Create budget policy failed");
export const createPlanTemplate = (input: PlanTemplateInput) => jsonRequest<PlanTemplateMutationResult>("/api/owner/plan-templates", "POST", input, "Create plan template failed");
export const updatePlanTemplate = (input: PlanTemplateUpdateInput) => jsonRequest<PlanTemplateMutationResult>("/api/owner/plan-templates", "PATCH", input, "Update plan template failed");
export const replaceAvailablePlanCards = (input: { sourcePlanId: string; targetPlanId: string }) => jsonRequest<PlanCardReplacementResult>(`/api/owner/plan-templates/${encodeURIComponent(input.sourcePlanId)}/replace-cards`, "POST", { targetPlanId: input.targetPlanId }, "Replace Plan Cards failed");
export const createPlanSubscription = (input: PlanSubscriptionInput) => jsonRequest<Plan | { items: Plan[]; ledgerEventIds?: string[]; nextCursor?: null }>("/api/owner/plans", "POST", input, "Subscribe plan failed");
export const cancelPlanSubscription = (id: string) => jsonRequest<Plan>("/api/owner/plans", "PATCH", planSubscriptionCancelInput(id), "Cancel subscription failed");
export const updatePlanTemplates = (input: object) => jsonRequest<{ items: Array<Pick<PlanTemplate, "id" | "status" | "updatedAt">> }>("/api/owner/plan-templates", "PATCH", input, "Update plan templates failed");

export async function fetchPlanTemplateDetail(
  id: string,
  budgetPage: number,
  budgetPageSize: number,
  accessPage: number,
  accessPageSize: number,
  signal?: AbortSignal,
): Promise<PlanTemplateDetailPage> {
  const params = new URLSearchParams({
    budgetPage: String(budgetPage),
    budgetPageSize: String(budgetPageSize),
    accessPage: String(accessPage),
    accessPageSize: String(accessPageSize),
  });
  const response = await fetch(
    `/api/owner/plan-templates/${encodeURIComponent(id)}/detail?${params}`,
    signal ? { signal } : undefined,
  );
  return readConsoleApiResponse<PlanTemplateDetailPage>(response, "Load Plan template details failed");
}

export async function fetchPlanAccessPointCandidates(
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<DirectoryPage<AccessPointSummary>> {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await fetch(`/api/owner/plan-access-point-candidates?${params}`, signal ? { signal } : undefined);
  return readConsoleApiResponse<DirectoryPage<AccessPointSummary>>(response, "Load AccessPoint candidates failed");
}

export interface PlanReplacementCandidate {
  id: string;
  name: string;
  version: number;
  billingMode: string;
  planStatus: string;
}

export async function fetchPlanReplacementCandidates(
  sourcePlanId: string,
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<DirectoryPage<PlanReplacementCandidate>> {
  const params = new URLSearchParams({
    sourcePlanId,
    q: query,
    page: String(page),
  });
  const response = await fetch(`/api/owner/plan-replacement-candidates?${params}`, signal ? { signal } : undefined);
  return readConsoleApiResponse<DirectoryPage<PlanReplacementCandidate>>(response, "Load replacement Plan candidates failed");
}
