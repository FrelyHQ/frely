import { isRuntimeScopeRef, keyScopeRef, RelayError, teamScopeRef, userScopeRef, type ScopeRef } from "@frely/core";
import type { AccessPoint, ActivePlanSubscription, CreditAccount, EffectivePlanAccessPointPrice, PlanBudgetLimit, PlanBudgetSourceView } from "@frely/application/runtime";
import { planBudgetWindow } from "@frely/application/runtime";
import { createModelAccessRoutingQueryBudget, type ModelAccessRoutingQueryService, type RoutingDiagnosticReport } from "@frely/model-access/server";
import { selectNextRoutingCandidate } from "@frely/model-access/routing-runtime";
import { calculateResolvedPrice, type BillingPriceInput, type BillingPriceResult, type GatewayPriceCalculation, type ResolvedBillingPriceInput } from "@frely/pricing";
import type { AccessResolution, AccessResolutionCandidate, AccessResolutionCandidatePlan, AccessResolutionOptions, AccessResolutionTrace, BudgetSubscriptionSummary, Principal } from "./index.js";
import type { GatewayQueries } from "./async-gateway-contract.js";
import { accessPointRequestContext } from "./request-context.js";

export interface AsyncGatewayPolicyGuards {
  assertPreferredPartnerSourceActive?(userId: string, exposedModel: string, at?: string, restriction?: Principal["apiKeyPlanSourceRestriction"]): Promise<void>;
  assertPartnerAccessActiveForScope(scopeRef: ScopeRef, at?: string): Promise<void>;
  assertPartnerAccessActiveForScopes(scopeRefs: readonly ScopeRef[], at?: string): Promise<void>;
  assertTeamProviderAccessActive(providerId: string, at?: string, providerScopeRef?: ScopeRef): Promise<void>;
  assertProviderAccessActiveForProviders(providers: readonly { id: string; scopeRef: ScopeRef }[], at?: string): Promise<void>;
  assertPersonalProviderAccessActive?(providerId: string, at?: string, providerScopeRef?: ScopeRef): Promise<void>;
}

export async function assertPersonalProviderPolicy(
  guards: AsyncGatewayPolicyGuards,
  providerId: string,
  at: string,
  providerScopeRef: ScopeRef,
): Promise<void> {
  const guard = (guards as Partial<AsyncGatewayPolicyGuards>).assertPersonalProviderAccessActive;
  if (typeof guard !== "function") {
    if (providerScopeRef.startsWith("user:")) throw new RelayError("personal_provider_policy_unavailable", "Personal Provider policy is unavailable", 503);
    return;
  }
  await guard.call(guards, providerId, at, providerScopeRef);
}

export interface GatewayAccessQueries extends Pick<GatewayQueries,
  | "findFirstOrderedPlanSourceForUser"
  | "pageOrderedPlanSourcesForUser"
  | "listAccessPointTargets"
  | "listAccessPointTargetsByIds"
  | "getAccessPoint"
  | "getAccessPoints"
  | "listAccessPointsVisibleAtScope"
  | "getProvider"
  | "getProviders"
> {}

/** Compatibility adapter for Access Resolution Preview. Routing compilation and
 * evaluation remain exclusively owned by the Model Access kernel. */
export class AsyncAccessResolutionService {
  constructor(
    readonly repo: GatewayAccessQueries,
    readonly guards: AsyncGatewayPolicyGuards,
    readonly routingQueries: Pick<ModelAccessRoutingQueryService, "evaluateEntryRouting">,
  ) {}

  preview(principal: Principal, reqModel: string, options: AccessResolutionOptions = {}): Promise<AccessResolution> {
    return this.resolve(principal, reqModel, false, options) as Promise<AccessResolution>;
  }

  explain(principal: Principal, reqModel: string, options: AccessResolutionOptions = {}): Promise<AccessResolutionTrace> {
    return this.resolve(principal, reqModel, true, options) as Promise<AccessResolutionTrace>;
  }

