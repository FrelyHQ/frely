import Link from "@admin/navigation";
import type { PlanBudgetSourceDisplay } from "@frely/console-ui/plan-budget";
import { Button } from "@frely/ui/components/button";
import type { PlanBudgetSourceData } from "./plan-budget-data";

export function adminPlanBudgetDisplaySources(
  sources: readonly PlanBudgetSourceData[],
): PlanBudgetSourceDisplay[] {
  return sources.map((source) => ({
    key: source.key,
    planName: source.planName,
    planVersion: source.planVersion,
    billingMode: source.billingMode,
    scopeLabel: source.scopeLabel,
    effectiveState: source.effectiveState,
    effectiveStart: source.effectiveStart,
    effectiveEnd: source.effectiveEnd,
    usageMode: source.usageMode,
    usageReferenceAt: source.usageReferenceAt,
    applicableModels: source.applicableModels,
    limits: source.limits,
    nextPeriodStart: source.nextPeriodStart,
    ...(source.subscriptionId === null ? {} : {
      subscriptionId: source.subscriptionId,
      actions: <>
        <Button asChild variant="secondary">
          <Link href={`/owner/plans/subscriptions/${encodeURIComponent(source.subscriptionId)}`}>
            View subscription
          </Link>
        </Button>
        <Button asChild variant="secondary"><Link href="/owner/request-logs">Request logs</Link></Button>
      </>,
    }),
    ...(source.scopeRef === null ? {} : { scopeRef: source.scopeRef }),
    ...(source.lifecycle === null ? {} : { lifecycle: source.lifecycle }),
    ...(source.source === null ? {} : { source: source.source }),
    ...(source.priority === null ? {} : { priority: source.priority }),
    ...(source.userLimitCount === null ? {} : { userLimitCount: source.userLimitCount }),
  }));
}

export function planBudgetOverview(sources: readonly PlanBudgetSourceData[]) {
  const limits = sources.flatMap((source) => source.limits);
  return {
    activeSources: sources.filter((source) => source.effectiveState === "current").length,
    limitCount: limits.length,
    exhaustedCount: limits.filter((limit) => limit.exhausted).length,
    earliestReset: limits.flatMap((limit) => limit.nextResetAt ? [limit.nextResetAt] : []).sort()[0] ?? null,
  };
}
