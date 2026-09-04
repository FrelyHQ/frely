import { RelayError } from "@frely/core";
import { auditedPlanBudgetReadAsync } from "@frely/ui-application/server";
import { requireWebUserSession } from "../../../../../lib/web-page";
import { parseTeamUsageUrlState } from "../../../../../features/team-usage/query";

export async function loadPage(teamId: string, search: Record<string, string | string[] | undefined>) {
  const rawState = parseTeamUsageUrlState(search);
  const { services, claims } = await requireWebUserSession(`/user/team/${encodeURIComponent(teamId)}/usage`);
  await services.asyncTenancy.resolveUserTeamId(claims, teamId, { allowPlatformOwner: false });
  for (const action of ["team.read", "team.member.read", "team.usage.read", "team.billing.read"]) {
    await services.asyncTenancy.requirePermission(claims, { resourceType: "team", resourceId: teamId, action }, { allowPlatformOwner: false });
  }
  const calculatedAt = new Date().toISOString();
  const candidates = await services.application.queries.searchActiveTeamSubscriptionCandidates({ teamId, query: "", page: 1, pageSize: 20, calculatedAt });
  const defaultCandidate = candidates.items[0];
  if (!defaultCandidate) return { kind: "empty" as const, teamId, calculatedAt };
  const subscriptionId = rawState.subscriptionId ?? defaultCandidate.id;
  const state = { ...rawState, subscriptionId };
  try {
    const usage = await auditedPlanBudgetReadAsync(services.application.audit, {
      actor: { actorType: "user", actorId: claims.sub }, source: "web", requestId: crypto.randomUUID(), resource: { resourceType: "plan_subscription", resourceId: subscriptionId }, metadata: { routePattern: "/user/team/:teamId/usage", teamId, subscriptionId, calculatedAt },
    } as const, () => services.application.queries.pageTeamMemberUsage({ teamId, subscriptionId, query: state.query, sort: state.sort, direction: state.direction, page: state.page, pageSize: state.pageSize, calculatedAt }));
    return {
      kind: "usage" as const,
      teamId,
      state,
      candidates,
      usage,
      historical: usage.summary.historicalRequestCount > 0 || usage.summary.historicalTokens > 0 || usage.summary.historicalBillableAmount > 0,
    };
  } catch (error) {
    if (!(error instanceof RelayError) || error.code !== "plan_source_unavailable") throw error;
    return { kind: "unavailable" as const, teamId, state, candidates };
  }
}

export type TeamUsagePageData = Awaited<ReturnType<typeof loadPage>>;
