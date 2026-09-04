import {
  TeamDetailView,
  type TeamPlanStatusFilter,
} from "@frely/team-console-ui";
import { TeamInviteManagement } from "@frely/team-console-ui/client";
import { PlanBudgetSources } from "@frely/console-ui/plan-budget";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";
import { Button } from "@frely/ui/components/button";
import Link from "@admin/navigation";
import { AdminViewSwitcher } from "../../_components/owner-view-switcher";
import { SearchSelect } from "../../_components/search-select";
import { AdminTeamInviteManagement, DeleteTeamControl, RemoveTeamMemberButton, TeamMemberPermissionAction, TeamPermissionManagementControl, TeamProviderEntitlementManagement, TeamUsersManagementControl } from "../../../../features/teams";
import { adminPlanBudgetDisplaySources, planBudgetOverview } from "../../../../features/plans/lib/plan-budget-presenter";
import type { AdminPageData } from "./page.server";

export default function TeamDetailPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { teamId, rawSearch, view, planStatus, viewQuery, inviteRegistrationBaseUrl, detail, previewMemberId, teamAudience, renderedTeam, renderedUsers, renderedMemberPage, membershipRoles, permissions, deleteBlockers, calculatedAt, invitePage, inviteModel, expenseSafetyChecks, canReadAudiencePlanBudget, planBudgetSources, providerEntitlementState, providerEntitlementHistory } = loaded;
  const planBudgetDisplaySources = adminPlanBudgetDisplaySources(planBudgetSources);
  const invitePagination = inviteModel
    ? <DetailPagination noun="invite links" pageParam="invitePage" pageSizeParam="invitePageSize" metadata={invitePage} href={(page) => detailHref(teamId, view, rawSearch, "invitePage", page)} />
    : null;
  return (
    <>
      <TeamDetailView
      accessLevel={view === "owner"
        ? "owner"
        : teamAudience?.capabilities.canUpdateMembers
          ? "team-admin"
          : teamAudience?.capabilities.canReadMembers
            ? "team-reader"
            : "user"}
      team={renderedTeam}
      users={renderedUsers}
      memberTotal={renderedMemberPage.total}
      membersPagination={(view === "owner" || teamAudience?.capabilities.canReadMembers)
        ? <DetailPagination noun="users" pageParam="userPage" pageSizeParam="userPageSize" metadata={renderedMemberPage} href={(page) => detailHref(teamId, view, rawSearch, "userPage", page)} />
        : null}
      expenseSafetyChecks={expenseSafetyChecks}
      accessPoints={view === "owner" ? detail.accessPoints : []}
      accessPointTotal={view === "owner" ? detail.pages.accessPoints.total : 0}
      accessPointsPagination={view === "owner" ? <DetailPagination noun="access points" pageParam="accessPointPage" pageSizeParam="accessPointPageSize" metadata={detail.pages.accessPoints} href={(page) => detailHref(teamId, view, rawSearch, "accessPointPage", page)} /> : null}
      plans={view === "owner" ? detail.plans : []}
      planTotal={view === "owner" ? detail.pages.plans.total : 0}
      planStatusFilter={planStatus}
      plansFilter={view === "owner" ? <TeamPlansFilter teamId={teamId} current={rawSearch} value={planStatus} /> : null}
      plansPagination={view === "owner" ? <DetailPagination noun="plans" pageParam="planPage" pageSizeParam="planPageSize" metadata={detail.pages.plans} href={(page) => detailHref(teamId, view, rawSearch, "planPage", page)} /> : null}
      {...(view === "owner" ? { userHref: (user: (typeof detail.users)[number]) => `/owner/users/${user.id}${viewQuery}` } : {})}
      audienceControl={<AdminViewSwitcher
        view={view}
        audience="team"
        memberId={previewMemberId ?? ""}
        memberOptions={detail.users
          .filter((member) => member.id !== detail.team.ownerId)
          .map((member) => ({ value: member.id, label: member.email, description: member.role }))}
      />}
      planActions={view === "owner" ? <Button asChild><Link href={`/owner/plans/subscriptions?scopeRef=${encodeURIComponent(`team:${teamId}`)}`}>Manage subscriptions</Link></Button> : null}
      membersHeaderActions={view === "owner" ? <><TeamPermissionManagementControl teamId={detail.team.id} members={membershipRoles} permissions={permissions} /><TeamUsersManagementControl teamId={detail.team.id} ownerId={detail.team.ownerId} members={detail.users} /></> : null}
      memberActions={view === "owner" ? (user) => <><TeamMemberPermissionAction teamId={detail.team.id} member={membershipRoles.find((member) => member.userId === user.id) ?? { userId: user.id, email: user.email, roles: ["viewer"] }} ownerId={detail.team.ownerId} permissions={permissions} /><RemoveTeamMemberButton teamId={detail.team.id} ownerId={detail.team.ownerId} user={user} /></> : undefined}
      dangerZone={view === "owner" ? <DeleteTeamControl team={detail.team} blockers={deleteBlockers} deletionLifecycle={detail.team.deletionLifecycle} /> : null}
      {...(view === "owner" || canReadAudiencePlanBudget ? {
        budgetOverview: planBudgetOverview(planBudgetSources),
        planBudget: <PlanBudgetSources sources={planBudgetDisplaySources} calculatedAt={calculatedAt} emptyTitle="No current Team Plan subscriptions." />,
      } : {})}
      actions={
        <>
          <Button variant="secondary" asChild>
            <Link href="/owner/teams">Back to Teams</Link>
          </Button>
        </>
      }
      />
      {view === "owner" ? <TeamProviderEntitlementManagement
        teamId={teamId}
        state={providerEntitlementState.state}
        history={providerEntitlementHistory.items}
        nextCursor={providerEntitlementHistory.nextCursor}
        olderHref={providerEntitlementHistory.nextCursor ? entitlementHistoryHref(teamId, providerEntitlementHistory.nextCursor, providerEntitlementHistory.pageSize) : null}
        pagination={<MaterialTablePagination
          page={1}
          pageSize={providerEntitlementHistory.pageSize}
          pageSizeParam="entitlementPageSize"
          resetParams={["entitlementCursor"]}
          total={providerEntitlementHistory.items.length}
          totalMode="unknown"
          totalPages={1}
          nextHref={providerEntitlementHistory.nextCursor ? entitlementHistoryHref(teamId, providerEntitlementHistory.nextCursor, providerEntitlementHistory.pageSize) : ""}
          noun="entitlement events"
        />}
      /> : null}
      {inviteModel ? view === "owner" ? (
        <AdminTeamInviteManagement
          model={inviteModel}
          inviteRegistrationBaseUrl={inviteRegistrationBaseUrl}
          pagination={invitePagination}
        />
      ) : (
        <TeamInviteManagement
          state={{ status: "ready", model: inviteModel }}
          interactionMode="preview"
          inviteRegistrationBaseUrl={inviteRegistrationBaseUrl}
          pagination={invitePagination}
        />
      ) : (
        <TeamInviteManagement
          state={{ status: "error", message: "No concrete Team member is available for invitation preview." }}
          interactionMode="preview"
          inviteRegistrationBaseUrl={inviteRegistrationBaseUrl}
        />
      )}
    </>
  );
}

