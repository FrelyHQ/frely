import { UserApiKeysDetail, UserAudienceDetail, UserCreditAudienceView } from "@frely/console-ui";
import { CreditTopupExperience } from "@frely/console-ui/credit-topup";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import type { TablePageSize } from "@frely/console-ui/pagination";
import Link from "@admin/navigation";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { PlanBudgetSources } from "@frely/console-ui/plan-budget";
import { resolveAdminUserAudienceView } from "../../_components/owner-view";
import { AdminViewSwitcher } from "../../_components/owner-view-switcher";
import { CreditAdjustmentForm, CreditTopups } from "../../../../features/credits";
import { AdminCardForm, AdminRoleBindings, UserAdminNoteForm } from "../../../../features/users";
import { AdminApiKeyCreateAction } from "../../../../features/api-keys";
import { adminPlanBudgetDisplaySources } from "../../../../features/plans/lib/plan-budget-presenter";
import type { AdminPageData } from "./page.server";

export default function OwnerUserDetailPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { userId, view, viewQuery, senderUserId, adminDetail, audience, displayUser, displayApiKeyPage, rawUserStatus, requestedTopupCursor, requestedTopupPageSize, userTopupPage, calculatedAt, creditAudience, planBudgetSources } = loaded;
  const ownerDetail = view === "owner" ? adminDetail : null;
  const planBudgetDisplaySources = adminPlanBudgetDisplaySources(planBudgetSources);
  const apiKeyPagination = <MaterialTablePagination
    page={displayApiKeyPage.page}
    pageSize={displayApiKeyPage.pageSize}
    total={displayApiKeyPage.total}
    totalPages={displayApiKeyPage.totalPages}
    pageParam="keyPage"
    pageSizeParam="keyPageSize"
    previousHref={displayApiKeyPage.page > 1 ? userApiKeyPageHref(displayUser.id, view, displayApiKeyPage.page - 1, displayApiKeyPage.pageSize, requestedTopupCursor, requestedTopupPageSize) : ""}
    nextHref={displayApiKeyPage.page < displayApiKeyPage.totalPages ? userApiKeyPageHref(displayUser.id, view, displayApiKeyPage.page + 1, displayApiKeyPage.pageSize, requestedTopupCursor, requestedTopupPageSize) : ""}
    noun="API keys"
  />;
  return (
    <>
    {ownerDetail ? <UserApiKeysDetail
      user={ownerDetail.user}
      apiKeys={ownerDetail.apiKeys}
      backHref="/owner/teams"
      backLabel="Back to Teams"
      eyebrow="Owner / User Details"
      audienceControl={<AdminViewSwitcher view={view} audience="user" />}
      actions={
        <AdminApiKeyCreateAction
          user={ownerDetail.user}
          detailHrefBase={`/owner/users/${ownerDetail.user.id}/api-keys/`}
        />
      }
      apiKeyHref={(apiKey) => `/owner/users/${ownerDetail.user.id}/api-keys/${apiKey.id}${viewQuery}`}
      apiKeySummary={ownerDetail.apiKeySummary}
      apiKeyPagination={apiKeyPagination}
      credit={ownerDetail.credit}
      creditActions={<CreditAdjustmentForm scopeRef={`user:${ownerDetail.user.id}`} />}
    /> : <UserAudienceDetail
      model={audience}
      backHref="/owner/teams"
      backLabel="Back to Teams"
      eyebrow="Owner / User Details"
      audienceControl={<AdminViewSwitcher view={view} audience="user" />}
      actions={<Button asChild variant="secondary"><Link href={`/owner/users/${encodeURIComponent(audience.user.id)}/request-history`}>Request history</Link></Button>}
      apiKeyHref={(apiKey) => `/owner/users/${audience.user.id}/api-keys/${apiKey.id}${viewQuery}`}
      apiKeyPagination={apiKeyPagination}
    />}
    <PlanBudgetSources sources={planBudgetDisplaySources} calculatedAt={calculatedAt} emptyTitle="No current Plan budget sources are available to this user." />
    {ownerDetail ? <Card className="panel">
      <div className="panel-heading">
        <div>
          <h2>Credit Topups</h2>
          <p className="muted">Topup history and review actions for this user.</p>
        </div>
      </div>
      <CreditTopups topups={userTopupPage.items} />
      <MaterialTablePagination
        page={1}
        pageSize={requestedTopupPageSize}
        pageSizeParam="topupPageSize"
        resetParams={["topupCursor"]}
        total={userTopupPage.items.length}
        totalMode="unknown"
        totalPages={1}
        nextHref={userTopupPage.nextCursor ? userTopupHref(displayUser.id, view, userTopupPage.nextCursor, requestedTopupPageSize) : ""}
        noun="topups"
      />
    </Card> : null}
    {creditAudience ? <UserCreditAudienceView
      model={creditAudience}
      audienceControl={<AdminViewSwitcher view={view} audience="user" />}
      topupExperience={<CreditTopupExperience
        listings={creditAudience.catalog.listings}
        topups={creditAudience.topups.items}
        interactionMode="preview"
        historyPagination={<MaterialTablePagination
          page={1}
          pageSize={creditAudience.topups.pageSize}
          pageSizeParam="topupPageSize"
          resetParams={["topupCursor"]}
          total={creditAudience.topups.items.length}
          totalMode="unknown"
          totalPages={1}
          nextHref={creditAudience.topups.nextCursor ? userCreditPreviewHref(userId, {
            topupCursor: creditAudience.topups.nextCursor,
            topupPageSize: creditAudience.topups.pageSize,
            ledgerCursor: creditAudience.ledger.acceptedCursor,
            ledgerPageSize: creditAudience.ledger.pageSize,
            catalogPage: creditAudience.catalog.page,
            catalogPageSize: creditAudience.catalog.pageSize,
          }) : ""}
          noun="topup requests"
        />}
      />}
      ledgerPagination={<MaterialTablePagination
        page={1}
        pageSize={creditAudience.ledger.pageSize}
        pageSizeParam="ledgerPageSize"
        resetParams={["ledgerCursor"]}
        total={creditAudience.ledger.items.length}
        totalMode="unknown"
        totalPages={1}
        nextHref={creditAudience.ledger.nextCursor ? userCreditPreviewHref(userId, {
          topupCursor: creditAudience.topups.acceptedCursor,
          topupPageSize: creditAudience.topups.pageSize,
          ledgerCursor: creditAudience.ledger.nextCursor,
          ledgerPageSize: creditAudience.ledger.pageSize,
          catalogPage: creditAudience.catalog.page,
          catalogPageSize: creditAudience.catalog.pageSize,
        }) : ""}
        noun="ledger events"
      />}
      catalogPagination={<MaterialTablePagination
        page={creditAudience.catalog.page}
        pageSize={creditAudience.catalog.pageSize}
        total={creditAudience.catalog.total}
        totalPages={creditAudience.catalog.totalPages}
        pageParam="catalogPage"
        pageSizeParam="catalogPageSize"
        previousHref={creditAudience.catalog.page > 1 ? userCreditPreviewHref(userId, {
          topupCursor: creditAudience.topups.acceptedCursor,
          topupPageSize: creditAudience.topups.pageSize,
          ledgerCursor: creditAudience.ledger.acceptedCursor,
          ledgerPageSize: creditAudience.ledger.pageSize,
          catalogPage: creditAudience.catalog.page - 1,
          catalogPageSize: creditAudience.catalog.pageSize,
        }) : ""}
        nextHref={creditAudience.catalog.page < creditAudience.catalog.totalPages ? userCreditPreviewHref(userId, {
          topupCursor: creditAudience.topups.acceptedCursor,
          topupPageSize: creditAudience.topups.pageSize,
          ledgerCursor: creditAudience.ledger.acceptedCursor,
          ledgerPageSize: creditAudience.ledger.pageSize,
          catalogPage: creditAudience.catalog.page + 1,
          catalogPageSize: creditAudience.catalog.pageSize,
        }) : ""}
        noun="credit products"
      />}
    /> : null}
    {ownerDetail && rawUserStatus ? <AdminCardForm recipient={{ id: ownerDetail.user.id, email: ownerDetail.user.email, status: rawUserStatus }} senderUserId={senderUserId} /> : null}
    {ownerDetail ? <AdminRoleBindings roleDetails={ownerDetail.user.roleDetails} isPlatformOwner={ownerDetail.user.isPlatformOwner} /> : null}
    {ownerDetail ? <UserAdminNoteForm userId={ownerDetail.user.id} initialAdminNote={ownerDetail.user.adminNote} /> : null}
    </>
  );
}

