import type { AsyncApplicationOperationPort, PlanSubscription, ApplicationOperationPort } from "@frely/application/runtime";
import type { TenancyQueries } from "./server.js";

export type TeamExpenseSafetyPerspective = "teamOwner" | "member";

export type TeamExpenseSafetyCheckCode =
  | "team_prepaid_member_access"
  | "team_prepaid_without_shared_cap"
  | "team_prepaid_without_member_cap"
  | "team_invite_expands_prepaid_access"
  | "team_paygo_member_charge"
  | "team_paygo_without_member_cap";

export interface TeamExpenseSafetyCheck {
  code: TeamExpenseSafetyCheckCode;
  level: "warning";
  affectedSubscriptionCount: number;
  earliestEffectiveEnd: string | null;
}

export interface TeamExpenseSafetyCheckInput {
  teamId: string;
  perspective: TeamExpenseSafetyPerspective;
  memberUserId?: string;
  calculatedAt: string;
}

/**
 * Produces a deliberately small, identity-scoped Team spending exposure view.
 * The caller owns authorization and audit logging; this helper only reads the
 * supplied repository and never resolves its own current time.
 */
export function buildTeamExpenseSafetyChecks(
  repo: ApplicationOperationPort,
  tenancy: Pick<ApplicationOperationPort, "getTeam" | "getTeamMembership" | "listTeamInviteLinks">,
  input: TeamExpenseSafetyCheckInput,
): TeamExpenseSafetyCheck[] {
  const team = tenancy.getTeam(input.teamId);
  if (!team) return [];
  if (input.perspective === "member" && (!input.memberUserId || team.status !== "enabled" || !tenancy.getTeamMembership(input.teamId, input.memberUserId))) return [];

  const active = repo.listPlanSubscriptionsForScope(`team:${input.teamId}`).flatMap((subscription) => {
    if (!isCurrentActiveSubscription(subscription, input.calculatedAt)) return [];
    const plan = repo.getPlan(subscription.planId);
    return plan ? [{ subscription, billingMode: plan.billingMode, limitScopes: new Set(repo.listPlanBudgetLimits(plan.id).map((limit) => limit.limitScope)) }] : [];
  });

  const prepaid = active.filter((source) => source.billingMode === "prepaid");
  const paygo = active.filter((source) => source.billingMode === "paygo");

  if (input.perspective === "teamOwner") {
    const checks: TeamExpenseSafetyCheck[] = [];
    if (prepaid.length > 0) {
      checks.push(check("team_prepaid_member_access", prepaid));
      const withoutSharedCap = prepaid.filter((source) => !source.limitScopes.has("subscription"));
      if (withoutSharedCap.length > 0) checks.push(check("team_prepaid_without_shared_cap", withoutSharedCap));
      const withoutMemberCap = prepaid.filter((source) => !source.limitScopes.has("user"));
      if (withoutMemberCap.length > 0) checks.push(check("team_prepaid_without_member_cap", withoutMemberCap));
      const canJoin = tenancy.listTeamInviteLinks(input.teamId).some((link) => link.status === "enabled" && (link.maxUses === null || link.usedCount === null || link.usedCount < link.maxUses));
      if (canJoin) checks.push(check("team_invite_expands_prepaid_access", prepaid));
    }
    return checks;
  }

  if (paygo.length === 0) return [];
  const checks = [check("team_paygo_member_charge", paygo)];
  const withoutMemberCap = paygo.filter((source) => !source.limitScopes.has("user"));
  if (withoutMemberCap.length > 0) checks.push(check("team_paygo_without_member_cap", withoutMemberCap));
  return checks;
}

export async function buildTeamExpenseSafetyChecksAsync(
  repo: Pick<AsyncApplicationOperationPort, "findActivePlanSubscriptions" | "getPlan" | "listPlanBudgetLimitsForPlans">,
  tenancy: Pick<TenancyQueries, "getTeam" | "getMembership" | "listInviteLinks">,
  input: TeamExpenseSafetyCheckInput,
): Promise<TeamExpenseSafetyCheck[]> {
  const team = await tenancy.getTeam(input.teamId);
  if (!team) return [];
  if (input.perspective === "member" && (!input.memberUserId || team.status !== "enabled" || !await tenancy.getMembership(input.teamId, input.memberUserId))) return [];

  const subscriptions = (await repo.findActivePlanSubscriptions(`team:${input.teamId}`)).filter((subscription) => isCurrentActiveSubscription(subscription, input.calculatedAt));
  const planIds = [...new Set(subscriptions.map((subscription) => subscription.planId))];
  const [plans, limitsByPlan] = await Promise.all([
    Promise.all(planIds.map((planId) => repo.getPlan(planId))),
    repo.listPlanBudgetLimitsForPlans(planIds),
  ]);
  const plansById = new Map(plans.flatMap((plan) => plan ? [[plan.id, plan] as const] : []));
  const active = subscriptions.flatMap((subscription) => {
    const plan = plansById.get(subscription.planId);
    return plan ? [{ subscription, billingMode: plan.billingMode, limitScopes: new Set((limitsByPlan.get(plan.id) ?? []).map((limit) => limit.limitScope)) }] : [];
  });

  const prepaid = active.filter((source) => source.billingMode === "prepaid");
  const paygo = active.filter((source) => source.billingMode === "paygo");
  if (input.perspective === "teamOwner") {
    const checks: TeamExpenseSafetyCheck[] = [];
    if (prepaid.length > 0) {
      checks.push(check("team_prepaid_member_access", prepaid));
      const withoutSharedCap = prepaid.filter((source) => !source.limitScopes.has("subscription"));
      if (withoutSharedCap.length > 0) checks.push(check("team_prepaid_without_shared_cap", withoutSharedCap));
      const withoutMemberCap = prepaid.filter((source) => !source.limitScopes.has("user"));
      if (withoutMemberCap.length > 0) checks.push(check("team_prepaid_without_member_cap", withoutMemberCap));
      const canJoin = (await tenancy.listInviteLinks(input.teamId)).some((link) => link.status === "enabled" && (link.maxUses === null || link.usedCount === null || link.usedCount < link.maxUses));
      if (canJoin) checks.push(check("team_invite_expands_prepaid_access", prepaid));
    }
    return checks;
  }
  if (paygo.length === 0) return [];
  const checks = [check("team_paygo_member_charge", paygo)];
  const withoutMemberCap = paygo.filter((source) => !source.limitScopes.has("user"));
  if (withoutMemberCap.length > 0) checks.push(check("team_paygo_without_member_cap", withoutMemberCap));
  return checks;
}

function isCurrentActiveSubscription(subscription: PlanSubscription, calculatedAt: string): boolean {
  return subscription.subscriptionLifecycle === "active"
    && subscription.effectiveStart <= calculatedAt
    && (subscription.effectiveEnd === null || calculatedAt < subscription.effectiveEnd);
}

function check(
  code: TeamExpenseSafetyCheckCode,
  sources: Array<{ subscription: PlanSubscription }>
): TeamExpenseSafetyCheck {
  const ends = sources.flatMap(({ subscription }) => subscription.effectiveEnd ? [subscription.effectiveEnd] : []);
  return {
    code,
    level: "warning",
    affectedSubscriptionCount: sources.length,
    earliestEffectiveEnd: ends.sort()[0] ?? null
  };
}