function positivePage(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}


function singleValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}


function teamPlanStatusFilter(value: string | string[] | undefined): TeamPlanStatusFilter {
  const status = singleValue(value);
  return status === "all" || status === "closed" || status === "disabled" ? status : "enabled";
}


function detailHref(
  teamId: string,
  view: "owner" | "teamOwner" | "user",
  current: Record<string, string | string[] | undefined>,
  key: "userPage" | "accessPointPage" | "planPage" | "invitePage",
  page: number,
  planStatusOverride?: TeamPlanStatusFilter,
) {
  const params = new URLSearchParams();
  if (view !== "owner") params.set("view", view);
  for (const currentKey of ["userPage", "accessPointPage", "planPage", "invitePage"] as const) {
    const nextPage = currentKey === key ? page : positivePage(current?.[currentKey]);
    if (nextPage > 1) params.set(currentKey, String(nextPage));
  }
  for (const sizeKey of ["userPageSize", "accessPointPageSize", "planPageSize", "invitePageSize"] as const) {
    const pageSize = normalizeTablePageSize(current?.[sizeKey]);
    if (pageSize !== 20) params.set(sizeKey, String(pageSize));
  }
  const memberId = singleValue(current?.memberId).slice(0, 200);
  if (memberId) params.set("memberId", memberId);
  const planStatus = planStatusOverride ?? teamPlanStatusFilter(current?.planStatus);
  if (planStatus !== "enabled") params.set("planStatus", planStatus);
  const query = params.toString();
  return `/owner/teams/${encodeURIComponent(teamId)}${query ? `?${query}` : ""}`;
}


