import { auditedPlanBudgetReadAsync } from "@frely/ui-application/server";
import { currentAdminRequestId } from "@admin/server/request";
import { adminPageServices } from "../../../../lib/server";
import { parseSubscriptionSearch, readSubscriptionOverview, readSubscriptionOverviewAsync } from "../../../../features/plans/subscriptions/query";
import { SubscriptionsOverview } from "../../../../features/plans/subscriptions/subscriptions-overview";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const state = parseSubscriptionSearch(await searchParams);
  const at = new Date().toISOString();
  const auditContext = {
    actor: { actorType: "user", actorId: admin.claims.sub }, source: "owner", requestId: currentAdminRequestId(),
    resource: { resourceType: "plan_subscription", resourceId: "list" },
    metadata: { routePattern: "/owner/plans/subscriptions" }
  } as const;
  const result = await auditedPlanBudgetReadAsync(admin.application.audit, auditContext, () => readSubscriptionOverviewAsync(admin.application.queries, state, at));
  const sources = await admin.application.queries.listPlanSubscriptionSources();
  return { state, result, sources };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