function userTopupHref(userId: string, view: ReturnType<typeof resolveAdminUserAudienceView>, cursor: string, pageSize: TablePageSize) {
  const params = new URLSearchParams();
  if (view !== "owner") params.set("view", view);
  params.set("topupCursor", cursor);
  if (pageSize !== 20) params.set("topupPageSize", String(pageSize));
  return `/owner/users/${encodeURIComponent(userId)}?${params}`;
}


function userApiKeyPageHref(userId: string, view: ReturnType<typeof resolveAdminUserAudienceView>, page: number, pageSize: TablePageSize, topupCursor: string, topupPageSize: TablePageSize) {
  const params = new URLSearchParams();
  if (view !== "owner") params.set("view", view);
  if (page > 1) params.set("keyPage", String(page));
  if (pageSize !== 20) params.set("keyPageSize", String(pageSize));
  if (topupCursor) params.set("topupCursor", topupCursor);
  if (topupPageSize !== 20) params.set("topupPageSize", String(topupPageSize));
  const query = params.toString();
  return `/owner/users/${encodeURIComponent(userId)}${query ? `?${query}` : ""}`;
}


function userCreditPreviewHref(userId: string, state: {
  topupCursor: string;
  topupPageSize: TablePageSize;
  ledgerCursor: string;
  ledgerPageSize: TablePageSize;
  catalogPage: number;
  catalogPageSize: TablePageSize;
}) {
  const params = new URLSearchParams({ view: "user" });
  if (state.topupCursor) params.set("topupCursor", state.topupCursor);
  if (state.topupPageSize !== 20) params.set("topupPageSize", String(state.topupPageSize));
  if (state.ledgerCursor) params.set("ledgerCursor", state.ledgerCursor);
  if (state.ledgerPageSize !== 20) params.set("ledgerPageSize", String(state.ledgerPageSize));
  if (state.catalogPage > 1) params.set("catalogPage", String(state.catalogPage));
  if (state.catalogPageSize !== 20) params.set("catalogPageSize", String(state.catalogPageSize));
  return `/owner/users/${encodeURIComponent(userId)}?${params}`;
}
