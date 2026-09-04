import type { ScopeRef } from "@frely/core";
import type { AsyncApplicationOperationPort } from "./async-application-operation-port.js";
import type {
  PlanBillingMode,
  PlanBudgetSourceView,
  PlanSubscriptionEffectiveState,
  PlanSubscriptionUsageMode,
  ApplicationOperationPort,
} from "./application-operation-port.js";

export interface AudiencePlanBudgetLimit {
  key: string;
  limitScope: "subscription" | "user";
  metric: "tokens" | "amount";
  windowType: "fixed" | "cumulative";
  windowSeconds: number | null;
  limitValue: number;
  usedValue: number | null;
  remainingValue: number | null;
  percentUsed: number | null;
  exhausted: boolean | null;
  targetUserLabel: string | null;
  nextResetAt: string | null;
}

export interface AudiencePlanBudgetSource {
  key: string;
  planName: string;
  planVersion: number;
  billingMode: PlanBillingMode;
  scopeLabel: string;
  effectiveState: PlanSubscriptionEffectiveState;
  effectiveStart: string;
  effectiveEnd: string | null;
  usageMode: PlanSubscriptionUsageMode;
  usageReferenceAt: string | null;
  applicableModels: string[];
  limits: AudiencePlanBudgetLimit[];
  nextPeriodStart: string | null;
}

export type AudiencePlanBudgetAsyncApplicationOperationPort = Pick<AsyncApplicationOperationPort,
  | "getTeam"
  | "listActivePlanSubscriptionsForScopeRefs"
  | "listEffectiveSubscriptionScopesForUser"
  | "listPlanSubscriptionBudgetUsage"
>;

/**
 * Builds the secret-free Plan/Budget projection shared by Web and Admin
 * audience previews. Internal subscription, plan, scope, and user identities
 * are deliberately absent from the return type.
 */
export function buildAudienceUserPlanBudgetSources(
  repo: ApplicationOperationPort,
  userId: string,
  at: string,
  onlyScopeRef?: ScopeRef,
): AudiencePlanBudgetSource[] {
  const scopeRefs = repo.listEffectiveSubscriptionScopesForUser(userId)
    .filter((scopeRef) => !onlyScopeRef || scopeRef === onlyScopeRef);
  const subscriptions = repo.listActivePlanSubscriptionsForScopeRefs(scopeRefs, at);
  return repo.listPlanSubscriptionBudgetUsage(
    subscriptions.map((source) => source.subscription.id),
    userId,
    at,
  ).map((source, index) => audienceSource(repo, source, index));
}

export async function buildAudienceUserPlanBudgetSourcesAsync(
  repo: AudiencePlanBudgetAsyncApplicationOperationPort,
  userId: string,
  at: string,
  onlyScopeRef?: ScopeRef,
): Promise<AudiencePlanBudgetSource[]> {
  const scopeRefs = (await repo.listEffectiveSubscriptionScopesForUser(userId))
    .filter((scopeRef) => !onlyScopeRef || scopeRef === onlyScopeRef);
  const subscriptions = await repo.listActivePlanSubscriptionsForScopeRefs(scopeRefs, at);
  const sources = await repo.listPlanSubscriptionBudgetUsage(
    subscriptions.map((source) => source.subscription.id),
    userId,
    at,
  );
  return Promise.all(sources.map(async (source, index) => audienceSourceWithLabel(
    source,
    index,
    await audienceScopeLabelAsync(repo, source.scopeRef),
  )));
}

/**
 * Projects only the selected Team's personal limits for a concrete member.
 * Shared Team subscription limits remain hidden from another member's detail.
 */
export function buildAudienceTeamMemberPlanBudgetSources(
  repo: ApplicationOperationPort,
  targetUserId: string,
  teamId: string,
  at: string,
): AudiencePlanBudgetSource[] {
  return buildAudienceUserPlanBudgetSources(repo, targetUserId, at, `team:${teamId}`)
    .map((source) => ({
      ...source,
      limits: source.limits.filter((limit) => limit.limitScope === "user"),
    }))
    .filter((source) => source.limits.length > 0);
}

export async function buildAudienceTeamMemberPlanBudgetSourcesAsync(
  repo: AudiencePlanBudgetAsyncApplicationOperationPort,
  targetUserId: string,
  teamId: string,
  at: string,
): Promise<AudiencePlanBudgetSource[]> {
  const sources = await buildAudienceUserPlanBudgetSourcesAsync(repo, targetUserId, at, `team:${teamId}`);
  return sources
    .map((source) => ({
      ...source,
      limits: source.limits.filter((limit) => limit.limitScope === "user"),
    }))
    .filter((source) => source.limits.length > 0);
}

function audienceSource(
  repo: ApplicationOperationPort,
  source: PlanBudgetSourceView,
  index: number,
): AudiencePlanBudgetSource {
  return audienceSourceWithLabel(source, index, audienceScopeLabel(repo, source.scopeRef));
}

function audienceSourceWithLabel(
  source: PlanBudgetSourceView,
  index: number,
  scopeLabel: string,
): AudiencePlanBudgetSource {
  return {
    key: `source-${index}`,
    planName: source.planName,
    planVersion: source.planVersion,
    billingMode: source.billingMode,
    scopeLabel,
    effectiveState: source.effectiveState,
    effectiveStart: source.effectiveStart,
    effectiveEnd: source.effectiveEnd,
    usageMode: source.usageMode,
    usageReferenceAt: source.usageReferenceAt,
    applicableModels: source.applicableModels,
    nextPeriodStart: source.nextPeriodStart,
    limits: source.limits.map((limit, limitIndex) => ({
      key: `limit-${index}-${limitIndex}`,
      limitScope: limit.limitScope,
      metric: limit.metric,
      windowType: limit.windowType,
      windowSeconds: limit.windowSeconds,
      limitValue: limit.limitValue,
      usedValue: limit.usedValue,
      remainingValue: limit.remainingValue,
      percentUsed: limit.percentUsed,
      exhausted: limit.exhausted,
      targetUserLabel: limit.limitScope === "user" ? "Personal" : null,
      nextResetAt: limit.nextResetAt,
    })),
  };
}

function audienceScopeLabel(repo: ApplicationOperationPort, scopeRef: ScopeRef): string {
  if (scopeRef === "global:") return "Global";
  if (scopeRef.startsWith("team:")) return repo.getTeam(scopeRef.slice(5))?.name ?? "Team";
  return "Personal";
}

async function audienceScopeLabelAsync(repo: Pick<AsyncApplicationOperationPort, "getTeam">, scopeRef: ScopeRef): Promise<string> {
  if (scopeRef === "global:") return "Global";
  if (scopeRef.startsWith("team:")) return (await repo.getTeam(scopeRef.slice(5)))?.name ?? "Team";
  return "Personal";
}