  private async resolve(
    principal: Principal,
    reqModel: string,
    explain: boolean,
    options: AccessResolutionOptions,
  ): Promise<AccessResolution | AccessResolutionTrace> {
    const now = new Date().toISOString();
    await this.guards.assertPreferredPartnerSourceActive?.(principal.user.id, reqModel, now, principal.apiKeyPlanSourceRestriction);
    const scopeRefs = scopeRefsForPrincipal(principal);
    const selectedSource = options.accessPointId
      ? null
      : await this.repo.findFirstOrderedPlanSourceForUser(principal.user.id, reqModel, now, principal.apiKeyPlanSourceRestriction);
    if (!options.accessPointId && !selectedSource?.accessPoint) {
      throw new RelayError("plan_subscription_required", `No active Plan source found for model ${reqModel}`, 402);
    }
    const entryAccessPoint = options.accessPointId
      ? await this.resolveAccessPointById(scopeRefs, options.accessPointId, reqModel, options.bypassVisibility === true)
      : selectedSource!.accessPoint!;
    const report = await this.routingQueries.evaluateEntryRouting(
      { entryAccessPointId: entryAccessPoint.id, requestedModel: reqModel },
      createModelAccessRoutingQueryBudget(),
    );
    const accessPoints = await this.loadAccessPoints(report);
    const accessPointsById = new Map(accessPoints.map((accessPoint) => [accessPoint.id, accessPoint]));
    const providerIds = [...new Set(report.candidates.map((candidate) => candidate.providerId))];
    const providers = await this.repo.getProviders(providerIds);
    for (const providerId of providerIds) {
      if (!providers.some((provider) => provider.id === providerId)) throw new RelayError("provider_not_found", `Provider ${providerId} not found`, 404);
    }
    const providersById = new Map(providers.map((provider) => [provider.id, provider]));
    const candidates = report.candidates.map((candidate): AccessResolutionCandidate => {
      const provider = providersById.get(candidate.providerId);
      if (!provider) throw new RelayError("routing_graph_snapshot_invalid", `Routing snapshot is missing Provider ${candidate.providerId}`, 500);
      const unavailableReason = legacyRoutingUnavailableReason(candidate.unavailableReason, options.requireProviderBinding !== false);
      return Object.freeze({
        scopeRef: (selectedSource?.order.subscriptionScopeRef as ScopeRef | undefined) ?? scopeRefs[0]!,
        accessPoint: entryAccessPoint,
        accessPointChain: Object.freeze(candidate.accessPointChainIds.map((id) => {
          const accessPoint = accessPointsById.get(id);
          if (!accessPoint) throw new RelayError("routing_graph_snapshot_invalid", `Routing snapshot is missing AccessPoint ${id}`, 500);
          return accessPoint;
        })),
        providerId: candidate.providerId,
        providerModelName: candidate.providerModelName,
        reqModel,
        tarModel: candidate.providerModelName,
        credentialRef: provider.credentialResolver,
        candidateId: candidate.candidateId,
        selectorTargetEdgeId: candidate.selectorTargetEdgeId,
        pathTargetEdgeIds: [...candidate.pathTargetEdgeIds],
        routingRevisions: candidate.routingRevisions.map((revision) => ({ ...revision })),
        available: unavailableReason === null,
        unavailableReason,
      });
    });
    const candidatePlan: AccessResolutionCandidatePlan = Object.freeze({
      entryAccessPointId: report.plan.entryAccessPointId,
      selectorAccessPointId: report.plan.selectorAccessPointId,
      selectorId: report.plan.selectorId,
      selectorBehaviorVersion: report.plan.selectorBehaviorVersion,
      selectorConfig: report.plan.selectorConfig,
      routingRevision: report.plan.routingRevision,
      candidates: Object.freeze(candidates),
    });
    const selectedId = options.requireProviderBinding === false
      ? selectNextRoutingCandidate(report.plan, report.candidates.map((candidate) => candidate.unavailableReason?.code === "provider_binding_not_ready"
        ? { ...candidate, available: true, unavailableReason: null }
        : candidate), []).selectedCandidateId
      : report.selectedCandidateId;
    const selected = candidates.find((candidate) => candidate.candidateId === selectedId)
      ?? (options.allowUnavailable === true ? candidates[0] : undefined);
    if (!selected) throw modelUnavailable();
    const candidateAccessPointScopes = [...new Set(candidates.flatMap((candidate) => candidate.accessPointChain.map((accessPoint) => accessPoint.scopeRef as ScopeRef)))];
    await this.guards.assertPartnerAccessActiveForScopes(candidateAccessPointScopes, now);
    const candidateProviders = [...new Set(candidates.map((candidate) => candidate.providerId))].map((providerId) => {
      const provider = providersById.get(providerId);
      if (!provider) throw new RelayError("routing_graph_snapshot_invalid", `Routing snapshot is missing Provider ${providerId}`, 500);
      return { id: providerId, scopeRef: provider.scopeRef as ScopeRef };
    });
    await this.guards.assertProviderAccessActiveForProviders(candidateProviders, now);
    const resolution: AccessResolution = {
      ...selected,
      candidatePlan,
    };
    if (!explain) return resolution;
    const planSourcePage = await this.previewPlanSources(principal, reqModel);
    const checkedScopeRefs = [...scopeRefs];
    const candidateAccessPoints = [entryAccessPoint];
    for (const candidate of candidates) {
      const selectorIndex = candidate.accessPointChain.findIndex((accessPoint) => accessPoint.id === report.plan.selectorAccessPointId);
      if (selectorIndex < 0) throw new RelayError("routing_graph_snapshot_invalid", "Routing snapshot candidate does not include its selector AccessPoint", 500);
      for (const accessPoint of candidate.accessPointChain.slice(selectorIndex + 1)) {
        candidateAccessPoints.push(accessPoint);
        if (isRuntimeScopeRef(accessPoint.scopeRef) && !checkedScopeRefs.includes(accessPoint.scopeRef as ScopeRef)) {
          checkedScopeRefs.push(accessPoint.scopeRef as ScopeRef);
        }
      }
    }
    return {
      ...resolution,
      checkedScopeRefs,
      matchedAccessPoints: [entryAccessPoint],
      candidateAccessPoints,
      resolutionPath: await this.resolutionPath(selected, accessPointsById),
      planSources: planSourcePage.items,
      planSourcesNextCursor: planSourcePage.nextCursor,
      selectedPlanSourceOrderId: selectedSource?.order.id ?? null,
    };
  }