function entitlementHistoryHref(teamId: string, cursor: string, pageSize: TablePageSize) {
  const params = new URLSearchParams();
  params.set("entitlementCursor", cursor);
  if (pageSize !== 20) params.set("entitlementPageSize", String(pageSize));
  return `/owner/teams/${encodeURIComponent(teamId)}?${params}`;
}


function TeamPlansFilter({
  teamId,
  current,
  value,
}: {
  teamId: string;
  current: Record<string, string | string[] | undefined>;
  value: TeamPlanStatusFilter;
}) {
  return <form className="compact-filter-bar" action={`/owner/teams/${encodeURIComponent(teamId)}`}>
    {(["userPage", "accessPointPage", "invitePage"] as const).map((key) => {
      const page = positivePage(current?.[key]);
      return page > 1 ? <input key={key} type="hidden" name={key} value={page} /> : null;
    })}
    {(["userPageSize", "accessPointPageSize", "planPageSize", "invitePageSize"] as const).map((key) => {
      const pageSize = normalizeTablePageSize(current?.[key]);
      return pageSize !== 20 ? <input key={key} type="hidden" name={key} value={pageSize} /> : null;
    })}
    {singleValue(current?.memberId).slice(0, 200) ? <input type="hidden" name="memberId" value={singleValue(current?.memberId).slice(0, 200)} /> : null}
    <label className="compact-filter-field" data-size="status">
      Plan status
      <SearchSelect
        name="planStatus"
        defaultValue={value}
        searchable={false}
        options={[
          { value: "enabled", label: "Enabled (default)" },
          { value: "all", label: "All statuses" },
          { value: "closed", label: "Closed" },
          { value: "disabled", label: "Disabled" },
        ]}
      />
    </label>
    <Button type="submit" size="sm" variant="secondary">Apply</Button>
    {value !== "enabled" ? <Button asChild size="sm" variant="ghost"><Link href={detailHref(teamId, "owner", current, "planPage", 1, "enabled")}>Reset</Link></Button> : null}
  </form>;
}


function DetailPagination({
  noun,
  pageParam,
  pageSizeParam,
  metadata,
  href,
}: {
  noun: string;
  pageParam: string;
  pageSizeParam: string;
  metadata: { page: number; pageSize: number; total: number; totalPages: number };
  href: (page: number) => string;
}) {
  return <MaterialTablePagination
    page={metadata.page}
    pageSize={metadata.pageSize}
    total={metadata.total}
    totalPages={metadata.totalPages}
    pageParam={pageParam}
    pageSizeParam={pageSizeParam}
    rangeStart={metadata.total ? (metadata.page - 1) * metadata.pageSize + 1 : 0}
    rangeEnd={Math.min(metadata.page * metadata.pageSize, metadata.total)}
    previousHref={metadata.page > 1 ? href(metadata.page - 1) : ""}
    nextHref={metadata.page < metadata.totalPages ? href(metadata.page + 1) : ""}
    noun={noun}
  />;
}
