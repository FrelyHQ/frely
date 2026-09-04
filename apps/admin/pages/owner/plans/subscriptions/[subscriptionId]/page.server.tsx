import { notFound } from "@admin/navigation";
import { currentAdminRequestId } from "@admin/server/request";
import { RelayError } from "@frely/core";
import { auditedPlanBudgetReadAsync } from "@frely/ui-application/server";
import { adminPageServices } from "../../../../../lib/server";
import { readSubscriptionDetailAsync } from "../../../../../features/plans/subscriptions/query";
import type { AdminPageRequest } from "../../../../../src/page-request";

export async function loadPage(request: AdminPageRequest) {
  const admin = await adminPageServices();
  if (!admin) return null;
  const subscriptionId = request.params.subscriptionId;
  if (!subscriptionId) notFound();
  const targetValue = request.search.targetUserId;
  const targetUserId = (Array.isArray(targetValue) ? targetValue[0] : targetValue)?.trim().slice(0, 160) ?? "";
  const at = new Date().toISOString();
  try {
    const auditContext = {
      actor: { actorType: "user", actorId: admin.claims.sub }, source: "owner", requestId: currentAdminRequestId(),
      resource: { resourceType: "plan_subscription", resourceId: subscriptionId },
      metadata: { routePattern: "/owner/plans/subscriptions/[subscriptionId]", subscriptionId, ...(targetUserId ? { targetUserId } : {}) }
    } as const;
    return await auditedPlanBudgetReadAsync(
      admin.application.audit,
      auditContext,
      () => readSubscriptionDetailAsync(admin.application.queries, admin.asyncTenancy.identity, subscriptionId, targetUserId, at),
    );
  } catch (error) {
    if (error instanceof RelayError && error.code === "plan_subscription_not_found") notFound();
    throw error;
  }
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
