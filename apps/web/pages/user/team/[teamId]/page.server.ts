import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { auditSuccessAsync, auditedPlanBudgetReadAsync, buildAudienceUserPlanBudgetSourcesAsync } from "@frely/ui-application/server";
import { teamScopeRef } from "@frely/core";
import { buildTeamExpenseSafetyChecksAsync } from "@frely/tenancy/audience-server";
import { requireWebUserSession } from "../../../../lib/web-page";
import { buildUserTeamDetailViewAsync } from "../../../../lib/user-teams";

export async function loadPage(teamId: string, search: Record<string, string | string[] | undefined>) {
  const memberPage = positivePage(search.memberPage);
  const memberPageSize = normalizeTablePageSize(search.memberPageSize);
  const providerPage = positivePage(search.providerPage);
  const providerPageSize = normalizeTablePageSize(search.providerPageSize);
  const providerModelPage = positivePage(search.providerModelPage);
  const providerModelPageSize = normalizeTablePageSize(search.providerModelPageSize);
  const { services, claims, hostScope } = await requireWebUserSession(`/user/team/${encodeURIComponent(teamId)}`);
  const detail = await buildUserTeamDetailViewAsync(
    services.application.queries,
    services.asyncTenancy.identity,
    services.asyncTenancy.tenancy,
    claims.sub,
    teamId,
    (resourceId, action) => services.asyncTenancy.hasPermission(claims.sub, { resourceType: "team", resourceId, action }),
    memberPage,
    memberPageSize,
  );
  if (!detail) return { available: false as const };

  const canReadPlanBudget = detail.canReadUsage && detail.canReadBilling;
  const canReadMemberPlanUsage = detail.canReadMembers && detail.canReadUsage && canReadPlanBudget;
  const calculatedAt = new Date().toISOString();
  const expenseSafetyPerspective = detail.availableTeam.ownerId === claims.sub ? "teamOwner" as const : "member" as const;
  const expenseSafetyChecks = await buildTeamExpenseSafetyChecksAsync(services.application.queries, services.asyncTenancy.tenancy, {
    teamId,
    perspective: expenseSafetyPerspective,
    ...(expenseSafetyPerspective === "member" ? { memberUserId: claims.sub } : {}),
    calculatedAt,
  });
  await auditSuccessAsync(services.application.audit, {
    actor: { actorType: "user", actorId: claims.sub }, source: "web", requestId: crypto.randomUUID(),
    action: "team.expense_safety_check.read", resource: { resourceType: "team", resourceId: teamId },
    metadata: { teamId, perspective: expenseSafetyPerspective, checkCodes: expenseSafetyChecks.map((check) => check.code), checkCount: expenseSafetyChecks.length, calculatedAt, routePattern: "/user/team/:teamId" },
  } as const);
  const planBudgetSources = canReadPlanBudget
    ? await auditedPlanBudgetReadAsync(services.application.audit, {
        actor: { actorType: "user" as const, actorId: claims.sub }, source: "web" as const, requestId: crypto.randomUUID(),
        resource: { resourceType: "team", resourceId: teamId }, metadata: { routePattern: "/user/team/:teamId", teamId },
      }, () => buildAudienceUserPlanBudgetSourcesAsync(services.application.queries, claims.sub, calculatedAt, `team:${teamId}`))
    : [];
  const limits = planBudgetSources.flatMap((source) => source.limits);
  const projectedTeam = canReadPlanBudget ? detail.team : {
    ...detail.team,
    planName: "Restricted",
    planState: "Restricted",
    planWindow: "Plan details require Team billing permission",
    budget: detail.canReadUsage ? `${detail.team.usage}% Team usage summary` : "Usage requires Team usage permission",
    budgetState: detail.canReadUsage ? "Usage only" : "Restricted",
    usage: detail.canReadUsage ? detail.team.usage : 0,
  };
  const providerResult = await services.application.queries.pageTeamProviderDirectory(teamScopeRef(teamId), providerPage, providerPageSize);
  const providerModels = await services.application.modelAccessQueries.pageProviderModels(providerModelPage, providerModelPageSize, { providerIds: providerResult.items.map((provider) => provider.id) });
  const providers = providerResult.items.map((provider) => ({ ...provider, models: providerModels.items.filter((model) => model.providerId === provider.id) }));
  const providerEntitlementState = await services.authorityEntitlement.entitlement.getTeamProviderAccessState(teamId);
  return {
    available: true as const,
    teamId,
    viewerUserId: claims.sub,
    publicOrigin: hostScope.publicOrigin,
    detail,
    projectedTeam,
    canReadPlanBudget,
    canReadMemberPlanUsage,
    planBudgetSources,
    limits,
    expenseSafetyPerspective,
    expenseSafetyChecks,
    calculatedAt,
    providerPage: providerResult,
    providerModels,
    providers,
    providerEntitlementState: providerEntitlementState.state,
    canManageProviders: false,
  };
}

export type TeamDetailPageData = Awaited<ReturnType<typeof loadPage>>;

function positivePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}
