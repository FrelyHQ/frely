import { auditedPlanBudgetReadAsync, buildAudienceUserPlanBudgetSourcesAsync } from "@frely/ui-application/server";
import { requireWebUserPage } from "../../../../lib/web-page";

export async function loadPage() {
  const { services, claims, view } = await requireWebUserPage("/user/plans-and-budgets/budget");
  const at = new Date().toISOString();
  const auditContext = {
    actor: { actorType: "user" as const, actorId: claims.sub }, source: "web" as const, requestId: crypto.randomUUID(),
    resource: { resourceType: "plan_budget", resourceId: "self" }, metadata: { routePattern: "/user/plans-and-budgets/budget" },
  };
  const sources = await auditedPlanBudgetReadAsync(services.application.audit, auditContext, () => buildAudienceUserPlanBudgetSourcesAsync(services.application.queries, claims.sub, at));
  const limits = sources.flatMap((source) => source.limits);
  const exhausted = limits.filter((limit) => limit.exhausted).length;
  const earliestReset = limits.flatMap((limit) => limit.nextResetAt ? [limit.nextResetAt] : []).sort()[0] ?? null;
  return { sources, calculatedAt: at, exhausted, earliestReset, calculatedCost: view.userUsage.calculatedCost };
}

export type UserBudgetPageData = Awaited<ReturnType<typeof loadPage>>;
