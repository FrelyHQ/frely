export interface PlanBudgetLimitData {
  key: string;
  limitScope: "subscription" | "user";
  metric: "tokens" | "amount";
  windowType: "fixed" | "cumulative";
  windowSeconds: number | null;
  limitValue: number;
  usedValue: number | null;
  remainingValue: number | null;
  percentUsed: number | null;
  exhausted: boolean | null;
  targetUserLabel: string | null;
  nextResetAt: string | null;
}

interface AudiencePlanBudgetSourceInput {
  key: string;
  planName: string;
  planVersion: number;
  billingMode: "prepaid" | "paygo";
  scopeLabel: string;
  effectiveState: "current" | "future" | "ended";
  effectiveStart: string;
  effectiveEnd: string | null;
  usageMode: "current" | "at_end" | "not_started";
  usageReferenceAt: string | null;
  applicableModels: string[];
  limits: PlanBudgetLimitData[];
  nextPeriodStart: string | null;
}

export interface PlanBudgetSourceData {
  key: string;
  subscriptionId: string | null;
  planName: string;
  planVersion: number;
  billingMode: "prepaid" | "paygo";
  scopeLabel: string;
  scopeRef: string | null;
  lifecycle: string | null;
  effectiveState: "current" | "future" | "ended";
  source: string | null;
  priority: number | null;
  effectiveStart: string;
  effectiveEnd: string | null;
  usageMode: "current" | "at_end" | "not_started";
  usageReferenceAt: string | null;
  applicableModels: string[];
  limits: PlanBudgetLimitData[];
  userLimitCount: number | null;
  nextPeriodStart: string | null;
}

export function audiencePlanBudgetData(
  sources: readonly AudiencePlanBudgetSourceInput[],
): PlanBudgetSourceData[] {
  return sources.map((source) => ({
    key: source.key,
    subscriptionId: null,
    planName: source.planName,
    planVersion: source.planVersion,
    billingMode: source.billingMode,
    scopeLabel: source.scopeLabel,
    scopeRef: null,
    lifecycle: null,
    effectiveState: source.effectiveState,
    source: null,
    priority: null,
    effectiveStart: source.effectiveStart,
    effectiveEnd: source.effectiveEnd,
    usageMode: source.usageMode,
    usageReferenceAt: source.usageReferenceAt,
    applicableModels: source.applicableModels,
    limits: source.limits.map((limit) => ({ ...limit })),
    userLimitCount: null,
    nextPeriodStart: source.nextPeriodStart,
  }));
}