  private async loadAccessPoints(report: RoutingDiagnosticReport): Promise<AccessPoint[]> {
    const accessPointIds = report.accessPoints.map((item) => item.id);
    const accessPoints = await this.repo.getAccessPoints(accessPointIds);
    if (accessPoints.length !== report.accessPoints.length) {
      throw new RelayError("routing_graph_snapshot_invalid", "Routing snapshot AccessPoint projection is incomplete", 500);
    }
    return accessPoints;
  }

  private async resolutionPath(
    selected: AccessResolutionCandidate,
    accessPointsById: ReadonlyMap<string, AccessPoint>,
  ): Promise<AccessResolutionTrace["resolutionPath"]> {
    const steps: AccessResolutionTrace["resolutionPath"] = [];
    const accessPointIds = selected.accessPointChain.map((accessPoint) => accessPoint.id);
    const targets = await this.repo.listAccessPointTargetsByIds(accessPointIds, false);
    const targetsById = new Map(targets.map((target) => [target.id, target]));
    for (const [index, accessPointRef] of selected.accessPointChain.entries()) {
      const accessPoint = accessPointsById.get(accessPointRef.id);
      if (!accessPoint) throw new RelayError("routing_graph_snapshot_invalid", `Routing snapshot is missing AccessPoint ${accessPointRef.id}`, 500);
      const target = targetsById.get(selected.pathTargetEdgeIds[index]!);
      steps.push({
        scopeRef: accessPoint.scopeRef as ScopeRef,
        ownerId: accessPoint.ownerId,
        accessPointScopeRef: accessPoint.scopeRef,
        accessPointId: accessPoint.id,
        exposedModel: accessPoint.exposedModel,
        description: accessPoint.description,
        targetModel: accessPoint.targetModel,
        targetType: target?.targetType ?? accessPoint.targetType,
        targetId: target?.targetAccessPointId ?? null,
        targetProviderId: target?.targetProviderId ?? null,
        targetProviderModelName: target?.targetProviderModelName ?? null,
      });
    }
    return steps;
  }

