import Link from "@web/navigation";
import { PageHeading } from "@frely/console-ui";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import type { TablePageSize } from "@frely/console-ui/pagination";
import { PlanBudgetSources } from "@frely/console-ui/plan-budget";
import { TeamDetailView } from "@frely/team-console-ui";
import { Button } from "@frely/ui/components/button";
import { TeamInviteManagement } from "../../../../features/team-invites";
import { WebTeamMemberApiKeyLimitAction, WebTeamMemberStatusAction } from "../../../../features/team-members";
import { TeamProviderManagement } from "../../../../features/team-providers";
import type { TeamDetailPageData } from "./page.server";

export default function TeamDetailPage({ data }: { data: TeamDetailPageData }) {
  if (!data.available) return <UnavailableTeam />;
  const { detail, teamId, viewerUserId, providerPage, providerModels } = data;
  return (
    <>
      <TeamDetailView
        accessLevel={detail.canUpdateMembers ? "team-admin" : detail.canReadMembers ? "team-reader" : "user"}
        team={data.projectedTeam}
        users={detail.users}
        memberTotal={detail.memberPage.total}
        membersPagination={detail.canReadMembers ? <MaterialTablePagination page={detail.memberPage.page} pageSize={detail.memberPage.pageSize} total={detail.memberPage.total} totalPages={detail.memberPage.totalPages} pageParam="memberPage" pageSizeParam="memberPageSize" previousHref={detail.memberPage.page > 1 ? teamDetailPageHref(teamId, { memberPage: detail.memberPage.page - 1, memberPageSize: detail.memberPage.pageSize, providerPage: providerPage.page, providerPageSize: providerPage.pageSize, providerModelPage: providerModels.page, providerModelPageSize: providerModels.pageSize }) : ""} nextHref={detail.memberPage.page < detail.memberPage.totalPages ? teamDetailPageHref(teamId, { memberPage: detail.memberPage.page + 1, memberPageSize: detail.memberPage.pageSize, providerPage: providerPage.page, providerPageSize: providerPage.pageSize, providerModelPage: providerModels.page, providerModelPageSize: providerModels.pageSize }) : ""} noun="members" /> : null}
        expenseSafetyChecks={[{ perspective: data.expenseSafetyPerspective, checks: data.expenseSafetyChecks }]}
        actions={<Button variant="secondary" asChild><Link href="/user/team">Back to Teams</Link></Button>}
        membersHeaderActions={data.canReadMemberPlanUsage ? <Button variant="secondary" asChild><Link href={`/user/team/${encodeURIComponent(teamId)}/usage`}>View member usage</Link></Button> : null}
        {...(data.canReadPlanBudget ? {
          budgetOverview: { activeSources: data.planBudgetSources.length, limitCount: data.limits.length, exhaustedCount: data.limits.filter((limit) => limit.exhausted).length, earliestReset: data.limits.flatMap((limit) => limit.nextResetAt ? [limit.nextResetAt] : []).sort()[0] ?? null },
          planBudget: <PlanBudgetSources sources={data.planBudgetSources} calculatedAt={data.calculatedAt} emptyTitle="No current Team Plan budget sources." />,
        } : {})}
        {...(detail.canReadMembers ? { userHref: (user) => `/user/${encodeURIComponent(user.id)}?teamId=${encodeURIComponent(teamId)}` } : {})}
        {...(detail.canUpdateMembers ? { memberActions: (user) => user.id === viewerUserId ? null : <WebTeamMemberStatusAction user={user} /> } : {})}
        {...(detail.canUpdateMembers && data.projectedTeam.canManageMemberApiKeyLimit ? { memberApiKeyLimitAction: (user) => user.id === viewerUserId ? null : <WebTeamMemberApiKeyLimitAction user={user} /> } : {})}
      />
      <TeamProviderManagement
        teamId={teamId}
        entitlementState={data.providerEntitlementState}
        canManage={data.canManageProviders}
        providers={data.providers}
        pagination={<MaterialTablePagination page={providerPage.page} pageSize={providerPage.pageSize} total={providerPage.total} totalPages={providerPage.totalPages} pageParam="providerPage" pageSizeParam="providerPageSize" previousHref={providerPage.page > 1 ? teamDetailPageHref(teamId, { memberPage: detail.memberPage.page, memberPageSize: detail.memberPage.pageSize, providerPage: providerPage.page - 1, providerPageSize: providerPage.pageSize, providerModelPage: 1, providerModelPageSize: providerModels.pageSize }) : ""} nextHref={providerPage.page < providerPage.totalPages ? teamDetailPageHref(teamId, { memberPage: detail.memberPage.page, memberPageSize: detail.memberPage.pageSize, providerPage: providerPage.page + 1, providerPageSize: providerPage.pageSize, providerModelPage: 1, providerModelPageSize: providerModels.pageSize }) : ""} noun="providers" />}
        modelPagination={<MaterialTablePagination page={providerModels.page} pageSize={providerModels.pageSize} total={providerModels.total} totalPages={providerModels.totalPages} pageParam="providerModelPage" pageSizeParam="providerModelPageSize" previousHref={providerModels.page > 1 ? teamDetailPageHref(teamId, { memberPage: detail.memberPage.page, memberPageSize: detail.memberPage.pageSize, providerPage: providerPage.page, providerPageSize: providerPage.pageSize, providerModelPage: providerModels.page - 1, providerModelPageSize: providerModels.pageSize }) : ""} nextHref={providerModels.page < providerModels.totalPages ? teamDetailPageHref(teamId, { memberPage: detail.memberPage.page, memberPageSize: detail.memberPage.pageSize, providerPage: providerPage.page, providerPageSize: providerPage.pageSize, providerModelPage: providerModels.page + 1, providerModelPageSize: providerModels.pageSize }) : ""} noun="provider models" />}
      />
      <TeamInviteManagement key={teamId} teamId={teamId} teamName={detail.availableTeam.name} viewerUserId={viewerUserId} inviteRegistrationBaseUrl={data.publicOrigin} />
    </>
  );
}

function teamDetailPageHref(teamId: string, state: { memberPage: number; memberPageSize: TablePageSize; providerPage: number; providerPageSize: TablePageSize; providerModelPage: number; providerModelPageSize: TablePageSize }) {
  const params = new URLSearchParams();
  if (state.memberPage > 1) params.set("memberPage", String(state.memberPage));
  if (state.memberPageSize !== 20) params.set("memberPageSize", String(state.memberPageSize));
  if (state.providerPage > 1) params.set("providerPage", String(state.providerPage));
  if (state.providerPageSize !== 20) params.set("providerPageSize", String(state.providerPageSize));
  if (state.providerModelPage > 1) params.set("providerModelPage", String(state.providerModelPage));
  if (state.providerModelPageSize !== 20) params.set("providerModelPageSize", String(state.providerModelPageSize));
  return `/user/team/${encodeURIComponent(teamId)}${params.size ? `?${params}` : ""}`;
}

function UnavailableTeam() {
  return <><PageHeading eyebrow="User Console" title="Team unavailable" description="This Team is unavailable or you do not have permission to view it."><Button variant="secondary" asChild><Link href="/user/team">Back to Teams</Link></Button></PageHeading><div className="notice-box notice-bad" role="alert">Select an enabled Team from your directory to continue.</div></>;
}
