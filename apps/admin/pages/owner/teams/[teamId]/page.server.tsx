import type { TeamPlanStatusFilter } from "@frely/team-console-ui";
import { buildTeamInviteAudienceViewModel } from "@frely/team-console-ui/models";
import {
  auditSuccessAsync,
  auditedPlanBudgetReadAsync,
  buildAudienceUserPlanBudgetSourcesAsync,
} from "@frely/ui-application/server";
import { buildTeamExpenseSafetyChecksAsync, loadTeamAudienceAsync } from "@frely/tenancy/audience-server";
import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { notFound } from "@admin/navigation";
import { currentAdminRequestId } from "@admin/server/request";
import { adminAudienceViewQuery, resolveAdminAudienceView } from "../../_components/owner-view";
import { buildAdminTeamDetailAsync, type AdminTeamRow } from "../../../../lib/teams";
import { adminPageServices } from "../../../../lib/server";
import { audiencePlanBudgetData } from "../../../../features/plans/lib/plan-budget-data";
import { adminPlanBudgetDataSourcesAsync } from "../../../../features/plans/lib/plan-budget-presenter.server";
import {
  teamDetailBoundaryData,
  teamProviderEntitlementHistoryData,
} from "./page-data";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const params = Promise.resolve(request.params);
  const searchParams = Promise.resolve(request.search);
  const { teamId } = await params;
  if (!teamId) notFound();
  const rawSearch = await searchParams;
  const view = resolveAdminAudienceView(rawSearch?.view);
  const requestedMemberId = singleValue(rawSearch?.memberId).slice(0, 200);
  const planStatus = teamPlanStatusFilter(rawSearch?.planStatus);
  const viewQuery = adminAudienceViewQuery(view);
  const admin = await adminPageServices();
  if (!admin) return null;
  const { config, claims, asyncTenancy, authorityEntitlement, application} = admin;
  const detailInput = {
    userPage: positivePage(rawSearch?.userPage),
    userPageSize: normalizeTablePageSize(rawSearch?.userPageSize),
    accessPointPage: positivePage(rawSearch?.accessPointPage),
    accessPointPageSize: normalizeTablePageSize(rawSearch?.accessPointPageSize),
    planPage: positivePage(rawSearch?.planPage),
    planPageSize: normalizeTablePageSize(rawSearch?.planPageSize),
    planStatus,
    ...(view === "user" && requestedMemberId ? { audienceMemberId: requestedMemberId } : {}),
  };
  const detail = await buildAdminTeamDetailAsync(application.queries, { identity: asyncTenancy.identity, authority: asyncTenancy.authority, tenancy: asyncTenancy.tenancy }, teamId, detailInput);
  if (!detail) notFound();
  const selectedMember = requestedMemberId && requestedMemberId !== detail.team.ownerId
    ? await application.queries.getTeamMemberSummary(teamId, requestedMemberId)
    : undefined;
  const previewMemberId = selectedMember?.id ?? null;
  const previewViewerUserId = view === "teamOwner"
    ? detail.team.ownerId
    : view === "user"
      ? previewMemberId
      : null;
  const teamAudience = previewViewerUserId
    ? await loadTeamAudienceAsync({
          repo: application.queries,
          identity: asyncTenancy.identity,
          tenancy: asyncTenancy.tenancy,
          teamId,
          viewerUserId: previewViewerUserId,
          memberPage: positivePage(rawSearch?.userPage),
          memberPageSize: normalizeTablePageSize(rawSearch?.userPageSize),
          hasPermission: (resourceId, action) => asyncTenancy.hasPermission(previewViewerUserId, { resourceType: "team", resourceId, action }),
        })
    : null;
  const renderedTeam = view === "owner" ? detail.team : teamAudience?.team ?? restrictedTeamPreview(detail.team);
  const renderedUsers = view === "owner" ? detail.users : teamAudience?.members?.items ?? [];
  const renderedMemberPage = view === "owner"
    ? detail.pages.users
    : teamAudience?.members ?? { page: 1, pageSize: normalizeTablePageSize(rawSearch?.userPageSize), total: 0, totalPages: 1 };
  const membershipRoles = detail.membershipRoles;
  const rawPermissions = view === "owner"
    ? await application.queries.listDirectPermissionsForSubjects("team", detail.team.id, membershipRoles.map((member) => member.userId))
    : [];
  const permissions = rawPermissions.map((permission) => ({
    id: permission.id,
    action: permission.action,
    subjectType: permission.subjectType,
    subjectRef: permission.subjectRef,
    subjectRole: permission.subjectRole,
    status: permission.status
  }));
  const deleteBlockers = detail.team.deleteBlockers;
  const calculatedAt = new Date().toISOString();
  const inviteViewerUserId = view === "owner" ? claims.sub : previewViewerUserId;
  const inviteSettings = inviteViewerUserId
    ? await asyncTenancy.getTeamInviteSettings(detail.team.id, inviteViewerUserId, { allowPlatformOwner: view === "owner" })
    : null;
  const invitePage = inviteViewerUserId && inviteSettings
    ? await application.queries.pageTeamInviteLinks(detail.team.id, {
          ...(inviteSettings.capabilities.canManageAllInviteLinks ? {} : { createdByUserId: inviteViewerUserId }),
          page: positivePage(rawSearch?.invitePage),
          pageSize: normalizeTablePageSize(rawSearch?.invitePageSize),
        })
    : { items: [], page: 1, pageSize: normalizeTablePageSize(rawSearch?.invitePageSize), total: 0, totalPages: 1 };
  const inviteModel = inviteViewerUserId && inviteSettings
    ? buildTeamInviteAudienceViewModel({
        viewerUserId: inviteViewerUserId,
        perspective: view === "owner" ? "platformOwner" : view === "teamOwner" ? "teamOwner" : "member",
        team: { id: detail.team.id, name: detail.team.name },
        settings: inviteSettings,
        links: invitePage,
        calculatedAt,
      })
    : null;
  const memberExpenseSafetyInput = {
    teamId,
    perspective: "member" as const,
    ...(previewMemberId ? { memberUserId: previewMemberId } : {}),
    calculatedAt
  };
  const teamOwnerExpenseSafetyChecks = await buildTeamExpenseSafetyChecksAsync(application.queries, asyncTenancy.tenancy, { teamId, perspective: "teamOwner", calculatedAt });
  const memberExpenseSafetyChecks = await buildTeamExpenseSafetyChecksAsync(application.queries, asyncTenancy.tenancy, memberExpenseSafetyInput);
  const expenseSafetyChecks = view === "teamOwner"
    ? [{ perspective: "teamOwner" as const, checks: teamOwnerExpenseSafetyChecks }]
    : view === "user"
      ? [{ perspective: "member" as const, checks: memberExpenseSafetyChecks }]
      : [
          { perspective: "teamOwner" as const, checks: teamOwnerExpenseSafetyChecks },
          { perspective: "member" as const, checks: memberExpenseSafetyChecks }
        ];
  const expenseSafetyCheckRows = expenseSafetyChecks.flatMap((group) => group.checks);
  const expenseSafetyAudit = {
    actor: { actorType: "user", actorId: claims.sub }, source: "owner", requestId: currentAdminRequestId(),
    action: "team.expense_safety_check.read", resource: { resourceType: "team", resourceId: teamId },
    metadata: { teamId, perspective: view, checkCodes: [...new Set(expenseSafetyCheckRows.map((check) => check.code))], checkCount: expenseSafetyCheckRows.length, calculatedAt, routePattern: "/owner/teams/:teamId" }
  } as const;
  await auditSuccessAsync(application.audit, expenseSafetyAudit);
  const budgetViewerUserId = previewViewerUserId;
  const canReadAudiencePlanBudget = budgetViewerUserId
    ? await asyncTenancy.hasPermission(budgetViewerUserId, { resourceType: "team", resourceId: teamId, action: "team.usage.read" })
        && await asyncTenancy.hasPermission(budgetViewerUserId, { resourceType: "team", resourceId: teamId, action: "team.billing.read" })
    : false;
  const planBudgetSources = view === "owner"
    ? await auditedPlanBudgetReadAsync(application.audit, {
        actor: { actorType: "user", actorId: claims.sub }, source: "owner", requestId: currentAdminRequestId(),
        resource: { resourceType: "team", resourceId: teamId },
        metadata: { routePattern: "/owner/teams/:teamId", teamId, perspective: view },
      }, async () => adminPlanBudgetDataSourcesAsync(
        asyncTenancy,
        await application.queries.listPlanSubscriptionBudgetUsage(detail.plans.map((plan) => plan.id), null, calculatedAt),
      ))
    : canReadAudiencePlanBudget && budgetViewerUserId
      ? await auditedPlanBudgetReadAsync(application.audit, {
          actor: { actorType: "user", actorId: claims.sub }, source: "owner", requestId: currentAdminRequestId(),
          resource: { resourceType: "team", resourceId: teamId },
          metadata: { routePattern: "/owner/teams/:teamId", teamId, perspective: view, targetUserId: budgetViewerUserId },
        }, async () => audiencePlanBudgetData(
          await buildAudienceUserPlanBudgetSourcesAsync(application.queries, budgetViewerUserId, calculatedAt, `team:${teamId}`),
        ))
      : [];
  const rawProviderEntitlementState = await authorityEntitlement.entitlement.getTeamProviderAccessState(teamId);
  const boundaryData = teamDetailBoundaryData(config, rawProviderEntitlementState);
  const rawProviderEntitlementHistory = await authorityEntitlement.entitlement.cursorTeamProviderEntitlements(teamId, singleValue(rawSearch?.entitlementCursor).slice(0, 2_000) || undefined, normalizeTablePageSize(rawSearch?.entitlementPageSize));
  const providerEntitlementHistory = teamProviderEntitlementHistoryData(rawProviderEntitlementHistory);
  return { teamId, rawSearch, view, planStatus, viewQuery, ...boundaryData, detail, previewMemberId, teamAudience, renderedTeam, renderedUsers, renderedMemberPage, membershipRoles, permissions, deleteBlockers, calculatedAt, invitePage, inviteModel, expenseSafetyChecks, canReadAudiencePlanBudget, planBudgetSources, providerEntitlementHistory };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

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


function restrictedTeamPreview(team: AdminTeamRow): AdminTeamRow {
  return {
    ...team,
    members: "Restricted",
    usage: 0,
    usageTone: "good",
    planName: "Hidden",
    planState: "Restricted",
    planWindow: "Select a concrete Team member",
    planEffectiveStart: null,
    planEffectiveEnd: null,
    budget: "Hidden",
    budgetState: "Restricted",
    accessCoverage: "Owner only",
  };
}