  private async previewPlanSources(
    principal: Principal,
    reqModel: string,
  ): Promise<{ items: AccessResolutionTrace["planSources"]; nextCursor: AccessResolutionTrace["planSourcesNextCursor"] }> {
    const page = await this.repo.pageOrderedPlanSourcesForUser(principal.user.id, reqModel, null, undefined, principal.apiKeyPlanSourceRestriction);
    return {
      items: page.items.map(({ order, subscription, accessPoint, configurationError }) => {
        if (!subscription) return { orderId: order.id, position: order.position, planId: order.planId, subscriptionScopeRef: order.subscriptionScopeRef, currentSubscriptionId: null, entryAccessPointId: accessPoint?.id ?? null, status: "skipped" as const, reason: "no_active_subscription" };
        if (configurationError) return { orderId: order.id, position: order.position, planId: order.planId, subscriptionScopeRef: order.subscriptionScopeRef, currentSubscriptionId: subscription.id, entryAccessPointId: accessPoint?.id ?? null, status: "invalid" as const, reason: configurationError };
        if (!accessPoint) return { orderId: order.id, position: order.position, planId: order.planId, subscriptionScopeRef: order.subscriptionScopeRef, currentSubscriptionId: subscription.id, entryAccessPointId: null, status: "invalid" as const, reason: "entry_access_point_missing" };
        return { orderId: order.id, position: order.position, planId: order.planId, subscriptionScopeRef: order.subscriptionScopeRef, currentSubscriptionId: subscription.id, entryAccessPointId: accessPoint.id, status: "eligible" as const, reason: null };
      }),
      nextCursor: page.nextCursor,
    };
  }

  private async resolveAccessPointById(
    scopeRefs: ScopeRef[],
    accessPointId: string,
    reqModel: string,
    bypassVisibility: boolean,
  ): Promise<AccessPoint> {
    if (bypassVisibility) {
      const accessPoint = await this.repo.getAccessPoint(accessPointId);
      if (accessPoint?.status === "enabled" && accessPoint.exposedModel === reqModel) return accessPoint;
      throw new RelayError("access_point_not_found", `AccessPoint ${accessPointId} not found or does not allow reqModel ${reqModel}`, 404);
    }
    for (const scopeRef of scopeRefs) {
      const accessPoint = (await this.repo.listAccessPointsVisibleAtScope(scopeRef)).find((item) => item.id === accessPointId);
      if (accessPoint && accessPoint.exposedModel === reqModel) return accessPoint;
    }
    throw new RelayError("access_point_not_found", `No visible AccessPoint found for ${accessPointId}`, 404);
  }
}

export interface GatewayBudgetQueries extends Pick<GatewayQueries,
  | "pageOrderedPlanSourcesForUser"
  | "listPlanBudgetLimitsForPlans"
  | "findEffectivePlanAccessPointPrices"
  | "findEffectivePlanAccessPointPrice"
  | "findCreditAccountForScope"
  | "getCreditAccountBalanceUnits"
  | "listScopeBudgetPolicyAssignments"
  | "listScopeGovernanceBudgetPolicyAssignments"
  | "listActiveSubscriptionsForUser"
  | "findActivePlanSubscriptions"
  | "usageForSubscription"
  | "usageForSubscriptionUser"
  | "usageForScope"
  | "listPlanSubscriptionBudgetUsage"
  | "summarizeScopeBudgetUsageWindows"
> {}

export interface GatewayPricingQueries extends Pick<GatewayQueries,
  | "findEnabledAccessPointPrices"
  | "findEnabledProviderModelCosts"
> {}

export type AsyncSubscriptionSelection = {
  planSourceOrderId: string;
  subscription: ActivePlanSubscription;
  accessPoint: AccessPoint;
  effectivePrice: EffectivePlanAccessPointPrice;
  usageChargeAccount: CreditAccount | null;
  effectivePayload: Record<string, unknown>;
  billingServiceTier: string;
  requireProviderServiceTier: boolean;
};

export class AsyncBudgetService {
  constructor(
    readonly repo: GatewayBudgetQueries,
    readonly guards: AsyncGatewayPolicyGuards,
    readonly billingQueries: Pick<GatewayBudgetQueries,
      "findCreditAccountForScope" | "getCreditAccountBalanceUnits"
      | "findEffectivePlanAccessPointPrices" | "listPlanSubscriptionBudgetUsage" | "summarizeScopeBudgetUsageWindows"
      | "listPlanBudgetLimitsForPlans" | "listScopeBudgetPolicyAssignments" | "listScopeGovernanceBudgetPolicyAssignments"
      | "usageForSubscription" | "usageForSubscriptionUser" | "usageForScope"
    > = repo,
  ) {}

