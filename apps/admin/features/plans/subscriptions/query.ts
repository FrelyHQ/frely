import { RelayError, type ScopeRef } from "@frely/core";
import type { UiQueryPort, PlanBudgetSourceView, PlanSubscription, PlanSubscriptionListFilter, UiSyncQueryPort } from "@frely/ui-application/contracts";
import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";
import type { IdentityQueries } from "@frely/identity/server";

export const SUBSCRIPTIONS_PAGE_SIZE = 20;

export interface SubscriptionSearchState {
  subscriptionId: string;
  planId: string;
  scopeType: "" | "global" | "team" | "user";
  scopeRef: string;
  status: "active" | "canceled" | "all";
  source: string;
  effectiveState: "" | "current" | "future" | "ended";
  page: number;
  pageSize: TablePageSize;
}

export function parseSubscriptionSearch(params?: Record<string, string | string[] | undefined>): SubscriptionSearchState {
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  const status = one(params?.status).toLowerCase();
  const scopeType = one(params?.scopeType).toLowerCase();
  const effectiveState = one(params?.effectiveState).toLowerCase();
  const rawPage = one(params?.page);
  return {
    subscriptionId: one(params?.subscriptionId).slice(0, 160),
    planId: one(params?.planId).slice(0, 160),
    scopeType: ["global", "team", "user"].includes(scopeType) ? scopeType as SubscriptionSearchState["scopeType"] : "",
    scopeRef: one(params?.scopeRef).slice(0, 200),
    status: status === "all" || status === "canceled" ? status : "active",
    source: one(params?.source).slice(0, 120),
    effectiveState: ["current", "future", "ended"].includes(effectiveState) ? effectiveState as SubscriptionSearchState["effectiveState"] : "",
    page: /^\d+$/.test(rawPage) ? Math.max(1, Math.min(10_000, Number(rawPage))) : 1,
    pageSize: normalizeTablePageSize(params?.pageSize),
  };
}

export function subscriptionFilter(state: SubscriptionSearchState, at: string): PlanSubscriptionListFilter {
  return {
    ...(state.subscriptionId ? { subscriptionId: state.subscriptionId } : {}),
    ...(state.planId ? { planId: state.planId } : {}),
    ...(state.scopeType ? { scopeType: state.scopeType } : {}),
    ...(state.scopeRef ? { scopeRef: state.scopeRef as ScopeRef } : {}),
    ...(state.status !== "all" ? { subscriptionLifecycle: state.status } : {}),
    ...(state.source ? { source: state.source } : {}),
    ...(state.effectiveState ? { effectiveState: state.effectiveState, effectiveAt: at } : {})
  };
}

export function readSubscriptionOverview(repo: UiSyncQueryPort, state: SubscriptionSearchState, at: string) {
  const filter = subscriptionFilter(state, at);
  const total = repo.countPlanSubscriptions(filter);
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  const page = Math.min(state.page, totalPages);
  const subscriptions = repo.listPlanSubscriptions(filter, state.pageSize, (page - 1) * state.pageSize);
  const usage = repo.listPlanSubscriptionBudgetUsage(subscriptions.map(({ id }) => id), null, at);
  return { subscriptions, usage, page, pageSize: state.pageSize, total, totalPages, calculatedAt: at };
}

export async function readSubscriptionOverviewAsync(
  repo: Pick<UiQueryPort, "countPlanSubscriptions" | "listPlanSubscriptions" | "listPlanSubscriptionBudgetUsage">,
  state: SubscriptionSearchState,
  at: string,
) {
  const filter = subscriptionFilter(state, at);
  const total = await repo.countPlanSubscriptions(filter);
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  const page = Math.min(state.page, totalPages);
  const subscriptions = await repo.listPlanSubscriptions(filter, state.pageSize, (page - 1) * state.pageSize);
  const usage = await repo.listPlanSubscriptionBudgetUsage(subscriptions.map(({ id }) => id), null, at);
  return { subscriptions, usage, page, pageSize: state.pageSize, total, totalPages, calculatedAt: at };
}

export function readSubscriptionDetail(repo: UiSyncQueryPort, identity: Pick<UiSyncQueryPort, "getUser">, subscriptionId: string, targetUserId: string, at: string) {
  const subscription = repo.getPlanSubscription(subscriptionId);
  if (!subscription) throw new RelayError("plan_subscription_not_found", "Plan Subscription not found", 404);
  if (targetUserId && !identity.getUser(targetUserId)) throw new RelayError("user_not_found", "Target user not found", 404);
  if (targetUserId && !repo.isPlanSubscriptionUserEligible(subscriptionId, targetUserId, at)) {
    throw new RelayError("target_user_not_eligible", "Target user is not eligible for this Subscription", 409);
  }
  const usage = repo.listPlanSubscriptionBudgetUsage([subscriptionId], targetUserId || null, at)[0];
  if (!usage) throw new RelayError("plan_subscription_not_found", "Plan Subscription not found", 404);
  return { subscription, usage, calculatedAt: at, targetUserId: targetUserId || null };
}

export async function readSubscriptionDetailAsync(
  repo: Pick<UiQueryPort, "getPlanSubscription" | "isPlanSubscriptionUserEligible" | "listPlanSubscriptionBudgetUsage">,
  identity: Pick<IdentityQueries, "getUser">,
  subscriptionId: string,
  targetUserId: string,
  at: string,
) {
  const subscription = await repo.getPlanSubscription(subscriptionId);
  if (!subscription) throw new RelayError("plan_subscription_not_found", "Plan Subscription not found", 404);
  if (targetUserId && !(await identity.getUser(targetUserId))) throw new RelayError("user_not_found", "Target user not found", 404);
  if (targetUserId && !(await repo.isPlanSubscriptionUserEligible(subscriptionId, targetUserId, at))) throw new RelayError("target_user_not_eligible", "Target user is not eligible for this Subscription", 409);
  const usage = (await repo.listPlanSubscriptionBudgetUsage([subscriptionId], targetUserId || null, at))[0];
  if (!usage) throw new RelayError("plan_subscription_not_found", "Plan Subscription not found", 404);
  return { subscription, usage, calculatedAt: at, targetUserId: targetUserId || null };
}

export interface SubscriptionOverviewRow extends PlanSubscription {
  usage: PlanBudgetSourceView | null;
}
