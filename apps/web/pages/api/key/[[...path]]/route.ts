import { keyScopeRef, parseScopeRef, RelayError, requestIdFromHeaders } from "@frely/core";
import type { ApiKey, UiQueryPort, BudgetPolicy, BudgetUsageRecovery, PlanBudgetUsageSource, ScopeBudgetPolicy } from "@frely/ui-application/contracts";
import { actorFromPrincipal, auditSuccessAsync } from "@frely/ui-application/server";
import { isExpectedApiKeyAuthenticationFailure, normalizeApiKeyAuthenticationFailure } from "@frely/tenancy";
import type { TenancyQueries } from "@frely/tenancy/server";
import { handle, json, services } from "../../../../lib/server";

interface Context {
  params: Promise<{ path?: string[] }>;
}

export async function GET(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, asyncAbuseGuard, authorityEntitlement, application, config } = await services();
    let principal;
    try {
      principal = await asyncTenancy.authenticateApiKey(request.headers);
    } catch (error) {
      if (isExpectedApiKeyAuthenticationFailure(error)) {
        {
          await asyncAbuseGuard.consume("api_key_self.auth.failed", request.headers, { routePattern: "/api/key/:resource", requestId: requestIdFromHeaders(request.headers) });
        }
        throw normalizeApiKeyAuthenticationFailure(error);
      }
      throw error;
    }
    await assertRequesterMatchesAsync(request.headers, principal.user, asyncTenancy);
    const actor = actorFromPrincipal(principal);
    const requestId = requestIdFromHeaders(request.headers);
    const path = (await context.params).path ?? [];
    const resource = path[0] ?? "";
    if (resource === "usage") {
      try {
        const usage = await application.billingQueries.usageSummary({ apiKeyId: principal.apiKey.id });
        await application.audit.record({ actor, source: "web", requestId, action: "usage_log.read", resourceType: "usage_log", resourceId: principal.apiKey.id, result: "success", metadata: { apiKeyId: principal.apiKey.id, routePattern: "/api/key/usage" } });
        return json({
          usage: { totalTokens: usage.totalTokens, calculatedCost: usage.calculatedCost },
          apiKey: apiKeySummary(principal.apiKey)
        });
      } catch (error) {
        await application.audit.record({ actor, source: "web", requestId, action: "usage_log.read", resourceType: "usage_log", resourceId: principal.apiKey.id, result: "failure", metadata: { apiKeyId: principal.apiKey.id, routePattern: "/api/key/usage", errorCode: error instanceof RelayError ? error.code : "internal_error" } });
        throw error;
      }
    }
    if (resource === "budget") {
      const at = new Date().toISOString();
      const restriction = await authorityEntitlement.entitlement.decideApiKeyPlanSourceRestriction(principal.apiKey.id);
      const usageSummary = await application.billingQueries.usageSummary({ apiKeyId: principal.apiKey.id });
      const planSources = await application.billingQueries.listPlanBudgetUsageSourcesForUser(principal.user.id, at, restriction);
      const directKeyPolicies = (await application.billingQueries.listScopeBudgetPolicyAssignments(keyScopeRef(principal.apiKey.id)))
        .filter((assignment) => assignment.status === "enabled" && assignment.budgetPolicy.status === "enabled");
      const directWindows = directKeyPolicies.map((assignment, index) => {
        const period = directBudgetWindow(assignment.budgetPolicy, assignment, at);
        return { key: `key:${index}`, metric: assignment.budgetPolicy.metric as "tokens" | "amount", windowType: assignment.budgetPolicy.windowType as "rolling" | "cumulative", windowSeconds: assignment.budgetPolicy.windowSeconds, start: period.start, end: period.end, nextResetAt: null };
      });
      const directUsage = new Map((await application.billingQueries.summarizeScopeBudgetUsageWindows(keyScopeRef(principal.apiKey.id), directWindows)).map((summary) => [summary.key, summary]));
      const planOrigins = await Promise.all(planSources.map((source) => planSourceOriginAsync(asyncTenancy.tenancy, source)));
      const directOrigin = directKeyPolicies.length > 0 ? {
        scopeType: "key" as const,
        scopeLabel: "API key direct limit",
        planName: null,
        planVersion: null,
        limitScope: "key" as const,
        applicableModels: [...new Set(planSources.flatMap((source) => source.applicableModels))].sort(),
        subscriptionEffectiveStart: null,
        subscriptionEffectiveEnd: null
      } : null;
      return json({
        limits: [
          ...planSources.flatMap((source, sourceIndex) => source.limits.map((item) => budgetLimitSummary({
            source: "plan",
            policy: item.limit,
            usedValue: item.limit.metric === "tokens" ? item.usedTokens : item.usedAmount,
            period: { start: item.periodStart, end: item.periodEnd },
            nextResetAt: item.nextResetAt,
            origin: { ...planOrigins[sourceIndex], limitScope: item.limit.limitScope }
          }))),
          ...directKeyPolicies.map((assignment, index) => {
            const period = directWindows[index]!;
            const usage = directUsage.get(period.key);
            return budgetLimitSummary({
              source: "key",
              policy: assignment.budgetPolicy,
              usedValue: assignment.budgetPolicy.metric === "tokens" ? usage?.usedTokens ?? 0 : usage?.usedAmount ?? 0,
              period,
              nextResetAt: null,
              recovery: usage?.recovery ?? emptyRecovery(),
              origin: directOrigin!
            });
          })
        ],
        sources: [
          ...planOrigins.map((origin, index) => ({ source: "plan" as const, limitCount: planSources[index]?.limits.length ?? 0, origin })),
          ...(directOrigin ? [{ source: "key" as const, limitCount: directKeyPolicies.length, origin: directOrigin }] : [])
        ],
        usage: { totalTokens: usageSummary.totalTokens, calculatedCost: usageSummary.calculatedCost },
        apiKey: apiKeySummary(principal.apiKey)
      });
    }
    if (resource === "available-models") {
      await assertLoggedInOwnerAsync(request.headers, principal.user, asyncTenancy);
      const restriction = await authorityEntitlement.entitlement.decideApiKeyPlanSourceRestriction(principal.apiKey.id);
      return json(await application.queries.pageUserAvailableModels(principal.user.id, { page: queryPage(request) }, undefined, restriction));
    }
    if (resource === "access-points") {
      await assertLoggedInOwnerAsync(request.headers, principal.user, asyncTenancy);
      const restriction = await authorityEntitlement.entitlement.decideApiKeyPlanSourceRestriction(principal.apiKey.id);
      return json(await application.queries.pageUserAvailableModels(principal.user.id, { page: queryPage(request) }, undefined, restriction));
    }
    throw new RelayError("not_found", "API Key self resource not found", 404);
  });
}

