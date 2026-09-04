import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";
import { notFound } from "@admin/navigation";
import { currentAdminRequestId } from "@admin/server/request";
import {
  auditedPlanBudgetReadAsync,
  buildAudienceUserPlanBudgetSourcesAsync,
  CreditCursorError,
  type UiQueryPort,
} from "@frely/ui-application/server";
import { adminAudienceViewQuery, resolveAdminUserAudienceView } from "../../_components/owner-view";
import { buildOwnerUserDetailAsync } from "../../../../lib/teams";
import { adminPageServices } from "../../../../lib/server";
import { audiencePlanBudgetData } from "../../../../features/plans/lib/plan-budget-data";
import { adminPlanBudgetDataSourcesAsync } from "../../../../features/plans/lib/plan-budget-presenter.server";
import { loadUserAudienceAsync, loadUserCreditAudienceAsync } from "@frely/tenancy/audience-server";
import { ownerUserIdentityPageData } from "./page-data";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const params = Promise.resolve(request.params);
  const searchParams = Promise.resolve(request.search);
  const { userId } = await params;
  if (!userId) notFound();
  const resolvedSearchParams = await searchParams;
  const view = resolveAdminUserAudienceView(resolvedSearchParams?.view);
  const viewQuery = adminAudienceViewQuery(view);
  const admin = await adminPageServices();
  if (!admin) return null;
  const { claims, application, asyncTenancy } = admin;
  const requestedKeyPage = positivePage(singleValue(resolvedSearchParams?.keyPage));
  const requestedKeyPageSize = normalizeTablePageSize(resolvedSearchParams?.keyPageSize);
  const adminDetail = view === "owner"
    ? await buildOwnerUserDetailAsync(application.queries, { identity: asyncTenancy.identity, authority: asyncTenancy.authority, tenancy: asyncTenancy.tenancy }, userId, { apiKeyPage: requestedKeyPage, apiKeyPageSize: requestedKeyPageSize })
    : null;
  const audience = await loadUserAudienceAsync({
        repo: application.queries,
        identity: asyncTenancy.identity,
        tenancy: asyncTenancy.tenancy,
        viewerUserId: userId,
        targetUserId: userId,
        apiKeyPage: requestedKeyPage,
        apiKeyPageSize: requestedKeyPageSize,
      });
  if (!audience?.apiKeys) notFound();
  let identityData = { senderUserId: claims.sub, rawUserStatus: null as string | null };
  if (view === "owner") {
    if (!adminDetail) notFound();
    const rawUser = await asyncTenancy.identity.getUser(userId);
    if (!rawUser) notFound();
    identityData = ownerUserIdentityPageData(claims, rawUser);
  }
  const displayUser = adminDetail?.user ?? audience.user;
  const displayApiKeyPage = adminDetail?.apiKeyPage ?? audience.apiKeys;
  const requestedTopupCursor = singleValue(resolvedSearchParams?.topupCursor).slice(0, 1000);
  const requestedLedgerCursor = singleValue(resolvedSearchParams?.ledgerCursor).slice(0, 1000);
  const requestedCatalogPage = positivePage(singleValue(resolvedSearchParams?.catalogPage));
  const requestedTopupPageSize = normalizeTablePageSize(resolvedSearchParams?.topupPageSize);
  const requestedLedgerPageSize = normalizeTablePageSize(resolvedSearchParams?.ledgerPageSize);
  const requestedCatalogPageSize = normalizeTablePageSize(resolvedSearchParams?.catalogPageSize);
  const userTopupPage = view === "owner"
    ? await safeUserTopupPageAsync(application.billingQueries, userId, requestedTopupCursor, requestedTopupPageSize)
    : { items: [], nextCursor: null };
  const calculatedAt = new Date().toISOString();
  const creditAudience = view === "user"
    ? await loadUserCreditAudienceAsync({
          repo: application.queries,
          identity: asyncTenancy.identity,
          userId,
          topupCursor: requestedTopupCursor,
          topupPageSize: requestedTopupPageSize,
          ledgerCursor: requestedLedgerCursor,
          ledgerPageSize: requestedLedgerPageSize,
          catalogPage: requestedCatalogPage,
          catalogPageSize: requestedCatalogPageSize,
        })
    : null;
  const planBudgetSources = await auditedPlanBudgetReadAsync(application.audit, {
        actor: { actorType: "user", actorId: claims.sub }, source: "owner", requestId: currentAdminRequestId(),
        resource: { resourceType: "user", resourceId: userId },
        metadata: { routePattern: "/owner/users/:userId", targetUserId: userId, perspective: view },
      }, async () => view === "owner"
        ? adminPlanBudgetDataSourcesAsync(asyncTenancy, await application.queries.listPlanSubscriptionBudgetUsage(
            (await application.queries.listActiveSubscriptionsForUser(userId, calculatedAt)).map((source) => source.subscription.id),
            userId,
            calculatedAt,
          ))
        : audiencePlanBudgetData(await buildAudienceUserPlanBudgetSourcesAsync(application.queries, userId, calculatedAt)));
  return { userId, view, viewQuery, ...identityData, adminDetail, audience, displayUser, displayApiKeyPage, requestedTopupCursor, requestedTopupPageSize, userTopupPage, calculatedAt, creditAudience, planBudgetSources };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

async function safeUserTopupPageAsync(billingQueries: Pick<UiQueryPort, "cursorAdminTopups">, userId: string, cursor: string, pageSize: TablePageSize) {
  try {
    return await billingQueries.cursorAdminTopups(cursor || undefined, userId, undefined, pageSize);
  } catch (error) {
    if (error instanceof CreditCursorError) return billingQueries.cursorAdminTopups(undefined, userId, undefined, pageSize);
    throw error;
  }
}


function positivePage(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 1;
}


function singleValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