  async selectSubscription(
    principal: Principal,
    exposedModel: string,
    payload: Readonly<Record<string, unknown>>,
    excludedPlanSourceOrderIds: ReadonlySet<string> = new Set(),
  ): Promise<AsyncSubscriptionSelection> {
    const now = new Date();
    await this.guards.assertPreferredPartnerSourceActive?.(principal.user.id, exposedModel, now.toISOString(), principal.apiKeyPlanSourceRestriction);
    let sawCandidate = false;
    let sawEntitledCandidate = false;
    let sawExcludedCandidate = false;
    let sawInsufficientCredit = false;
    let sawNonCreditUnavailable = false;
    let paygoAccountLoaded = false;
    let paygoAccount: CreditAccount | null = null;
    let paygoBalanceUnits = 0;
    const loadPaygoAccount = async (): Promise<{ account: CreditAccount | null; balanceUnits: number }> => {
      if (!paygoAccountLoaded) {
        paygoAccount = await this.billingQueries.findCreditAccountForScope(userScopeRef(principal.user.id)) ?? null;
        paygoBalanceUnits = paygoAccount ? await this.billingQueries.getCreditAccountBalanceUnits(paygoAccount.id) : 0;
        paygoAccountLoaded = true;
      }
      return { account: paygoAccount, balanceUnits: paygoBalanceUnits };
    };
    let cursor: Parameters<GatewayQueries["pageOrderedPlanSourcesForUser"]>[2] = null;
    do {
      const page = await this.repo.pageOrderedPlanSourcesForUser(principal.user.id, exposedModel, cursor, now.toISOString(), principal.apiKeyPlanSourceRestriction);
      const limitsByPlan = await this.billingQueries.listPlanBudgetLimitsForPlans(page.items.map((source) => source.plan.id));
      const effectivePrices = await this.billingQueries.findEffectivePlanAccessPointPrices(page.items.flatMap((source) => source.subscription && source.accessPoint
        ? [{ planId: source.plan.id, accessPointId: source.accessPoint.id }]
        : []));
      const effectivePricesByKey = new Map(effectivePrices.map((item) => [`${item.planId}\u0000${item.accessPointId}`, item.effectivePrice]));
      const budgetUsageBySubscription = new Map<string, PlanBudgetSourceView>(
        (await this.billingQueries.listPlanSubscriptionBudgetUsage(
          page.items.flatMap((source) => source.subscription ? [source.subscription.id] : []),
          principal.user.id,
          now.toISOString(),
        )).map((source) => [source.subscriptionId, source]),
      );
      const candidateSources: typeof page.items = [];
      for (const source of page.items) {
        if (principal.effectiveScopes && !principal.effectiveScopes.includes(source.order.subscriptionScopeRef as ScopeRef)) continue;
        if (excludedPlanSourceOrderIds.has(source.order.id)) {
          sawExcludedCandidate = true;
          continue;
        }
        if (!source.subscription) continue;
        sawCandidate = true;
        assertOrderedPlanSourceConfiguration(source);
        if (!source.accessPoint) continue;
        candidateSources.push(source);
      }
      const candidateScopeRefs = [...new Set(candidateSources.map((source) => source.order.subscriptionScopeRef as ScopeRef))];
      await this.guards.assertPartnerAccessActiveForScopes(candidateScopeRefs, now.toISOString());
      for (const source of candidateSources) {
        if (!source.subscription || !source.accessPoint) continue;
        sawEntitledCandidate = true;
        const requestContext = accessPointRequestContext(payload, source.accessPoint);
        const candidate: ActivePlanSubscription = { scopeRef: source.subscription.scopeRef as ScopeRef, subscription: source.subscription, plan: source.plan, budgetLimits: limitsByPlan.get(source.plan.id) ?? [] };
        const effectivePrice = effectivePricesByKey.get(`${candidate.plan.id}\u0000${source.accessPoint.id}`);
        if (!effectivePrice) throw new RelayError("access_point_price_not_configured", `AccessPoint ${source.accessPoint.id} has no enabled price for Plan ${candidate.plan.id}`, 500);
        let usageChargeAccount: CreditAccount | null = null;
        if (subscriptionRequiresUsageCharge(candidate.plan.billingMode)) {
          const paygo = await loadPaygoAccount();
          usageChargeAccount = paygo.account;
          const balanceUnits = paygo.balanceUnits;
          if (!Number.isSafeInteger(balanceUnits)) throw new RelayError("invalid_credit_units", "Credit balance units must be a safe integer", 500);
          if (!usageChargeAccount || usageChargeAccount.status !== "active" || balanceUnits <= 0) {
            sawInsufficientCredit = true;
            continue;
          }
        }
        if (!this.subscriptionHasRemainingBudget(candidate, budgetUsageBySubscription.get(candidate.subscription.id))) {
          sawNonCreditUnavailable = true;
          continue;
        }
        return { planSourceOrderId: source.order.id, subscription: candidate, accessPoint: source.accessPoint, effectivePrice, usageChargeAccount, ...requestContext };
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (sawExcludedCandidate && !sawCandidate) throw new RelayError("plan_source_candidates_exhausted", "No remaining Plan source can admit this request", 402);
    if (sawInsufficientCredit && !sawNonCreditUnavailable) throw new RelayError("insufficient_credit_balance", "Credit balance must be positive before Provider dispatch", 402);
    const requestedModel = JSON.stringify(exposedModel);
    throw new RelayError(
      !sawCandidate ? "plan_subscription_required" : !sawEntitledCandidate ? "plan_entitlement_required" : "plan_subscription_unavailable",
      !sawCandidate ? `No active plan subscription is available for model ${requestedModel}` : !sawEntitledCandidate ? `No active plan subscription provides model ${requestedModel}` : `No active plan subscription has remaining budget for model ${requestedModel}`,
      402,
    );
  }

  async checkDirectHardStops(principal: Principal): Promise<void> {
    const scopeRef = keyScopeRef(principal.apiKey.id);
    const now = new Date();
    const assignments = (await this.billingQueries.listScopeBudgetPolicyAssignments(scopeRef))
      .filter((assignment) => isEnabledStatus(assignment.status) && isEnabledStatus(assignment.budgetPolicy.status));
    const windows = assignments.map((assignment, index) => {
      const window = directBudgetWindow(assignment.budgetPolicy, assignment, now);
      return {
        assignment,
        input: {
          key: `${assignment.budgetPolicy.id}:${index}`,
          metric: assignment.budgetPolicy.metric as "tokens" | "amount",
          windowType: assignment.budgetPolicy.windowType as "rolling" | "fixed" | "cumulative",
          windowSeconds: assignment.budgetPolicy.windowSeconds,
          start: window.start,
          end: window.end,
          nextResetAt: null,
        },
      };
    });
    const usageByKey = new Map((await this.billingQueries.summarizeScopeBudgetUsageWindows(scopeRef, windows.map(({ input }) => input))).map((usage) => [usage.key, usage]));
    for (const { assignment, input } of windows) {
      const usage = usageByKey.get(input.key) ?? { usedTokens: 0, usedAmount: 0 };
      if (assignment.budgetPolicy.metric === "tokens" && usage.usedTokens >= assignment.budgetPolicy.limitValue) {
        throw new RelayError("budget_token_limit_exceeded", "API key token budget is exhausted", 402);
      }
      if (assignment.budgetPolicy.metric === "amount" && usage.usedAmount >= assignment.budgetPolicy.limitValue) {
        throw new RelayError("budget_amount_limit_exceeded", "API key amount budget is exhausted", 402);
      }
    }
  }

  async checkGovernanceHardStops(principal: Principal, maximumTokens: number, maximumBillableAmount: number): Promise<void> {
    const now = new Date();
    const scopeRefs = governanceBudgetScopeRefsForPrincipal(principal);
    if (scopeRefs.length === 0) return;
    const assignments = (await this.billingQueries.listScopeGovernanceBudgetPolicyAssignments(scopeRefs))
      .filter((assignment) => isEnabledStatus(assignment.status) && isEnabledStatus(assignment.governanceBudgetPolicy.status));
    const windows = assignments.map((assignment, index) => {
      const scopeRef = assignment.scopeRef as ScopeRef;
      const window = directBudgetWindow(assignment.governanceBudgetPolicy, assignment, now);
      return {
        assignment,
        input: {
          key: `${scopeRef}\u0000${assignment.governanceBudgetPolicy.id}:${index}`,
          scopeRef,
          metric: assignment.governanceBudgetPolicy.metric as "tokens" | "amount",
          windowType: assignment.governanceBudgetPolicy.windowType as "rolling" | "fixed" | "cumulative",
          windowSeconds: assignment.governanceBudgetPolicy.windowSeconds,
          start: window.start,
          end: window.end,
          nextResetAt: null,
        },
      };
    });
    const usageByKey = new Map((await this.billingQueries.summarizeScopeBudgetUsageWindows(scopeRefs, windows.map(({ input }) => input))).map((usage) => [usage.key, usage]));
    for (const { assignment, input } of windows) {
      const scopeRef = assignment.scopeRef as ScopeRef;
      const usage = usageByKey.get(input.key) ?? { usedTokens: 0, usedAmount: 0 };
      if (assignment.governanceBudgetPolicy.metric === "tokens" && (usage.usedTokens >= assignment.governanceBudgetPolicy.limitValue || usage.usedTokens + maximumTokens > assignment.governanceBudgetPolicy.limitValue)) throw new RelayError("governance_budget_token_limit_exceeded", `Governance token budget has no remaining capacity for ${scopeRef}`, 402);
      if (assignment.governanceBudgetPolicy.metric === "amount" && (usage.usedAmount >= assignment.governanceBudgetPolicy.limitValue || usage.usedAmount + maximumBillableAmount > assignment.governanceBudgetPolicy.limitValue)) throw new RelayError("governance_budget_amount_limit_exceeded", `Governance amount budget has no remaining capacity for ${scopeRef}`, 402);
    }
  }

  async summary(principal: Principal): Promise<BudgetSubscriptionSummary | null> {
    const now = new Date();
    const active = (await this.repo.listActiveSubscriptionsForUser(principal.user.id, now.toISOString()))[0];
    if (!active) return null;
    const budgetLimits = [];
    for (const limit of active.budgetLimits) {
      const window = subscriptionBudgetWindow(limit, active.subscription, now);
      const usage = limit.limitScope === "user"
        ? await this.billingQueries.usageForSubscriptionUser(active.subscription.id, principal.user.id, window.start, window.end)
        : await this.billingQueries.usageForSubscription(active.subscription.id, window.start, window.end);
      budgetLimits.push({ limit, limitScope: limit.limitScope, periodStart: window.start, periodEnd: window.end, usage });
    }
    return { ...active, budgetLimits };
  }

  private subscriptionHasRemainingBudget(candidate: ActivePlanSubscription, usageSource: PlanBudgetSourceView | undefined): boolean {
    for (const limit of candidate.budgetLimits) {
      if (!usageSource) return false;
      const usage = usageSource.limits.find((item) => item.limitScope === limit.limitScope
        && item.metric === limit.metric
        && item.windowType === limit.windowType
        && item.windowSeconds === limit.windowSeconds
        && item.limitValue === limit.limitValue);
      if (!usage || usage.exhausted === null || usage.exhausted === true) return false;
    }
    return true;
  }
}

export class AsyncRateLimitService {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(readonly repo: Pick<GatewayQueries, "listScopeRateLimitPolicyAssignments">) {}

  async checkGovernance(principal: Principal, nowMs = Date.now()): Promise<void> {
    const scopeRefs = governanceScopeRefsForPrincipal(principal);
    if (scopeRefs.length === 0) return;
    const assignments = (await this.repo.listScopeRateLimitPolicyAssignments(scopeRefs))
      .filter((assignment) => isEnabledStatus(assignment.status) && isEnabledStatus(assignment.rateLimitPolicy.status) && assignment.rateLimitPolicy.mode === "governance");
    for (const assignment of assignments) {
      if (assignment.rateLimitPolicy.metric !== "requests") continue;
      const scopeRef = assignment.scopeRef as ScopeRef;
      if (!this.consume(`${assignment.rateLimitPolicy.id}:${scopeRef}`, assignment.rateLimitPolicy.limitValue, assignment.rateLimitPolicy.windowSeconds, assignment.rateLimitPolicy.burstValue, nowMs)) throw new RelayError("rate_limit_exceeded", `Rate limit exceeded for ${scopeRef}`, 429);
    }
  }

  private consume(bucketKey: string, limitValue: number, windowSeconds: number, burstValue: number, nowMs: number): boolean {
    const refillPerMs = limitValue / (windowSeconds * 1000);
    const capacity = burstValue;
    const current = this.buckets.get(bucketKey) ?? { tokens: capacity, updatedAtMs: nowMs };
    const elapsedMs = Math.max(0, nowMs - current.updatedAtMs);
    const tokens = Math.min(capacity, current.tokens + elapsedMs * refillPerMs);
    if (tokens < 1) {
      this.buckets.set(bucketKey, { tokens, updatedAtMs: nowMs });
      return false;
    }
    this.buckets.set(bucketKey, { tokens: tokens - 1, updatedAtMs: nowMs });
    return true;
  }
}

export class AsyncPricingService {
  constructor(readonly billingQueries: GatewayPricingQueries) {}

  async lookup(input: Pick<BillingPriceInput, "accessPointId" | "providerId" | "providerModelName">): Promise<Pick<BillingPriceResult, "accessPointPrice" | "providerModelCost">> {
    const [accessPointPrices, providerModelCosts] = await Promise.all([
      this.billingQueries.findEnabledAccessPointPrices([input.accessPointId]),
      this.billingQueries.findEnabledProviderModelCosts([{ providerId: input.providerId, providerModelName: input.providerModelName }]),
    ]);
    const accessPointPrice = accessPointPrices[0];
    const providerModelCost = providerModelCosts[0];
    return { accessPointPrice: accessPointPrice ?? null, providerModelCost: providerModelCost ?? null };
  }

  calculate(input: ResolvedBillingPriceInput): GatewayPriceCalculation {
    return calculateResolvedPrice(input);
  }
}

interface RateLimitBucket {
  tokens: number;
  updatedAtMs: number;
}

function legacyRoutingUnavailableReason(
  reason: RoutingDiagnosticReport["candidates"][number]["unavailableReason"],
  requireProviderBinding: boolean,
): AccessResolutionCandidate["unavailableReason"] {
  if (!reason || (!requireProviderBinding && reason.code === "provider_binding_not_ready")) return null;
  switch (reason.code) {
    case "access_point_disabled": return "target_disabled";
    case "provider_disabled": return "provider_disabled";
    case "provider_model_disabled": return "provider_model_disabled";
    case "provider_binding_not_ready": return "provider_binding_not_ready";
  }
}

function modelUnavailable(): RelayError {
  return new RelayError("model_unavailable", "The requested model is temporarily unavailable", 503);
}

function scopeRefsForPrincipal(principal: Principal): ScopeRef[] {
  return [keyScopeRef(principal.apiKey.id), ...[...principalScopes(principal)].reverse()];
}

function governanceScopeRefsForPrincipal(principal: Principal): ScopeRef[] {
  return [...principalScopes(principal), keyScopeRef(principal.apiKey.id)];
}

function governanceBudgetScopeRefsForPrincipal(principal: Principal): ScopeRef[] {
  return principalScopes(principal);
}

function principalScopes(principal: Principal): ScopeRef[] {
  return principal.effectiveScopes ?? ["global:", ...(principal.team ? [teamScopeRef(principal.team.id)] : []), userScopeRef(principal.user.id)];
}

function subscriptionBudgetWindow(policy: { windowType: string; windowSeconds: number | null }, subscription: { effectiveStart: string; effectiveEnd: string | null }, now: Date): { start: string; end: string; nextResetAt: string | null } {
  return planBudgetWindow(policy as { windowType: "fixed" | "cumulative"; windowSeconds: number | null }, subscription, now.toISOString());
}

function directBudgetWindow(policy: { windowType: string; windowSeconds: number | null }, assignment: { createdAt: string }, now: Date): { start: string; end: string } {
  if (policy.windowType === "rolling") {
    const seconds = policy.windowSeconds ?? 0;
    return { start: new Date(now.getTime() - seconds * 1000).toISOString(), end: now.toISOString() };
  }
  return { start: assignment.createdAt, end: now.toISOString() };
}

function assertOrderedPlanSourceConfiguration(source: { configurationError: string | null }): void {
  if (source.configurationError) throw new RelayError("plan_source_configuration_invalid", source.configurationError, 500);
}

function isEnabledStatus(status: string): boolean {
  return status === "enabled";
}

function subscriptionRequiresUsageCharge(billingMode: string): boolean {
  return billingMode === "paygo";
}
