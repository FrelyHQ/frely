import type { PlanBudgetSourceView } from "@frely/ui-application/contracts";
import type { PlanBudgetSourceData } from "./plan-budget-data";

interface PlanBudgetScopeQueries {
  readonly identity: {
    getUser(id: string): Promise<{ email: string } | undefined>;
  };
  readonly tenancy: {
    getTeam(id: string): Promise<{ name: string } | undefined>;
  };
}

export async function adminPlanBudgetDataSourcesAsync(
  contexts: PlanBudgetScopeQueries,
  sources: readonly PlanBudgetSourceView[],
): Promise<PlanBudgetSourceData[]> {
  const scopeLabels = new Map(await Promise.all(
    [...new Set(sources.map((source) => source.scopeRef))].map(async (scopeRef) => [
      scopeRef,
      await adminScopeLabelAsync(contexts, scopeRef),
    ] as const),
  ));
  return sources.map((source) => ({
    key: source.subscriptionId,
    subscriptionId: source.subscriptionId,
    planName: source.planName,
    planVersion: source.planVersion,
    billingMode: source.billingMode,
    scopeLabel: scopeLabels.get(source.scopeRef) ?? source.scopeRef,
    scopeRef: source.scopeRef,
    lifecycle: source.subscriptionLifecycle,
    effectiveState: source.effectiveState,
    source: source.source,
    priority: source.priority,
    effectiveStart: source.effectiveStart,
    effectiveEnd: source.effectiveEnd,
    usageMode: source.usageMode,
    usageReferenceAt: source.usageReferenceAt,
    applicableModels: source.applicableModels,
    userLimitCount: source.userLimitCount,
    nextPeriodStart: source.nextPeriodStart,
    limits: source.limits.map((limit, index) => ({
      key: `${source.subscriptionId}:${index}`,
      limitScope: limit.limitScope,
      metric: limit.metric,
      windowType: limit.windowType,
      windowSeconds: limit.windowSeconds,
      limitValue: limit.limitValue,
      usedValue: limit.usedValue,
      remainingValue: limit.remainingValue,
      percentUsed: limit.percentUsed,
      exhausted: limit.exhausted,
      targetUserLabel: limit.targetUser?.label ?? null,
      nextResetAt: limit.nextResetAt,
    })),
  }));
}

async function adminScopeLabelAsync(contexts: PlanBudgetScopeQueries, scopeRef: string) {
  if (scopeRef === "global:") return "Global";
  if (scopeRef.startsWith("team:")) return (await contexts.tenancy.getTeam(scopeRef.slice(5)))?.name ?? scopeRef;
  if (scopeRef.startsWith("user:")) return (await contexts.identity.getUser(scopeRef.slice(5)))?.email ?? scopeRef;
  return scopeRef;
}