function queryPage(request: Request) {
  const raw = new URL(request.url).searchParams.get("page");
  if (!raw) return 1;
  if (!/^\d+$/.test(raw)) throw new RelayError("invalid_pagination", "page must be a positive integer", 400);
  return Math.max(1, Math.min(10_000, Number(raw)));
}

async function assertRequesterMatchesAsync(headers: Headers, user: { id: string; email: string }, tenancy: Awaited<ReturnType<typeof services>>["asyncTenancy"]) {
  try {
    const claims = await tenancy.requireUser(headers);
    if (claims.sub === user.id) return;
    throw new RelayError("session_api_key_mismatch", "Signed-in user does not own the API key", 403);
  } catch (error) {
    if (error instanceof RelayError && error.code === "unauthorized") return;
    throw error;
  }
}

async function assertLoggedInOwnerAsync(headers: Headers, user: { id: string }, tenancy: Awaited<ReturnType<typeof services>>["asyncTenancy"]) {
  try {
    const claims = await tenancy.requireUser(headers);
    if (claims.sub === user.id) return;
    throw new RelayError("session_required", "Signed-in owner session is required", 403);
  } catch (error) {
    if (error instanceof RelayError && error.code === "unauthorized") throw new RelayError("session_required", "Signed-in owner session is required", 401);
    throw error;
  }
}

function apiKeySummary(apiKey: ApiKey) {
  return {
    prefix: apiKey.keyPrefix,
    status: apiKey.status,
    expiresAt: apiKey.expiresAt
  };
}

async function planSourceOriginAsync(tenancy: Pick<TenancyQueries, "getTeam">, source: PlanBudgetUsageSource) {
  const parsed = parseScopeRef(source.scopeRef);
  const scopeType = parsed.scopeType as "global" | "team" | "user";
  const team = scopeType === "team" ? await tenancy.getTeam(parsed.scopeId) : null;
  return {
    scopeType,
    scopeLabel: scopeType === "global" ? "Global" : scopeType === "user" ? "Personal" : team?.name ?? "Team",
    planName: source.plan.name,
    planVersion: source.plan.version,
    limitScope: "subscription" as const,
    applicableModels: source.applicableModels,
    subscriptionEffectiveStart: source.subscription.effectiveStart,
    subscriptionEffectiveEnd: source.subscription.effectiveEnd
  };
}

function budgetLimitSummary(input: { source: "plan" | "key"; policy: Pick<BudgetPolicy, "metric" | "limitValue" | "windowType" | "windowSeconds">; usedValue: number; period: { start: string; end: string }; nextResetAt: string | null; recovery?: BudgetUsageRecovery; origin: Record<string, unknown> }) {
  const limitValue = input.policy.limitValue;
  const remainingValue = Math.max(0, limitValue - input.usedValue);
  return {
    source: input.source,
    metric: input.policy.metric,
    limitValue,
    usedValue: input.usedValue,
    remainingValue,
    percentUsed: limitValue > 0 ? Math.min(100, Math.round((input.usedValue / limitValue) * 100)) : 0,
    windowType: input.policy.windowType,
    windowSeconds: input.policy.windowSeconds,
    periodStart: input.period.start,
    periodEnd: input.period.end,
    exhausted: input.usedValue >= limitValue,
    ...(input.source === "plan" ? { nextResetAt: input.nextResetAt } : { recovery: input.recovery ?? emptyRecovery() }),
    origin: input.origin
  };
}

function directBudgetWindow(policy: BudgetPolicy, assignment: Pick<ScopeBudgetPolicy, "createdAt">, at: string) {
  const end = new Date(at);
  if (policy.windowType === "rolling" && policy.windowSeconds) {
    return {
      start: new Date(end.getTime() - policy.windowSeconds * 1000).toISOString(),
      end: end.toISOString()
    };
  }
  return {
    start: assignment.createdAt,
    end: end.toISOString()
  };
}

function emptyRecovery(): BudgetUsageRecovery {
  return { nextRecoveryAt: null, nextRecoveryValue: null, fullRecoveryAt: null };
}
