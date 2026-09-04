import { RelayError } from "@frely/core";

export type BudgetLimitScope = "subscription" | "user";
export type BudgetMetric = "tokens" | "amount";
export type BudgetWindowType = "fixed" | "cumulative";

export interface PlanBudgetLimitInput {
  limitScope: BudgetLimitScope;
  metric: BudgetMetric;
  limitValue: number;
  windowType: BudgetWindowType;
  windowSeconds: number | null;
}

export function normalizePlanBudgetLimit(input: PlanBudgetLimitInput): PlanBudgetLimitInput {
  if (input.limitScope !== "subscription" && input.limitScope !== "user") throw new RelayError("invalid_plan_budget_limit_scope", "Plan budget limit_scope must be subscription or user", 400);
  if (input.metric !== "tokens" && input.metric !== "amount") throw new RelayError("invalid_plan_budget_metric", "Plan budget metric must be tokens or amount", 400);
  if (!Number.isFinite(input.limitValue) || input.limitValue <= 0) throw new RelayError("invalid_plan_budget_limit_value", "Plan budget limitValue must be a finite positive number", 400);
  if (input.metric === "tokens" && !Number.isSafeInteger(input.limitValue)) throw new RelayError("invalid_plan_budget_limit_value", "Token Plan budget limitValue must be a positive integer", 400);
  if (input.windowType === "fixed") {
    if (!Number.isSafeInteger(input.windowSeconds) || (input.windowSeconds ?? 0) <= 0) throw new RelayError("invalid_plan_budget_window", "Fixed Plan budget limit requires a positive integer windowSeconds", 400);
  } else if (input.windowType === "cumulative") {
    if (input.windowSeconds !== null) throw new RelayError("invalid_plan_budget_window", "Cumulative Plan budget limit requires windowSeconds to be null", 400);
  } else {
    throw new RelayError("invalid_plan_budget_window_type", "Plan budget windowType must be fixed or cumulative", 400);
  }
  return { limitScope: input.limitScope, metric: input.metric, limitValue: input.limitValue, windowType: input.windowType, windowSeconds: input.windowSeconds };
}

export function planBudgetWindow(
  policy: Pick<PlanBudgetLimitInput, "windowType" | "windowSeconds">,
  subscription: { effectiveStart: string; effectiveEnd: string | null },
  at: string
): { start: string; end: string; periodEnd: string; nextResetAt: string | null } {
  const atMs = Date.parse(at);
  const effectiveStartMs = Date.parse(subscription.effectiveStart);
  const effectiveEndMs = subscription.effectiveEnd ? Date.parse(subscription.effectiveEnd) : atMs;
  const endMs = Math.min(atMs, effectiveEndMs);
  if (policy.windowType === "fixed") {
    const windowMs = (policy.windowSeconds ?? 0) * 1000;
    const isCurrent = subscription.effectiveEnd === null || atMs < effectiveEndMs;
    const bucketReferenceMs = isCurrent ? endMs : Math.max(effectiveStartMs, endMs - 1);
    const periodIndex = Math.max(0, Math.floor((bucketReferenceMs - effectiveStartMs) / windowMs));
    const startMs = effectiveStartMs + periodIndex * windowMs;
    const resetMs = startMs + windowMs;
    return {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      periodEnd: new Date(resetMs).toISOString(),
      nextResetAt: isCurrent ? new Date(resetMs).toISOString() : null
    };
  }
  const end = new Date(endMs).toISOString();
  return { start: subscription.effectiveStart, end, periodEnd: end, nextResetAt: null };
}

export function normalizePlanBudgetLimits(limits: PlanBudgetLimitInput[]): PlanBudgetLimitInput[] {
  const unique = new Map<string, PlanBudgetLimitInput>();
  for (const limit of limits) {
    const normalized = normalizePlanBudgetLimit(limit);
    const key = planBudgetLimitSemanticKey(normalized);
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()].sort(comparePlanBudgetLimits);
}

export function planBudgetLimitSemanticKey(limit: PlanBudgetLimitInput): string {
  return JSON.stringify([limit.limitScope, limit.metric, limit.limitValue, limit.windowType, limit.windowSeconds]);
}

export function comparePlanBudgetLimits(left: PlanBudgetLimitInput, right: PlanBudgetLimitInput): number {
  const scopeOrder = (scope: BudgetLimitScope) => scope === "subscription" ? 0 : 1;
  return scopeOrder(left.limitScope) - scopeOrder(right.limitScope)
    || left.metric.localeCompare(right.metric)
    || left.windowType.localeCompare(right.windowType)
    || (left.windowSeconds ?? -1) - (right.windowSeconds ?? -1)
    || left.limitValue - right.limitValue;
}
