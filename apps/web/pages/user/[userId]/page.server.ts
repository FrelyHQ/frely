import { getRequestHeaders } from "@tanstack/react-start/server";
import { notFound, redirect } from "@web/navigation";
import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { auditedPlanBudgetReadAsync, buildAudienceTeamMemberPlanBudgetSourcesAsync, buildAudienceUserPlanBudgetSourcesAsync } from "@frely/ui-application/server";
import { loadUserAudienceAsync } from "@frely/tenancy/audience-server";
import { services } from "../../../lib/server";

export async function loadPage(userId: string, search: Record<string, string | string[] | undefined>) {
  const requestedTeamId = singleValue(search.teamId);
  const requestedKeyPage = positivePage(search.keyPage);
  const requestedKeyPageSize = normalizeTablePageSize(search.keyPageSize);
  const { application, asyncTenancy } = await services();
  let claims: Awaited<ReturnType<typeof asyncTenancy.requireUser>>;
  try {
    claims = await asyncTenancy.requireUser(new Headers(getRequestHeaders()));
  } catch {
    const nextPath = requestedTeamId ? `/user/${encodeURIComponent(userId)}?teamId=${encodeURIComponent(requestedTeamId)}` : `/user/${encodeURIComponent(userId)}`;
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  const isSelf = claims.sub === userId;
  const memberTeamId = requestedTeamId || (isSelf ? "" : notFound());
  const detail = await loadUserAudienceAsync({
    repo: application.queries,
    identity: asyncTenancy.identity,
    tenancy: asyncTenancy.tenancy,
    viewerUserId: claims.sub,
    targetUserId: userId,
    ...(memberTeamId ? { teamId: memberTeamId } : {}),
    apiKeyPage: requestedKeyPage,
    apiKeyPageSize: requestedKeyPageSize,
    hasPermission: (teamId, action) => asyncTenancy.hasPermission(claims.sub, { resourceType: "team", resourceId: teamId, action }),
  });
  if (!detail) notFound();
  const canReadMemberBudget = !isSelf && detail.capabilities.canReadPlanBudget;
  const calculatedAt = new Date().toISOString();
  const planBudgetSources = isSelf || canReadMemberBudget
    ? await auditedPlanBudgetReadAsync(application.audit, {
        actor: { actorType: "user", actorId: claims.sub }, source: "web", requestId: crypto.randomUUID(), resource: { resourceType: "user", resourceId: userId }, metadata: { routePattern: "/user/:userId", targetUserId: userId, ...(memberTeamId ? { teamId: memberTeamId } : {}) },
      } as const, () => isSelf ? buildAudienceUserPlanBudgetSourcesAsync(application.queries, userId, calculatedAt) : buildAudienceTeamMemberPlanBudgetSourcesAsync(application.queries, userId, memberTeamId, calculatedAt))
    : [];
  return { userId, memberTeamId, isSelf, canReadMemberBudget, detail, planBudgetSources, calculatedAt };
}

export type WebUserDetailPageData = Awaited<ReturnType<typeof loadPage>>;

function singleValue(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }
function positivePage(value: string | string[] | undefined): number { const raw = singleValue(value); return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1; }
