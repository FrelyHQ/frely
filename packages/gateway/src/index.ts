import { createHash } from "node:crypto";
import type { RequestExecutionCommands } from "@frely/application";
import type { BeginRequestCaptureV3StreamInput, RequestCaptureV3StreamWriter, WriteRequestCaptureV3ExchangeInput } from "@frely/capture";
import { createId, isRuntimeScopeRef, keyScopeRef, parseJsonText, RelayError, teamScopeRef, userScopeRef, type AccessPointSelectorConfig, type ProviderFailureClass, type ProviderFetchDiagnosticV1, type ScopeRef, type SelectorAttemptResult } from "@frely/core";
import { actorFromPrincipal, assertOrderedPlanSourceConfiguration, encodeBillablePriceSnapshot, encodeCostPriceSnapshot, isPlanRuntimeEnabled, usdToCreditUnits, type AccessPoint, type AccessPointPrice, type ActivePlanSubscription, type ApiKey, type BillableAccessPointPrice, type BillingEvent, type CreditAccount, type EffectivePlanAccessPointPrice, type PlanBudgetLimit, type ProviderModelCost, type User } from "@frely/application/runtime";
import type { ApiKeyPlanSourceRestrictionDecision } from "@frely/entitlement";
import { createGatewayRoutingBudget, selectNextRoutingCandidate, type GatewayRoutingAccessPointScopeReference, type GatewayRoutingQueryPort, type GatewayRoutingSnapshot, type RoutingUnavailableReason } from "@frely/model-access/routing-runtime";
import { amountForPriceProfile, normalizeRuntimePriceServiceTier, type GatewayPriceCalculation } from "@frely/pricing";
import {
  failureClassFromProviderError as failureClassFromErrorCode,
  isTrustedProviderUsage as isTrustedGatewayUsage,
  parseProviderAttemptFailure,
  parseProviderExecutionEvidence,
  providerFailureFromResponse,
  providerFailureFromThrown,
  unresolvedProviderFailure,
  type ProviderAttemptFailureV1,
  type ProviderCredentialFailureReason,
  type ProviderExecutionEvidenceV1,
  type ProviderRuntimeApiFormat,
  type ProviderRuntime,
  type ProviderRuntimeRequestKind,
  type ProviderRuntimeResponse,
  type ProviderStreamEvent,
  type ProviderUsage,
} from "@frely/provider-runtime";
import { arbitrateProviderAttemptFailure, assertRequestExecutionLeaseFreshForDispatch, type RequestExecutionLeasePort } from "@frely/request-execution";
import { listIngressPlugins, validateIngressPluginConfig, type InvokedIngressPlugin } from "./ingress-plugins/index.js";
import {
  ACCESS_RESOLUTION_PORT_PERMISSION,
  adaptIngressPlugin,
  BILLING_CALCULATION_PORT_PERMISSION,
  BUDGET_ENFORCEMENT_PORT_PERMISSION,
  capabilityToken,
  ExecutionPlanCache,
  listGatewayPolicyPipelinePlugins,
  PipelineHookExecutionError,
  PipelineRequestSession,
  PLAN_SUBSCRIPTION_SELECTION_PORT_PERMISSION,
  PRICING_QUOTE_PORT_PERMISSION,
  type PipelineInvocationSnapshot,
  type PipelinePhase,
  type PipelinePlugin,
  type PipelinePluginSetting as RuntimePipelinePluginSetting,
  type PluginPermission,
} from "./pipeline/index.js";
import {
  DisabledProductionShadowRiskGuard,
  type AsyncProductionShadowRiskGuardLike,
  type AsyncProductionShadowRiskLease,
  type ProductionShadowRiskGuardLike,
  type ProductionShadowRiskLease,
} from "./production-shadow-risk-guard.js";
import { assertPersonalProviderPolicy, AsyncBudgetService, AsyncPricingService, AsyncRateLimitService, type AsyncGatewayPolicyGuards, type AsyncSubscriptionSelection } from "./async-services.js";
import type { GatewayCommands, GatewayQueries } from "./async-gateway-contract.js";
import { AsyncGatewayModelService } from "./async-gateway.js";

export * from "./ingress-plugins/index.js";
export * from "./internal-api-client.js";
export * from "./pipeline/index.js";
export * from "./production-shadow-risk-guard.js";
export * from "./async-gateway.js";
export type { GatewayCommands, GatewayQueries } from "./async-gateway-contract.js";
export * from "./async-services.js";
export * from "./async-policy-guards.js";
export * from "./request-context.js";
export type {
  ProviderAttemptFailureV1,
  ProviderStreamEvent,
} from "@frely/provider-runtime";

export type GatewayRequestKind = ProviderRuntimeRequestKind;
export type GatewayApiFormat = ProviderRuntimeApiFormat;
export type GatewayUsage = ProviderUsage;

export interface RequestExecutionLeaseProfile {
  leaseTtlSeconds: number;
}

const DEFAULT_REQUEST_EXECUTION_LEASE_PROFILE: RequestExecutionLeaseProfile = Object.freeze({ leaseTtlSeconds: 1_800 });
const unavailableRequestExecutionLeases: RequestExecutionLeasePort = Object.freeze({
  async acquire() { throw new RelayError("request_execution_lease_unavailable", "Request Execution lease service is unavailable", 503); },
  async renew() { throw new RelayError("request_execution_lease_unavailable", "Request Execution lease service is unavailable", 503); },
  async release() { throw new RelayError("request_execution_lease_unavailable", "Request Execution lease service is unavailable", 503); },
});

export interface BudgetSubscriptionSummaryLimit {
  limit: PlanBudgetLimit;
  limitScope: PlanBudgetLimit["limitScope"];
  periodStart: string;
  periodEnd: string;
  usage: { usedTokens: number; usedAmount: number };
}

/** PostgreSQL-backed Gateway executor. */
export class AsyncGatewayExecutor {
  readonly pricing: AsyncPricingService;
  readonly budgets: AsyncBudgetService;
  readonly rateLimits: AsyncRateLimitService;
  private readonly domainPipelinePlanCache = new ExecutionPlanCache(32);
  private readonly domainPipelineRequests = new WeakMap<object, GatewayDomainPipelineRequestInput>();
  private readonly domainPipelineArtifacts = new WeakMap<object, GatewayDomainArtifactBinding>();
  private readonly domainPipelinePorts: ReadonlyMap<PluginPermission, unknown>;

  constructor(
    readonly queries: GatewayQueries,
    readonly commands: GatewayCommands,
    readonly providerRuntime: ProviderRuntime,
    readonly requestCaptures: RequestCaptureStore,
    readonly policyGuards: AsyncGatewayPolicyGuards,
    readonly auditDenied: (input: Parameters<typeof import("@frely/application/runtime").auditDeniedAsync>[1]) => Promise<void>,
    readonly productionShadowRiskGuard: AsyncProductionShadowRiskGuardLike = new DisabledProductionShadowRiskGuard(),
    readonly requestExecutionLeaseProfile: RequestExecutionLeaseProfile = DEFAULT_REQUEST_EXECUTION_LEASE_PROFILE,
    readonly providerInvocation?: RequestExecutionCommands,
    readonly routingQueries?: GatewayRoutingQueryPort,
    readonly requestExecutionLeases: RequestExecutionLeasePort = unavailableRequestExecutionLeases,
    readonly billingQueries: Pick<GatewayQueries,
      "findCreditAccountForScope" | "getCreditAccountBalance" | "getCreditAccountBalanceUnits"
      | "findEffectivePlanAccessPointPrices" | "findEnabledAccessPointPrices" | "findEnabledProviderModelCosts"
      | "listPlanBudgetLimitsForPlans" | "listScopeBudgetPolicyAssignments" | "listScopeGovernanceBudgetPolicyAssignments"
      | "usageForSubscription" | "usageForSubscriptionUser" | "usageForScope" | "listPlanSubscriptionBudgetUsage" | "summarizeScopeBudgetUsageWindows"
    > = queries,
  ) {
    this.pricing = new AsyncPricingService(billingQueries);
    this.budgets = new AsyncBudgetService(queries, policyGuards, billingQueries);
    this.rateLimits = new AsyncRateLimitService(queries);
    this.domainPipelinePorts = new Map<PluginPermission, unknown>([
      [PLAN_SUBSCRIPTION_SELECTION_PORT_PERMISSION, Object.freeze({
        select: async (requestHandle: unknown): Promise<unknown> => {
          const request = this.domainPipelineRequest(requestHandle);
          const selection = await this.budgets.selectSubscription(
            request.principal,
            request.model,
            request.payload,
            new Set(request.excludedPlanSourceOrderIds),
          );
          return this.bindDomainPipelineArtifact(requestHandle, "subscription-selection", Object.freeze({
            schemaVersion: 1,
            kind: "subscription-selection",
            planSourceOrderId: selection.planSourceOrderId,
            planId: selection.subscription.plan.id,
            subscriptionId: selection.subscription.subscription.id,
            subscriptionScopeRef: selection.subscription.subscription.scopeRef,
            entryAccessPointId: selection.accessPoint.id,
            effectivePriceId: selection.effectivePrice.price.id,
          }), selection);
        },
      })],
      [ACCESS_RESOLUTION_PORT_PERMISSION, Object.freeze({
        resolve: async (requestHandle: unknown, selectionIntent: unknown): Promise<unknown> => {
          const request = this.domainPipelineRequest(requestHandle);
          const selection = this.domainPipelineArtifact<AsyncSubscriptionSelection>(requestHandle, "subscription-selection", selectionIntent);
          const routingSnapshot = await this.requireRoutingQueries().evaluateGatewayRouting({
            entryAccessPointId: selection.accessPoint.id,
            requestedModel: request.model,
            budget: request.routingBudget,
          });
          await this.assertRoutingScopePolicies(routingSnapshot);
          const candidatePlan = gatewayAccessCandidatePlan(
            routingSnapshot,
            selection.subscription.subscription.scopeRef as ScopeRef,
            selection.accessPoint,
          );
          const resolution = candidatePlan.candidates.find((candidate) => candidate.candidateId === routingSnapshot.selectedCandidateId);
          if (!resolution) throw modelUnavailable();
          return this.bindDomainPipelineArtifact(requestHandle, "access-resolution", Object.freeze({
            schemaVersion: 1,
            kind: "access-resolution",
            entryAccessPointId: resolution.accessPointChain[0]!.id,
            accessPointChainIds: Object.freeze(resolution.accessPointChain.map((accessPoint) => accessPoint.id)),
            providerId: resolution.providerId,
            providerModelName: resolution.tarModel,
            providerModelId: resolution.providerModelId,
            selectorId: candidatePlan.selectorId,
            selectorBehaviorVersion: candidatePlan.selectorBehaviorVersion,
            routingRevision: candidatePlan.routingRevision,
            candidateIds: Object.freeze(candidatePlan.candidates.map((candidate) => candidate.candidateId)),
          }), Object.freeze({ resolution, candidatePlan, routingSnapshot }));
        },
      })],
      [PRICING_QUOTE_PORT_PERMISSION, Object.freeze({
        quote: async (requestHandle: unknown, selectionIntent: unknown, accessIntent: unknown): Promise<unknown> => {
          this.domainPipelineRequest(requestHandle);
          const selection = this.domainPipelineArtifact<AsyncSubscriptionSelection>(requestHandle, "subscription-selection", selectionIntent);
          const access = this.domainPipelineArtifact<Readonly<{ resolution: AccessCandidate; candidatePlan: AccessCandidatePlan; routingSnapshot: GatewayRoutingSnapshot }>>(requestHandle, "access-resolution", accessIntent);
          const providerModelRefs = [...new Map(access.candidatePlan.candidates.map((resolution) => [
            `${resolution.providerId}\u0000${resolution.tarModel}`,
            { providerId: resolution.providerId, providerModelName: resolution.tarModel },
          ])).values()];
          const providerModelCosts = await this.billingQueries.findEnabledProviderModelCosts(providerModelRefs);
          const providerModelCostsByKey = new Map(providerModelCosts.map((cost) => [`${cost.providerId}\u0000${cost.providerModelName}`, cost]));
          const accessPointIds = [...new Set(access.candidatePlan.candidates.flatMap((resolution) => resolution.accessPointChain.map((accessPoint) => accessPoint.id)))];
          const accessPointPrices = await this.billingQueries.findEnabledAccessPointPrices(accessPointIds);
          const accessPointPricesById = new Map(accessPointPrices.map((price) => [price.accessPointId, price]));
          const candidates = new Map<string, { resolution: AccessCandidate; providerModelCost: ProviderModelCost; accessPointPrices: readonly AccessPointPrice[] }>();
          for (const resolution of access.candidatePlan.candidates) {
            const providerModelCost = providerModelCostsByKey.get(`${resolution.providerId}\u0000${resolution.tarModel}`);
            if (!providerModelCost) throw new RelayError("provider_model_cost_not_configured", `Provider model ${resolution.providerId}:${resolution.tarModel} has no enabled cost`, 500);
            const candidateAccessPointPrices: AccessPointPrice[] = [];
            for (const accessPoint of resolution.accessPointChain) {
              const price = accessPointPricesById.get(accessPoint.id);
              if (!price) throw new RelayError("access_point_price_not_configured", `AccessPoint ${accessPoint.id} has no enabled price`, 500);
              candidateAccessPointPrices.push(price);
            }
            candidates.set(resolution.candidateId, Object.freeze({ resolution, providerModelCost, accessPointPrices: Object.freeze(candidateAccessPointPrices) }));
          }
          const priceInputs: CandidateQuoteSet = Object.freeze({ effectivePrice: selection.effectivePrice, candidates });
          return this.bindDomainPipelineArtifact(requestHandle, "price-quote", Object.freeze({
            schemaVersion: 1,
            kind: "price-quote",
            billablePriceId: selection.effectivePrice.price.id,
            billablePriceSource: selection.effectivePrice.source,
            candidateQuoteIds: Object.freeze([...candidates.values()].map((candidate) => candidate.providerModelCost.id)),
          }), priceInputs);
        },
      })],
      [BUDGET_ENFORCEMENT_PORT_PERMISSION, Object.freeze({
        enforce: async (requestHandle: unknown, selectionIntent: unknown, accessIntent: unknown, priceIntent: unknown): Promise<unknown> => {
          const request = this.domainPipelineRequest(requestHandle);
          const selection = this.domainPipelineArtifact<AsyncSubscriptionSelection>(requestHandle, "subscription-selection", selectionIntent);
          this.domainPipelineArtifact(requestHandle, "access-resolution", accessIntent);
          this.domainPipelineArtifact(requestHandle, "price-quote", priceIntent);
          if (!request.requestLevelGatesChecked) {
            await this.budgets.checkDirectHardStops(request.principal);
            await this.rateLimits.checkGovernance(request.principal);
          }
          return this.bindDomainPipelineArtifact(requestHandle, "budget-decision", Object.freeze({ schemaVersion: 1, kind: "budget-decision", approved: true }), true);
        },
      })],
      [BILLING_CALCULATION_PORT_PERMISSION, Object.freeze({
        calculate: async (requestHandle: unknown, selectionIntent: unknown, accessIntent: unknown, priceIntent: unknown, budgetIntent: unknown, usageIntent: unknown): Promise<unknown> => {
          const request = this.domainPipelineRequest(requestHandle);
          const selection = this.domainPipelineArtifact<AsyncSubscriptionSelection>(requestHandle, "subscription-selection", selectionIntent);
          this.domainPipelineArtifact<Readonly<{ resolution: AccessCandidate; candidatePlan: AccessCandidatePlan }>>(requestHandle, "access-resolution", accessIntent);
          this.domainPipelineArtifact(requestHandle, "price-quote", priceIntent);
          this.domainPipelineArtifact(requestHandle, "budget-decision", budgetIntent);
          const usage = this.domainPipelineArtifact<BillingUsageCalculationInput>(requestHandle, "validated-usage", usageIntent);
          const draft = await this.calculateProviderBillingDraft({
            requestId: request.requestId,
            usage: usage.usage,
            operations: usage.operations.map((operation) => ({ ...operation })),
            effectivePrice: selection.effectivePrice,
            resolution: usage.resolution,
            providerAttemptId: usage.providerAttemptId,
            accessPointPrices: [...usage.accessPointPrices],
            subscription: selection.subscription,
            usageChargeAccount: selection.usageChargeAccount,
            actorUserId: request.principal.user.id,
            serviceTier: usage.serviceTier,
            requireServiceTier: usage.requireServiceTier,
          });
          return this.bindDomainPipelineArtifact(requestHandle, "billing-draft", Object.freeze({ schemaVersion: 1, kind: "billing-draft", operationCount: usage.operations.length }), draft);
        },
      })],
    ]);
  }

  private createDomainPipelineSession(input: GatewayDomainPipelineRequestInput, signal?: AbortSignal): Readonly<{ requestHandle: object; session: PipelineRequestSession }> {
    const requestHandle = Object.freeze({ schemaVersion: 1, kind: "gateway-domain-request" });
    this.domainPipelineRequests.set(requestHandle, input);
    const plan = this.domainPipelinePlanCache.getOrCompile({
      kernelApiVersion: 1,
      plugins: listGatewayPolicyPipelinePlugins(),
      settings: Object.freeze({ revision: "gateway-policy-builtins-v1", settings: Object.freeze([]) }),
      applicability: Object.freeze({ cacheKey: "gateway-policy-v1", facts: Object.freeze({ executionLayer: "gateway" }) }),
      availableCapabilities: Object.freeze([capabilityToken("request:original"), capabilityToken("usage:measured")]),
      availablePorts: this.domainPipelinePorts,
    });
    const session = new PipelineRequestSession(plan, Object.freeze({ originalRequest: requestHandle }), signal ? { signal } : {});
    return Object.freeze({ requestHandle, session });
  }

  private domainPipelineRequest(value: unknown): GatewayDomainPipelineRequestInput {
    if (!value || typeof value !== "object") throw new RelayError("request_policy_error", "Pipeline request handle is invalid", 500);
    const request = this.domainPipelineRequests.get(value);
    if (!request) throw new RelayError("request_policy_error", "Pipeline request handle is stale or untrusted", 500);
    return request;
  }

  private bindDomainPipelineArtifact(requestHandle: unknown, kind: GatewayDomainArtifactKind, safeIntent: object, authoritativeValue: unknown): object {
    this.domainPipelineRequest(requestHandle);
    this.domainPipelineArtifacts.set(safeIntent, Object.freeze({ requestHandle: requestHandle as object, kind, authoritativeValue }));
    return safeIntent;
  }

  private domainPipelineArtifact<T>(requestHandle: unknown, kind: GatewayDomainArtifactKind, value: unknown): T {
    this.domainPipelineRequest(requestHandle);
    if (!value || typeof value !== "object") throw new RelayError("request_policy_error", `Pipeline ${kind} intent is missing`, 500);
    const binding = this.domainPipelineArtifacts.get(value);
    if (!binding || binding.requestHandle !== requestHandle || binding.kind !== kind) throw new RelayError("request_policy_error", `Pipeline ${kind} intent is stale or untrusted`, 500);
    return binding.authoritativeValue as T;
  }

  private releaseDomainPipelineRequest(requestHandle: object | undefined): void {
    if (requestHandle) this.domainPipelineRequests.delete(requestHandle);
  }

  private async executeDomainPipelinePhase(session: PipelineRequestSession, phase: PipelinePhase): Promise<void> {
    try {
      await session.executePhase(phase);
    } catch (error) {
      throw domainPipelineError(error);
    }
  }

  async listModels(principal: Principal, signal?: AbortSignal): Promise<ProviderAdapterResponse> {
    return new AsyncGatewayModelService(this.queries, this.policyGuards, this.requireRoutingQueries()).listModels(principal, signal);
  }

  private requireRoutingQueries(): GatewayRoutingQueryPort {
    if (!this.routingQueries) throw new RelayError("model_access_routing_unavailable", "Model Access routing is unavailable", 503);
    return this.routingQueries;
  }

  private async assertRoutingScopePolicies(snapshot: GatewayRoutingSnapshot): Promise<void> {
    await this.policyGuards.assertPartnerAccessActiveForScopes(
      [...new Set(snapshot.scopeReferences.accessPoints.map((accessPoint) => accessPoint.scopeRef as ScopeRef))],
      snapshot.evaluatedAt,
    );
    await this.policyGuards.assertProviderAccessActiveForProviders(
      snapshot.scopeReferences.providers.map((provider) => ({ id: provider.id, scopeRef: provider.scopeRef as ScopeRef })),
      snapshot.evaluatedAt,
    );
  }

  async invoke(principal: Principal, input: { kind: GatewayRequestKind; model: string; payload: Record<string, unknown>; stream?: boolean; requestId?: string; requestPath?: string; ingressHostname?: string; ingressRouteId?: string | null; sourceFormat?: GatewayApiFormat; timing?: RequestTiming; signal?: AbortSignal }): Promise<ProviderAdapterResponse> {
    const requestId = input.requestId ?? createId("req");
    const invocationCommands = this.providerInvocation;
    if (!invocationCommands) {
      throw new RelayError("provider_invocation_service_unavailable", "Provider invocation command service is unavailable", 503);
    }
    const providerInvocation = this.providerRuntime.preparationStage === "stage1" ? undefined : invocationCommands;
    const cpaBasicInvocation = this.providerRuntime.preparationStage === "stage1" ? invocationCommands : undefined;
    const routingBudget = createGatewayRoutingBudget(input.signal);
    const captureEnabled = await this.queries.isRequestCaptureEnabled();
    const originalPayload = captureEnabled ? structuredClone(input.payload) : input.payload;
    let effectivePayload: Record<string, unknown> = { ...originalPayload };
    let capturedEffectivePayload: unknown = effectivePayload;
    let captureUnavailableReason: "ingress_plugin_failed" | "capture_encoding_failed" | undefined;
    let captureTerminalAttempted = false;
    let captureErrorCode: string | null = null;
    let captureSummary: GatewayProviderSummary | undefined;
    let invokedIngressPlugins: readonly InvokedIngressPlugin[] = [];
    const pipelineSnapshots: PipelineInvocationSnapshot[] = [];
    let requestPipelineSession: PipelineRequestSession | undefined;
    let domainPipelineSession: PipelineRequestSession | undefined;
    let domainPipelineRequestHandle: object | undefined;
    let detachDomainPipelineAbort: (() => void) | undefined;
    let pipelineSnapshotFinalized = false;
    let requestLogStarted = false;
    let requestLogFinished = false;
    const requestExecutionOwnerId = createId("request_lease");

    const startRequestAttempt = async (plugins: readonly InvokedIngressPlugin[], capture: { effectivePayload?: unknown; unavailableReason?: "ingress_plugin_failed" }): Promise<void> => {
      const requestLog = await this.commands.createRequestLog({
        id: requestId,
        apiKeyId: principal.apiKey.id,
        userId: principal.user.id,
        teamId: null,
        planId: null,
        planSubscriptionId: null,
        entryAccessPointId: null,
        billingScopeRef: null,
        providerId: null,
        requestPath: input.requestPath ?? null,
        ingressHostname: input.ingressHostname ?? null,
        ingressRouteId: input.ingressRouteId ?? null,
        reqModel: input.model,
        tarModel: null,
        ingressPlugins: plugins,
        status: "started",
        errorCode: null,
        endedAt: null,
      });
      await this.requestExecutionLeases.acquire({ requestId, ownerId: requestExecutionOwnerId, leaseTtlSeconds: this.requestExecutionLeaseProfile.leaseTtlSeconds });
      requestLogStarted = true;
      capturedEffectivePayload = capture.effectivePayload;
      captureUnavailableReason = capture.unavailableReason;
      void requestLog;
    };
    const recordCaptureFailure = (error: unknown, fallbackCode: string): void => {
      if (captureErrorCode) return;
      captureErrorCode = requestCaptureFailureCode(error, fallbackCode);
      if (captureSummary) captureSummary.captureErrorCode = captureErrorCode;
      console.warn(JSON.stringify({ event: "request.capture.unavailable", requestId, errorCode: captureErrorCode }));
    };
    const completeCapture = async (response: { status: number; body: unknown; errorCode?: string | null }): Promise<void> => {
      if (!captureEnabled || captureTerminalAttempted || !requestLogStarted) return;
      captureTerminalAttempted = true;
      try {
        const requestLog = await this.queries.getRequestLog(requestId);
        if (!requestLog) throw new RelayError("request_log_not_found", "Request Log is required to write Request Capture", 500);
        await this.requestCaptures.writeCapturedExchange({
          requestLogStartedAt: requestLog.startedAt,
          requestId,
          apiKeyId: requestLog.apiKeyId,
          userId: requestLog.userId,
          teamId: requestLog.teamId,
          kind: input.kind,
          reqModel: requestLog.reqModel,
          originalPayload,
          ...(captureUnavailableReason ? { unavailableReason: captureUnavailableReason } : { effectivePayload: capturedEffectivePayload }),
          requestCapturedAt: requestLog.startedAt,
          response: { ...response, capturedAt: requestLog.endedAt ?? new Date().toISOString() },
        });
      } catch (error) {
        recordCaptureFailure(error, "request_capture_write_failed");
      }
    };

    try {
      const execution = await executeIngressPipelineAsync(this.queries, scopeRefsForPrincipal(principal), input.kind, effectivePayload, input.signal);
      effectivePayload = execution.payload;
      invokedIngressPlugins = execution.invokedPlugins;
      pipelineSnapshots.push(execution.pipelineSnapshot);
      requestPipelineSession = execution.session;
    } catch (error) {
      const invoked = error instanceof IngressPipelineExecutionError ? error.ingressPlugins : invokedIngressPlugins;
      if (error instanceof IngressPipelineExecutionError) pipelineSnapshots.push(error.pipelineSnapshot);
      const start = () => startRequestAttempt(invoked, { unavailableReason: "ingress_plugin_failed" });
      if (input.timing) await input.timing.measureAsync("request_log.start", start);
      else await start();
      const code = "ingress_plugin_failed";
      await finalizePipelineSnapshotsAsync(this.commands, requestId, pipelineSnapshots, () => pipelineSnapshotFinalized = true);
      await this.commands.finishRequestLog(requestId, "failed", code);
      await releaseRequestExecutionLeaseAsync(this.requestExecutionLeases, requestId, requestExecutionOwnerId);
      await completeCapture({ status: 500, body: { error: { code, message: "Ingress request transformation failed" } }, errorCode: code });
      throw new RelayError(code, "Ingress request transformation failed", 500);
    }
    const start = () => startRequestAttempt(invokedIngressPlugins, { effectivePayload });
    if (input.timing) await input.timing.measureAsync("request_log.start", start);
    else await start();
    const finishRequestLog = async (status: string, errorCode?: string | null, failureReason?: ProviderCredentialFailureReason | null): Promise<void> => {
      if (requestLogFinished) return;
      requestLogFinished = true;
      try {
        if (!pipelineSnapshotFinalized) {
          const snapshots = domainPipelineSession ? [...pipelineSnapshots, domainPipelineSession.invocationSnapshot()] : pipelineSnapshots;
          await finalizePipelineSnapshotsAsync(this.commands, requestId, snapshots, () => pipelineSnapshotFinalized = true);
        }
        await this.commands.finishRequestLog(requestId, status, errorCode, failureReason);
        await releaseRequestExecutionLeaseAsync(this.requestExecutionLeases, requestId, requestExecutionOwnerId);
      } finally {
        detachDomainPipelineAbort?.();
        detachDomainPipelineAbort = undefined;
        requestPipelineSession?.finish();
        domainPipelineSession?.finish();
        this.releaseDomainPipelineRequest(domainPipelineRequestHandle);
      }
    };

    const sourceFormat = input.sourceFormat ?? gatewayApiFormatForKind(input.kind);
    let resolution!: AccessCandidate;
    let candidatePlan!: AccessCandidatePlan;
    let routingSnapshot!: GatewayRoutingSnapshot;
    let candidateQuoteSet!: CandidateQuoteSet;
    let selectedProviderAttemptId: string | null = null;
    let credentialFailureReason: ProviderCredentialFailureReason | null = null;
    let productionShadowRiskLease: AsyncProductionShadowRiskLease | null = null;
    const entitlementPayload = { ...effectivePayload };
    let priceInputs!: { accessPointPrice: BillableAccessPointPrice; providerModelCost: ProviderModelCost };
    let selectedSubscription!: ActivePlanSubscription;
    let selectedUsageChargeAccount!: CreditAccount | null;
    let selectedPlanSourceOrderId = "";
    let billingServiceTier: string = normalizeRuntimePriceServiceTier(typeof entitlementPayload.service_tier === "string" ? entitlementPayload.service_tier : undefined);
    let requireProviderServiceTier = false;
    const excludedPlanSourceOrderIds = new Set<string>();
    let requestLevelGatesChecked = false;
    const selectPlanSource = async (): Promise<void> => {
      if (domainPipelineSession) {
        pipelineSnapshots.push(domainPipelineSession.invocationSnapshot());
        domainPipelineSession.finish();
        this.releaseDomainPipelineRequest(domainPipelineRequestHandle);
        domainPipelineSession = undefined;
        domainPipelineRequestHandle = undefined;
      }
      detachDomainPipelineAbort?.();
      const domainPipelineAbort = new AbortController();
      const forwardDomainPipelineAbort = (): void => domainPipelineAbort.abort(input.signal?.reason);
      if (input.signal?.aborted) forwardDomainPipelineAbort();
      else input.signal?.addEventListener("abort", forwardDomainPipelineAbort, { once: true });
      detachDomainPipelineAbort = () => input.signal?.removeEventListener("abort", forwardDomainPipelineAbort);
      const domainExecution = this.createDomainPipelineSession(Object.freeze({
        requestId, principal, kind: input.kind, model: input.model, payload: entitlementPayload, sourceFormat,
        billingServiceTier, excludedPlanSourceOrderIds: Object.freeze([...excludedPlanSourceOrderIds]),
        requestLevelGatesChecked,
        routingBudget,
        ...(input.signal ? { signal: input.signal } : {}),
      }), domainPipelineAbort.signal);
      domainPipelineSession = domainExecution.session;
      domainPipelineRequestHandle = domainExecution.requestHandle;
      const executeDomainPhase = async (stage: RequestTimingStage, phase: PipelinePhase): Promise<void> => {
        const execute = () => this.executeDomainPipelinePhase(domainExecution.session, phase);
        if (input.timing) await input.timing.measureAsync(stage, execute);
        else await execute();
      };
      await executeDomainPhase("budget.check", "access.candidates");
      await executeDomainPhase("access.resolve", "access.select");
      await executeDomainPhase("price.lookup", "pricing.quote");
      const artifacts = domainExecution.session.context.artifactReader();
      const selected = this.domainPipelineArtifact<AsyncSubscriptionSelection>(domainExecution.requestHandle, "subscription-selection", artifacts.get("subscriptionSelection"));
      const access = this.domainPipelineArtifact<Readonly<{ resolution: AccessCandidate; candidatePlan: AccessCandidatePlan; routingSnapshot: GatewayRoutingSnapshot }>>(domainExecution.requestHandle, "access-resolution", artifacts.get("accessResolution"));
      const quotedPrices = this.domainPipelineArtifact<CandidateQuoteSet>(domainExecution.requestHandle, "price-quote", artifacts.get("priceQuote"));
      this.domainPipelineArtifact(domainExecution.requestHandle, "budget-decision", artifacts.get("budgetDecision"));
      requestLevelGatesChecked = true;
      selectedPlanSourceOrderId = selected.planSourceOrderId;
      selectedSubscription = selected.subscription;
      selectedUsageChargeAccount = selected.usageChargeAccount;
      effectivePayload = selected.effectivePayload;
      billingServiceTier = providerInvocation
        ? normalizeProviderInvocationServiceTier(selected.billingServiceTier)
        : selected.billingServiceTier;
      requireProviderServiceTier = selected.requireProviderServiceTier || Boolean(providerInvocation && selected.billingServiceTier !== "standard");
      if (providerInvocation && typeof effectivePayload.service_tier === "string") {
        effectivePayload = { ...effectivePayload, service_tier: billingServiceTier };
      }
      capturedEffectivePayload = effectivePayload;
      candidatePlan = access.candidatePlan;
      routingSnapshot = access.routingSnapshot;
      resolution = access.candidatePlan.candidates.find((candidate) => candidate.candidateId === access.resolution.candidateId)!;
      candidateQuoteSet = quotedPrices;
      const initialQuote = quotedPrices.candidates.get(resolution.candidateId);
      if (!initialQuote) throw new RelayError("request_policy_error", "Selected candidate quote is missing", 500);
      priceInputs = { accessPointPrice: quotedPrices.effectivePrice.price, providerModelCost: initialQuote.providerModelCost };
      detachDomainPipelineAbort();
      detachDomainPipelineAbort = undefined;
    };
    try {
      await selectPlanSource();
    } catch (error) {
      const normalizedError = domainPipelineError(error);
      await this.auditDenied({
        actor: actorFromPrincipal(principal),
        source: "gateway",
        requestId,
        action: "gateway.request.failed_policy",
        resource: { resourceType: "gateway_request", resourceId: requestId },
        error: normalizedError,
        metadata: { apiKeyId: principal.apiKey.id, userId: principal.user.id, reqModel: input.model, kind: input.kind },
      });
      if (requestLogStarted) await finishRequestLog("failed", normalizedError instanceof RelayError ? normalizedError.code : "request_policy_error");
      const code = normalizedError instanceof RelayError ? normalizedError.code : "request_policy_error";
      await completeCapture({ status: normalizedError instanceof RelayError ? normalizedError.status : 500, body: { error: { ...(normalizedError instanceof RelayError ? normalizedError.details : {}), code, message: normalizedError instanceof Error ? normalizedError.message : "Request policy failed" } }, errorCode: code });
      throw normalizedError;
    }

    let resolvedTeamId = teamIdFromScopeRef(selectedSubscription.subscription.scopeRef as ScopeRef);
    if (!providerInvocation) await this.commands.enrichRequestLogResolution(requestId, {
      teamId: resolvedTeamId,
      planId: selectedSubscription.plan.id,
      planSubscriptionId: selectedSubscription.subscription.id,
      entryAccessPointId: (resolution.accessPointChain[0] ?? resolution.accessPoint).id,
      billingScopeRef: selectedSubscription.subscription.scopeRef,
      ...(candidatePlan.selectorId === "direct" ? { providerId: resolution.providerId, tarModel: resolution.tarModel } : {}),
    });
    const gatewaySummary: GatewayProviderSummary = { providerKind: null, accessPointId: (resolution.accessPointChain[0] ?? resolution.accessPoint).id, billingSubscriptionId: selectedSubscription.subscription.id, usageSource: null, errorCode: null, captureErrorCode };
    captureSummary = gatewaySummary;
    let billingCommitPromise: Promise<void> | null = null;
    const commitBilling = (usage: GatewayUsage): Promise<void> => {
      if (billingCommitPromise) return billingCommitPromise;
      billingCommitPromise = (async () => {
        if (!isTrustedGatewayUsage(usage)) throw new RelayError("cpa_usage_evidence_invalid", "CPA usage evidence is incomplete or invalid", 502);
        const normalizedUsage = usage;
        const providerAttemptId = selectedProviderAttemptId ?? (() => { throw new RelayError("provider_attempt_not_selected", "Provider Attempt is unavailable for billing", 500); })();
        if (providerInvocation || cpaBasicInvocation) {
          if (!isTrustedGatewayUsage(normalizedUsage)) throw new RelayError("provider_usage_missing", "Provider final usage is required for settlement", 500);
          const settlement = {
            providerAttemptId,
            outcome: "succeeded" as const,
            outputCommitted: true,
            usage: invocationUsageUnits(normalizedUsage),
          };
          if (providerInvocation) await providerInvocation.settleFinalUsage({ ...settlement, requestTerminalStatus: "succeeded" });
          else await cpaBasicInvocation!.settleCpaBasicLive({ ...settlement, requestTerminalStatus: "succeeded" });
          gatewaySummary.usageSource = normalizedUsage.source;
          return;
        }
        const operations = [{ operationKind: "inference" as const, usage: normalizedUsage }].map((operation) => ({
          ...operation,
          amounts: this.pricing.calculate({ ...priceInputs, serviceTier: billingServiceTier, requireServiceTier: requireProviderServiceTier, inputTokens: operation.usage.inputTokens, cachedInputTokens: operation.usage.cachedInputTokens, cacheWriteTokens: operation.usage.cacheWriteTokens, outputTokens: operation.usage.outputTokens }),
        }));
        if (!domainPipelineSession || !domainPipelineRequestHandle) throw new RelayError("request_policy_error", "Domain pipeline session is unavailable", 500);
        const usageCalculation = Object.freeze({
          usage: normalizedUsage,
          resolution,
          providerAttemptId,
          accessPointPrices: candidateQuoteSet.candidates.get(resolution.candidateId)?.accessPointPrices ?? (() => { throw new RelayError("access_configuration_changed", "Selected AccessPoint prices are unavailable for billing", 409); })(),
          operations: Object.freeze(operations.map((operation) => Object.freeze({ ...operation }))),
          serviceTier: billingServiceTier,
          requireServiceTier: requireProviderServiceTier,
        });
        const usageIntent = this.bindDomainPipelineArtifact(domainPipelineRequestHandle, "validated-usage", Object.freeze({ schemaVersion: 1, kind: "validated-usage", operationCount: operations.length, usageSource: normalizedUsage.source }), usageCalculation);
        domainPipelineSession.publishTrustedArtifacts({ usage: usageIntent });
        const calculateAndWrite = async (): Promise<void> => {
          await this.executeDomainPipelinePhase(domainPipelineSession!, "billing.calculate");
          const draftIntent = domainPipelineSession!.context.artifactReader().get("billingDraft");
          const draft = this.domainPipelineArtifact<BillingCommitDraft>(domainPipelineRequestHandle!, "billing-draft", draftIntent);
          if (!providerInvocation) await this.commitProviderBillingDraft(draft);
        };
        if (input.timing) await input.timing.measureAsync("billing.write", calculateAndWrite);
        else await calculateAndWrite();
        gatewaySummary.usageSource = normalizedUsage.source;
      })();
      return billingCommitPromise;
    };
    const completeRequest = async (rawEvidence?: ProviderExecutionEvidenceV1): Promise<void> => {
      const evidence = parseProviderExecutionEvidence(rawEvidence);
      const finalUsage = evidence.costExposure === "stopped"
        && evidence.finalUsageEvidence === "final"
        && isTrustedGatewayUsage(evidence.trustedUsage)
        ? evidence.trustedUsage
        : null;
      const providerAttemptId = selectedProviderAttemptId ?? (() => { throw new RelayError("provider_attempt_not_selected", "Provider Attempt is unavailable for settlement", 500); })();
      if (!finalUsage) {
        const executionApplication = providerInvocation ?? cpaBasicInvocation!;
        await executionApplication.enterReconciliation({
          providerAttemptId,
          outcome: "succeeded",
          outputCommitted: true,
          costExposure: evidence.costExposure === "stopped" ? "stopped" : "accruing",
          finalUsageEvidence: "pending",
          reason: "provider_final_usage_pending",
        });
        try { await productionShadowRiskLease?.closeUnknown(); } catch { console.error(JSON.stringify({ event: "production_shadow_risk_guard.terminal_state_failed", reason: "state_unavailable" })); }
        const finish = () => finishRequestLog("completed");
        if (input.timing) await input.timing.measureAsync("request_log.finish", finish);
        else await finish();
        return;
      }
      await commitBilling(finalUsage);
      if (productionShadowRiskLease) {
        try {
          const actualBillableAmount = amountForPriceProfile(candidateQuoteSet.effectivePrice.price, { inputTokens: finalUsage.inputTokens, cachedInputTokens: finalUsage.cachedInputTokens, cacheWriteTokens: finalUsage.cacheWriteTokens, outputTokens: finalUsage.outputTokens }, billingServiceTier, requireProviderServiceTier);
          await productionShadowRiskLease.settle(usdToCreditUnits(actualBillableAmount));
        } catch { console.error(JSON.stringify({ event: "production_shadow_risk_guard.terminal_state_failed", reason: "state_unavailable" })); }
      }
      const finish = () => finishRequestLog("completed");
      if (input.timing) await input.timing.measureAsync("request_log.finish", finish);
      else await finish();
    };

    try {
      let response!: ProviderAdapterResponse;
      planSourceLoop: while (true) {
        const currentSubscription = (await this.queries.findActivePlanSubscriptions(selectedSubscription.subscription.scopeRef as ScopeRef)).find((subscription) => subscription.id === selectedSubscription.subscription.id);
        if (!currentSubscription) throw new RelayError("access_configuration_changed", "Selected Subscription is no longer active", 409);
        const attemptResults: SelectorAttemptResult[] = [];
        while (true) {
        const quote = candidateQuoteSet.candidates.get(resolution.candidateId);
        if (!quote) throw new RelayError("access_configuration_changed", "Candidate quote is no longer available", 409);
        priceInputs = { accessPointPrice: candidateQuoteSet.effectivePrice.price, providerModelCost: quote.providerModelCost };
        const preparedProviderInvocation = await this.providerRuntime.prepare({
          providerModelId: resolution.providerModelId,
          providerId: resolution.providerId,
          providerModelName: resolution.providerModelName,
          kind: input.kind,
          sourceFormat,
          sourceModel: input.model,
          stream: Boolean(input.stream),
          options: effectivePayload,
          serviceTier: billingServiceTier,
        });
        effectivePayload = { ...preparedProviderInvocation.options };
        const protectedPreparation = preparedProviderInvocation.preparationStage === "protected"
          ? preparedProviderInvocation
          : null;
        if (providerInvocation && !protectedPreparation) throw new RelayError("provider_preparation_evidence_missing", "Protected Provider invocation requires CPA preparation evidence", 503);
        const maximumBillableAmount = protectedPreparation
          ? amountForPriceProfile(candidateQuoteSet.effectivePrice.price, {
              inputTokens: protectedPreparation.tokenizer.inputTokens,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: protectedPreparation.effectiveMaxBillableOutputTokens,
            }, billingServiceTier, requireProviderServiceTier)
          : null;
        let attempt: { id: string };
        try {
          const runAdmission = async (): Promise<{ id: string }> => {
            await this.budgets.checkGovernanceHardStops(
              principal,
              protectedPreparation ? protectedPreparation.tokenizer.inputTokens + protectedPreparation.effectiveMaxBillableOutputTokens : 0,
              maximumBillableAmount ?? 0,
            );
            gatewaySummary.providerKind = preparedProviderInvocation.target.providerKind;
            const commonAdmission = {
              requestId,
              executionOwnerId: requestExecutionOwnerId,
              attemptIndex: attemptResults.length,
              selectorAccessPointId: candidatePlan.selectorAccessPointId,
              selectorId: candidatePlan.selectorId,
              selectorBehaviorVersion: candidatePlan.selectorBehaviorVersion,
              routingRevision: candidatePlan.routingRevision,
              routingRevisions: resolution.routingRevisions,
              candidateId: resolution.candidateId,
              selectorTargetEdgeId: resolution.selectorTargetEdgeId,
              pathTargetEdgeIds: resolution.pathTargetEdgeIds,
              accessPointChainIds: resolution.accessPointChain.map((accessPoint) => accessPoint.id),
              providerId: resolution.providerId,
              providerModelId: resolution.providerModelId,
              providerModelName: resolution.providerModelName,
              planId: selectedSubscription.plan.id,
              planSubscriptionId: selectedSubscription.subscription.id,
              apiKeyId: principal.apiKey.id,
              userId: principal.user.id,
              billablePriceSource: candidateQuoteSet.effectivePrice.source,
              billablePriceId: candidateQuoteSet.effectivePrice.price.id,
              providerModelCostId: quote.providerModelCost.id,
              accessPointPriceIds: quote.accessPointPrices.map((price) => price.id),
              usageChargeAccountId: selectedUsageChargeAccount?.id ?? null,
            } as const;
            return providerInvocation
              ? providerInvocation.admit({
                ...commonAdmission,
                inputTokens: BigInt(protectedPreparation!.tokenizer.inputTokens),
                maxOutputTokens: BigInt(protectedPreparation!.effectiveMaxBillableOutputTokens),
                tokenizerId: protectedPreparation!.tokenizer.tokenizerId,
                tokenizerVersion: protectedPreparation!.tokenizer.revision,
                preparationEvidenceId: protectedPreparation!.cpaPreparation.evidenceId,
                preparationEvidenceVersion: protectedPreparation!.cpaPreparation.evidenceVersion,
                preparedPayloadId: protectedPreparation!.cpaPreparation.preparedPayloadId,
                serviceTier: billingServiceTier,
              }).then((admission) => ({ id: admission.providerAttemptId }))
              : cpaBasicInvocation!.admitCpaBasic({
                ...commonAdmission,
                requestedServiceTier: billingServiceTier,
                requireServiceTier: requireProviderServiceTier,
              }).then((admission) => ({ id: admission.providerAttemptId }));
          };
          attempt = input.timing
            ? await input.timing.measureAsync("provider.admit", runAdmission)
            : await runAdmission();
        } catch (error) {
          const admissionError = providerAdmissionError(error);
          if ((providerInvocation || cpaBasicInvocation) && attemptResults.length === 0 && planSourceAdmissionMayTryNext(admissionError)) {
            excludedPlanSourceOrderIds.add(selectedPlanSourceOrderId);
            await selectPlanSource();
            resolvedTeamId = teamIdFromScopeRef(selectedSubscription.subscription.scopeRef as ScopeRef);
            gatewaySummary.accessPointId = (resolution.accessPointChain[0] ?? resolution.accessPoint).id;
            gatewaySummary.billingSubscriptionId = selectedSubscription.subscription.id;
            if (cpaBasicInvocation) {
              await this.commands.enrichRequestLogResolution(requestId, {
                teamId: resolvedTeamId,
                planId: selectedSubscription.plan.id,
                planSubscriptionId: selectedSubscription.subscription.id,
                entryAccessPointId: (resolution.accessPointChain[0] ?? resolution.accessPoint).id,
                billingScopeRef: selectedSubscription.subscription.scopeRef,
                ...(candidatePlan.selectorId === "direct" ? { providerId: resolution.providerId, tarModel: resolution.tarModel } : {}),
              });
            }
            continue planSourceLoop;
          }
          throw admissionError;
        }
        if (providerInvocation && attemptResults.length === 0) {
          try {
            await this.commands.enrichRequestLogResolution(requestId, {
              teamId: resolvedTeamId,
              planId: selectedSubscription.plan.id,
              planSubscriptionId: selectedSubscription.subscription.id,
              entryAccessPointId: (resolution.accessPointChain[0] ?? resolution.accessPoint).id,
              billingScopeRef: selectedSubscription.subscription.scopeRef,
              ...(candidatePlan.selectorId === "direct" ? { providerId: resolution.providerId, tarModel: resolution.tarModel } : {}),
            });
          } catch (error) {
            await providerInvocation.releaseNotStarted({
              providerAttemptId: attempt.id,
              outcome: "failed",
              failureClass: "non_retryable",
              requestTerminalStatus: "failed",
              requestTerminalErrorCode: error instanceof RelayError ? error.code : "request_log_resolution_failed",
            });
            throw error;
          }
        }
        if (maximumBillableAmount !== null && this.productionShadowRiskGuard.enforced && !productionShadowRiskLease) {
          try {
            productionShadowRiskLease = await this.productionShadowRiskGuard.acquire({ reservedCreditUnits: usdToCreditUnits(maximumBillableAmount) });
          } catch (error) {
            if (providerInvocation) {
              await providerInvocation.releaseNotStarted({
                providerAttemptId: attempt.id,
                outcome: "failed",
                failureClass: "non_retryable",
                requestTerminalStatus: "failed",
                requestTerminalErrorCode: error instanceof RelayError ? error.code : "production_shadow_risk_guard_failed",
              });
            }
            throw error;
          }
        }
        credentialFailureReason = null;
        delete gatewaySummary.errorDiagnostic;
        const attemptStartedAt = performance.now();
        try {
          const providerDispatch = await this.providerRuntime.refreshForDispatch(preparedProviderInvocation);
          const dispatchLease = await this.requestExecutionLeases.renew({ requestId, ownerId: requestExecutionOwnerId, leaseTtlSeconds: this.requestExecutionLeaseProfile.leaseTtlSeconds });
          const executionApplication = providerInvocation ?? cpaBasicInvocation!;
          await executionApplication.assertDispatchOwnership(attempt.id, requestId, requestExecutionOwnerId);
          assertRequestExecutionLeaseFreshForDispatch(dispatchLease.leaseUntil);
          response = await (input.timing?.measureAsync("provider.invoke", () => this.providerRuntime.invokeAdmittedCandidate({
            providerAttemptRef: attempt.id,
            dispatch: providerDispatch,
            ...(input.signal ? { signal: input.signal } : {}),
          })) ?? this.providerRuntime.invokeAdmittedCandidate({
            providerAttemptRef: attempt.id,
            dispatch: providerDispatch,
            ...(input.signal ? { signal: input.signal } : {}),
          }));
        } catch (error) {
          const failure = providerFailureFromThrown(error);
          credentialFailureReason = failure.failureReason ?? credentialFailureReason;
          if (failure.failureReason) gatewaySummary.errorDiagnostic = credentialFailureDiagnostic(failure);
          attemptResults.push(selectorAttemptResult(resolution, attemptResults.length, failure.failureClass, performance.now() - attemptStartedAt));
          const arbitration = arbitrateGatewayFailure(failure, false, Boolean(input.signal?.aborted));
          const canContinue = arbitration.fallbackPermitted;
          const nextId = canContinue ? selectNextRoutingCandidate(routingSnapshot.plan, routingSnapshot.candidates, attemptResults).selectedCandidateId : null;
          const next = candidatePlan.candidates.find((candidate) => candidate.candidateId === nextId);
          if (!providerInvocation && !cpaBasicInvocation && failure.trustedUsage) {
            selectedProviderAttemptId = attempt.id;
            await commitBilling(failure.trustedUsage);
          }
          await this.finalizeProviderInvocationFailure({
            providerInvocation,
            cpaBasicInvocation,
            providerAttemptId: attempt.id,
            failure,
            outcome: input.signal?.aborted ? "aborted" : "failed",
            terminal: !next,
            errorCode: error instanceof RelayError ? error.code : "provider_error",
          });
          if (next) { resolution = next; continue; }
          if (arbitration.settlement === "reconcile") throw providerInvocationReconciliationRequired();
          if (candidatePlan.selectorId === "ordered-fallback" && failure.failureClass !== "non_retryable" && !failure.failureReason) throw modelUnavailable();
          throw error;
        }
        const providerPipelineSnapshot = parsePipelineInvocationSnapshot(response.pipelineInvocationSnapshot);
        const nonStreamFailure = response.status >= 400 && !response.stream ? providerFailureFromResponse(response) : null;
        if (nonStreamFailure) {
          credentialFailureReason = nonStreamFailure.failureReason ?? credentialFailureReason;
          if (nonStreamFailure.failureReason) gatewaySummary.errorDiagnostic = credentialFailureDiagnostic(nonStreamFailure);
          attemptResults.push(selectorAttemptResult(resolution, attemptResults.length, nonStreamFailure.failureClass, performance.now() - attemptStartedAt));
          if (!providerInvocation && !cpaBasicInvocation && nonStreamFailure.trustedUsage) {
            selectedProviderAttemptId = attempt.id;
            await commitBilling(nonStreamFailure.trustedUsage);
          }
          const arbitration = arbitrateGatewayFailure(nonStreamFailure, false, false);
          const canContinue = arbitration.fallbackPermitted;
          const nextId = canContinue ? selectNextRoutingCandidate(routingSnapshot.plan, routingSnapshot.candidates, attemptResults).selectedCandidateId : null;
          const next = candidatePlan.candidates.find((candidate) => candidate.candidateId === nextId);
          await this.finalizeProviderInvocationFailure({
            providerInvocation,
            cpaBasicInvocation,
            providerAttemptId: attempt.id,
            failure: nonStreamFailure,
            outcome: "failed",
            terminal: !next,
            errorCode: providerErrorCodeFromBody(response.body),
          });
          if (next) {
            resolution = next;
            continue;
          }
          if (providerPipelineSnapshot) pipelineSnapshots.push(providerPipelineSnapshot);
          if (candidatePlan.selectorId === "ordered-fallback" && nonStreamFailure.failureClass !== "non_retryable" && !nonStreamFailure.failureReason && arbitration.settlement !== "reconcile") throw modelUnavailable();
          break;
        }
        if (response.stream) {
          if (candidatePlan.selectorId === "direct") {
            if (providerPipelineSnapshot) pipelineSnapshots.push(providerPipelineSnapshot);
            selectedProviderAttemptId = attempt.id;
            break;
          }
          let preflight: Awaited<ReturnType<AsyncGatewayExecutor["preflightProviderStream"]>>;
          try {
            preflight = await this.preflightProviderStream(response.stream, input.signal);
          } catch (error) {
            const failure = providerFailureFromThrown(error);
            credentialFailureReason = failure.failureReason ?? credentialFailureReason;
            if (failure.failureReason) gatewaySummary.errorDiagnostic = credentialFailureDiagnostic(failure);
            await this.finalizeProviderInvocationFailure({ providerInvocation, cpaBasicInvocation, providerAttemptId: attempt.id, failure, outcome: input.signal?.aborted ? "aborted" : "failed", terminal: true });
            throw error;
          }
          if (!preflight.accepted) {
            credentialFailureReason = preflight.failure.failureReason ?? credentialFailureReason;
            if (preflight.failure.failureReason) gatewaySummary.errorDiagnostic = credentialFailureDiagnostic(preflight.failure);
            attemptResults.push(selectorAttemptResult(resolution, attemptResults.length, preflight.failure.failureClass, performance.now() - attemptStartedAt));
            const arbitration = arbitrateGatewayFailure(preflight.failure, false, Boolean(input.signal?.aborted));
            const nextId = arbitration.fallbackPermitted
              ? selectNextRoutingCandidate(routingSnapshot.plan, routingSnapshot.candidates, attemptResults).selectedCandidateId
              : null;
            const next = candidatePlan.candidates.find((candidate) => candidate.candidateId === nextId);
            if (next) {
              if (preflight.failure.trustedUsage && !providerInvocation && !cpaBasicInvocation) {
                selectedProviderAttemptId = attempt.id;
                await commitBilling(preflight.failure.trustedUsage);
              }
              await this.finalizeProviderInvocationFailure({ providerInvocation, cpaBasicInvocation, providerAttemptId: attempt.id, failure: preflight.failure, outcome: "failed", terminal: false });
              resolution = next;
              continue;
            }
            if (!providerInvocation && !cpaBasicInvocation && preflight.failure.trustedUsage) {
              selectedProviderAttemptId = attempt.id;
              await commitBilling(preflight.failure.trustedUsage);
            }
            await this.finalizeProviderInvocationFailure({ providerInvocation, cpaBasicInvocation, providerAttemptId: attempt.id, failure: preflight.failure, outcome: "failed", terminal: true });
            selectedProviderAttemptId = attempt.id;
            if (providerPipelineSnapshot) pipelineSnapshots.push(providerPipelineSnapshot);
            if (candidatePlan.selectorId === "ordered-fallback" && preflight.failure.failureClass !== "non_retryable" && !preflight.failure.failureReason && arbitration.settlement !== "reconcile") throw modelUnavailable();
            response.stream = preflight.stream;
            break;
          }
          if (providerPipelineSnapshot) pipelineSnapshots.push(providerPipelineSnapshot);
          response.stream = preflight.stream;
          selectedProviderAttemptId = attempt.id;
          break;
        }
        if (providerPipelineSnapshot) pipelineSnapshots.push(providerPipelineSnapshot);
        selectedProviderAttemptId = attempt.id;
        break;
        }
        break planSourceLoop;
      }
      if (candidatePlan.selectorId !== "direct" && !(response.status >= 400 && !response.stream)) await this.commands.enrichRequestLogResolution(requestId, { providerId: resolution.providerId, tarModel: resolution.tarModel });
      response.gatewaySummary = gatewaySummary;
      if (response.status >= 400 && !response.stream) {
        gatewaySummary.errorCode = providerErrorCodeFromBody(response.body);
        const finish = () => finishRequestLog("failed", providerErrorCodeFromBody(response.body), credentialFailureReason);
        if (input.timing) await input.timing.measureAsync("request_log.finish", finish);
        else await finish();
        await completeCapture({ status: response.status, body: response.body ?? null, errorCode: providerErrorCodeFromBody(response.body) });
        try { await productionShadowRiskLease?.closeUnknown(); } catch { console.error(JSON.stringify({ event: "production_shadow_risk_guard.terminal_state_failed", reason: "state_unavailable" })); }
        return response;
      }
      if (response.stream) {
        let captureWriter: RequestCaptureV3StreamWriter | null = null;
        if (captureEnabled) {
          captureTerminalAttempted = true;
          try {
            const requestLog = await this.queries.getRequestLog(requestId);
            if (!requestLog) throw new RelayError("request_log_not_found", "Request Log is required to write Request Capture", 500);
            captureWriter = await this.requestCaptures.beginCapturedStream({ requestLogStartedAt: requestLog.startedAt, requestId, apiKeyId: requestLog.apiKeyId, userId: requestLog.userId, teamId: requestLog.teamId, kind: input.kind, reqModel: requestLog.reqModel, originalPayload, ...(captureUnavailableReason ? { unavailableReason: captureUnavailableReason } : { effectivePayload: capturedEffectivePayload }), requestCapturedAt: requestLog.startedAt, responseStatus: response.status });
          } catch (error) { recordCaptureFailure(error, "request_capture_start_failed"); }
        }
        const streamCapture = captureWriter ? asyncRequestCaptureStreamHooks(captureWriter, requestId, this.queries, recordCaptureFailure) : undefined;
        response.stream = this.wrapStreamForBilling(response.stream, {
          commitBilling,
          completeRequest,
          providerInvocationManaged: Boolean(providerInvocation || cpaBasicInvocation),
          finalizeFailure: (failure: ProviderAttemptFailureV1, outcome: "failed" | "aborted", outputCommitted: boolean, errorCode: string) => this.finalizeProviderInvocationFailure({
            providerInvocation,
            cpaBasicInvocation,
            providerAttemptId: selectedProviderAttemptId ?? (() => { throw new RelayError("provider_attempt_not_selected", "Provider Attempt is unavailable for reconciliation", 500); })(),
            failure,
            outcome,
            outputCommitted,
            terminal: true,
            errorCode,
          }),
          failRequest: async (code, diagnostic, failureReason) => {
            gatewaySummary.errorCode = code;
            if (diagnostic) gatewaySummary.errorDiagnostic = diagnostic;
            credentialFailureReason = failureReason ?? credentialFailureReason;
            const finish = () => finishRequestLog("failed", providerErrorCodeFromBody({ error: { code } }), credentialFailureReason);
            if (input.timing) await input.timing.measureAsync("request_log.finish", finish);
            else await finish();
          },
          closeRiskUnknown: async () => {
            try { await productionShadowRiskLease?.closeUnknown(); } catch { console.error(JSON.stringify({ event: "production_shadow_risk_guard.terminal_state_failed", reason: "state_unavailable" })); }
          },
          ...(streamCapture ?? {}),
        });
        if (domainPipelineSession) response.stream = domainPipelineSession.wrapAsyncIterable(response.stream);
        if (requestPipelineSession) response.stream = requestPipelineSession.wrapAsyncIterable(response.stream);
        response.stream = renewRequestExecutionLeaseStream(response.stream, () => this.requestExecutionLeases.renew({ requestId, ownerId: requestExecutionOwnerId, leaseTtlSeconds: this.requestExecutionLeaseProfile.leaseTtlSeconds }), this.requestExecutionLeaseProfile.leaseTtlSeconds);
        return response;
      }
      await completeRequest(response.evidence);
      await completeCapture({ status: response.status, body: response.body ?? null, errorCode: null });
      return response;
    } catch (error) {
      try { await productionShadowRiskLease?.closeUnknown(); } catch { console.error(JSON.stringify({ event: "production_shadow_risk_guard.terminal_state_failed", reason: "state_unavailable" })); }
      const normalizedError = domainPipelineError(error);
      const executionErrorCode = normalizedError instanceof RelayError ? normalizedError.code : "provider_error";
      try {
        await providerInvocation?.failRequestExecution(requestId, requestExecutionOwnerId, executionErrorCode);
      } catch {
        console.error(JSON.stringify({ event: "request_execution.fail_failed", requestId, errorCode: executionErrorCode }));
      }
      const finish = () => finishRequestLog("failed", normalizedError instanceof RelayError ? normalizedError.code : "provider_error", credentialFailureReason);
      if (input.timing) await input.timing.measureAsync("request_log.finish", finish);
      else await finish();
      const code = normalizedError instanceof RelayError ? normalizedError.code : "provider_error";
      await completeCapture({ status: normalizedError instanceof RelayError ? normalizedError.status : 500, body: { error: { code, message: normalizedError instanceof Error ? normalizedError.message : "Provider error" } }, errorCode: code });
      throw normalizedError;
    }
  }

  private async preflightProviderStream(stream: AsyncIterable<ProviderStreamEvent>, signal?: AbortSignal): Promise<
    | { accepted: true; stream: AsyncIterable<ProviderStreamEvent> }
    | { accepted: false; failure: ProviderAttemptFailureV1; stream: AsyncIterable<ProviderStreamEvent> }
  > {
    const iterator = stream[Symbol.asyncIterator]();
    const buffered: ProviderStreamEvent[] = [];
    try {
      while (true) {
        const next = await nextIteratorEvent(iterator, signal);
        if (next.done) return { accepted: true, stream: replayAsyncIterator(buffered, iterator) };
        const event = next.value;
        if (event.type !== "chunk" && event.type !== "done" && buffered.length >= 1_024) {
          const failure = unresolvedProviderFailure("non_retryable");
          const limitEvent: ProviderStreamEvent = { type: "error", code: "provider_stream_preflight_limit", message: "Provider stream produced too many pre-output control events", retryable: false, failure };
          await iterator.return?.();
          return { accepted: false, failure, stream: replayAsyncIterator([...buffered, limitEvent], iterator) };
        }
        buffered.push(event);
        if (event.type === "error") {
          const parsed = parseProviderAttemptFailure(event.failure);
          await iterator.return?.();
          return { accepted: false, stream: replayAsyncIterator(buffered, iterator), failure: parsed ?? unresolvedProviderFailure(failureClassFromErrorCode(event.code, event.diagnostic)) };
        }
        if (event.type === "chunk" || event.type === "done") return { accepted: true, stream: replayAsyncIterator(buffered, iterator) };
      }
    } catch (error) {
      await iterator.return?.();
      if (signal?.aborted) throw error;
      const failure = providerFailureFromThrown(error);
      const event: ProviderStreamEvent = { type: "error", code: error instanceof RelayError ? error.code : "provider_stream_failed", message: error instanceof Error ? error.message : "Provider stream failed", retryable: failure.failureClass !== "non_retryable", failure };
      return { accepted: false, failure, stream: replayAsyncIterator([...buffered, event], iterator) };
    }
  }

  private async finalizeProviderInvocationFailure(input: {
    providerInvocation: RequestExecutionCommands | undefined;
    cpaBasicInvocation?: RequestExecutionCommands | undefined;
    providerAttemptId: string;
    failure: ProviderAttemptFailureV1;
    outcome: "failed" | "aborted";
    outputCommitted?: boolean;
    terminal: boolean;
    errorCode?: string;
  }): Promise<void> {
    const outputCommitted = input.outputCommitted ?? false;
    const terminal = input.terminal ? {
      requestTerminalStatus: input.outcome,
      requestTerminalErrorCode: input.errorCode ?? input.failure.failureClass,
    } as const : {};
    const usageSettled = input.failure.costExposure === "stopped"
      && input.failure.finalUsageEvidence === "final"
      && isTrustedGatewayUsage(input.failure.trustedUsage);
    const arbitration = arbitrateGatewayFailure(input.failure, outputCommitted, input.outcome === "aborted");
    const failureEvidence = input.outcome === "failed" ? {
      failureClass: input.failure.failureClass,
      ...(input.failure.failureReason ? { failureReason: input.failure.failureReason } : {}),
    } : {};

    if (input.cpaBasicInvocation) {
      if (usageSettled && isTrustedGatewayUsage(input.failure.trustedUsage)) {
        await input.cpaBasicInvocation.settleCpaBasicLive({
          providerAttemptId: input.providerAttemptId,
          outcome: input.outcome,
          ...failureEvidence,
          outputCommitted,
          usage: invocationUsageUnits(input.failure.trustedUsage),
          ...terminal,
        });
        return;
      }
      if (arbitration.settlement === "release_not_started") {
        await input.cpaBasicInvocation.releaseNotStarted({
          providerAttemptId: input.providerAttemptId,
          outcome: input.outcome,
          ...failureEvidence,
          outputCommitted,
          ...terminal,
        });
        return;
      }
      await input.cpaBasicInvocation.enterReconciliation({
        providerAttemptId: input.providerAttemptId,
        outcome: input.outcome,
        ...failureEvidence,
        outputCommitted,
        costExposure: input.failure.costExposure === "stopped" ? "stopped" : "accruing",
        finalUsageEvidence: "pending",
        reason: "provider_final_usage_pending",
      });
      return;
    }

    if (!input.providerInvocation) {
      throw new RelayError("provider_invocation_service_unavailable", "Provider invocation command service is unavailable", 503);
    }

    if (arbitration.settlement === "release_not_started") {
      await input.providerInvocation.releaseNotStarted({
        providerAttemptId: input.providerAttemptId,
        outcome: input.outcome,
        ...failureEvidence,
        outputCommitted,
        ...terminal,
      });
      return;
    }
    if (usageSettled && isTrustedGatewayUsage(input.failure.trustedUsage)) {
      await input.providerInvocation.settleFinalUsage({
        providerAttemptId: input.providerAttemptId,
        outcome: input.outcome,
        ...failureEvidence,
        outputCommitted,
        usage: invocationUsageUnits(input.failure.trustedUsage),
        ...terminal,
      });
      return;
    }
    await input.providerInvocation.enterReconciliation({
      providerAttemptId: input.providerAttemptId,
      outcome: input.outcome,
      ...failureEvidence,
      outputCommitted,
      costExposure: input.failure.costExposure === "stopped" ? "stopped" : "accruing",
      finalUsageEvidence: "pending",
      reason: "provider_final_usage_pending",
    });
  }

  private async *wrapStreamForBilling(stream: AsyncIterable<ProviderStreamEvent>, input: {
    commitBilling: (usage: GatewayUsage) => Promise<void>;
    completeRequest: (evidence?: ProviderExecutionEvidenceV1) => Promise<void>;
    providerInvocationManaged?: boolean;
    finalizeFailure?: (failure: ProviderAttemptFailureV1, outcome: "failed" | "aborted", outputCommitted: boolean, errorCode: string) => Promise<void>;
    failRequest: (code: string, diagnostic?: ProviderFetchDiagnosticV1, failureReason?: ProviderCredentialFailureReason) => void | Promise<void>;
    closeRiskUnknown?: () => void | Promise<void>;
    captureStreamEvent?: (event: ProviderStreamEvent) => void | Promise<void>;
    captureStreamDone?: (errorCode: string | null) => void | Promise<void>;
  }): AsyncIterable<ProviderStreamEvent> {
    let settled = false;
    let captured = false;
    let publicChunkObserved = false;
    let capturePending = false;
    let pendingCaptureCode: string | null = null;
    const captureDone = async (errorCode: string | null): Promise<void> => {
      if (captured) return;
      captured = true;
      await input.captureStreamDone?.(errorCode);
    };
    const settleFailure = async (
      code: string,
      diagnostic?: ProviderFetchDiagnosticV1,
      rawFailure?: ProviderAttemptFailureV1,
      finalizeCapture = true,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      let settlementError: unknown;
      const failure = parseProviderAttemptFailure(rawFailure) ?? unresolvedProviderFailure(failureClassFromErrorCode(code, diagnostic));
      try {
        if (!input.providerInvocationManaged && failure.costExposure === "stopped" && failure.finalUsageEvidence === "final" && isTrustedGatewayUsage(failure.trustedUsage)) {
          await input.commitBilling(failure.trustedUsage);
        }
        await input.finalizeFailure?.(
          failure,
          code === "cliproxy_request_aborted" ? "aborted" : "failed",
          publicChunkObserved,
          code,
        );
      } catch (error) { settlementError = error; }
      try { await input.closeRiskUnknown?.(); } catch (error) { settlementError ??= error; }
      try { await input.failRequest(code, diagnostic, failure.failureReason); } catch (error) { settlementError ??= error; }
      if (finalizeCapture) {
        try { await captureDone(code); } catch (error) { settlementError ??= error; }
      } else {
        capturePending = true;
        pendingCaptureCode = code;
      }
      if (settlementError) throw settlementError;
    };
    try {
      for await (const event of stream) {
        const capturedEvent = event.type === "chunk"
          ? { type: "chunk" as const, data: event.data }
          : event.type === "error"
            ? { type: "error" as const, code: event.code, message: event.message, retryable: event.retryable }
            : event;
        await input.captureStreamEvent?.(capturedEvent);
        if (event.type === "chunk") {
          publicChunkObserved = true;
          if (!settled && event.terminal?.outcome === "succeeded") {
            await input.completeRequest(event.terminal.evidence);
            settled = true;
            capturePending = true;
            pendingCaptureCode = null;
          } else if (!settled && event.terminal?.outcome === "failed") {
            await settleFailure(event.terminal.code, event.terminal.diagnostic, event.terminal.failure, false);
          }
        }
        if (event.type === "error") {
          if (!settled) await settleFailure(event.code, event.diagnostic, event.failure);
          else if (capturePending) await captureDone(pendingCaptureCode);
          yield event;
          return;
        }
        if (event.type === "done") {
          if (!settled) {
            await input.completeRequest(event.evidence);
            settled = true;
          }
          await captureDone(capturePending ? pendingCaptureCode : null);
          yield event;
          return;
        }
        yield event;
      }
      if (!settled) await settleFailure("provider_stream_incomplete");
    } catch (error) {
      const code = error instanceof RelayError ? error.code : "provider_error";
      if (!settled) await settleFailure(code);
      throw error;
    } finally {
      if (!settled) await settleFailure("cliproxy_request_aborted");
      else if (capturePending && !captured) await captureDone(pendingCaptureCode);
    }
  }

  private async calculateProviderBillingDraft(input: { requestId: string; providerAttemptId: string; usage: GatewayUsage; operations: Array<{ operationKind: "inference"; usage: GatewayUsage; amounts: GatewayPriceCalculation }>; effectivePrice: EffectivePlanAccessPointPrice; resolution: AccessCandidate; accessPointPrices: AccessPointPrice[]; subscription: ActivePlanSubscription; usageChargeAccount: CreditAccount | null; actorUserId: string; serviceTier: string; requireServiceTier: boolean }): Promise<BillingCommitDraft> {
    const requiresUsageCharge = subscriptionRequiresUsageCharge(input.subscription.plan.billingMode);
    if (requiresUsageCharge && !input.usageChargeAccount) throw new RelayError("usage_charge_account_not_found", "Selected plan subscription has no usage charge account", 402);
    const inferenceOperation = input.operations[0];
    if (!inferenceOperation) throw new RelayError("provider_usage_missing", "Provider operation usage is required", 500);
    const amounts = { ...inferenceOperation.amounts, billableAmount: input.operations.reduce((sum, operation) => sum + operation.amounts.billableAmount, 0), providerCostAmount: input.operations.reduce((sum, operation) => sum + operation.amounts.providerCostAmount, 0), grossMarginAmount: input.operations.reduce((sum, operation) => sum + operation.amounts.grossMarginAmount, 0) };
    const accessPointEdges = [];
    const accessPointIds = input.resolution.accessPointChain.map((accessPoint) => accessPoint.id);
    const routingTargets = await this.queries.listAccessPointTargetsByIds(accessPointIds);
    const routingTargetsById = new Map(routingTargets.map((target) => [target.id, target]));
    for (const [index, accessPoint] of input.resolution.accessPointChain.entries()) {
      const price = input.accessPointPrices[index];
      if (!price || price.accessPointId !== accessPoint.id) throw new RelayError("access_configuration_changed", "Selected AccessPoint price is unavailable for billing", 409);
      const selectedPrice = this.pricing.calculate({ accessPointPrice: price, providerModelCost: amounts.providerModelCost, serviceTier: input.serviceTier, requireServiceTier: input.requireServiceTier, inputTokens: input.usage.inputTokens, cachedInputTokens: input.usage.cachedInputTokens, cacheWriteTokens: input.usage.cacheWriteTokens, outputTokens: input.usage.outputTokens }).accessPointPrice;
      const routingTarget = routingTargetsById.get(input.resolution.pathTargetEdgeIds[index]!);
      if (!routingTarget) throw new RelayError("access_configuration_changed", "Selected AccessPoint target is unavailable for billing", 409);
      const buyerScopeRef = index === 0 ? input.subscription.subscription.scopeRef : input.resolution.accessPointChain[index - 1]!.scopeRef;
      accessPointEdges.push({ requestId: input.requestId, edgeOrder: index + 1, chainIndex: index, buyerScopeRef, sellerScopeRef: accessPoint.scopeRef, accessPointId: accessPoint.id, targetAccessPointId: routingTarget.targetType === "access-point" ? routingTarget.targetAccessPointId : null, isInternal: buyerScopeRef === accessPoint.scopeRef, accessPointPriceId: price.id, priceTierKey: selectedPrice.selectedTierKey, priceSnapshotJson: encodeBillablePriceSnapshot(selectedPrice), inputTokens: input.usage.inputTokens, cachedInputTokens: input.usage.cachedInputTokens, cacheWriteTokens: input.usage.cacheWriteTokens, outputTokens: input.usage.outputTokens, amount: input.operations.reduce((sum, operation) => sum + amountForPriceProfile(price, operation.usage, input.serviceTier, input.requireServiceTier), 0) });
    }
    const provider = await this.queries.getProvider(input.resolution.providerId);
    if (!provider) throw new RelayError("provider_not_found", `Provider ${input.resolution.providerId} not found`, 404);
    const billingInput = {
      billingEvent: { requestId: input.requestId, billingSubscriptionId: input.subscription.subscription.id, billingScopeRef: input.subscription.subscription.scopeRef, billablePriceId: input.effectivePrice.price.id, billablePriceSource: input.effectivePrice.source, billablePriceTierKey: amounts.accessPointPrice.selectedTierKey, providerModelCostId: amounts.providerModelCost.id, providerCostTierKey: amounts.providerModelCost.selectedTierKey, inputTokens: input.usage.inputTokens, cachedInputTokens: input.usage.cachedInputTokens, cacheWriteTokens: input.usage.cacheWriteTokens, outputTokens: input.usage.outputTokens, totalTokens: input.usage.totalTokens, billableAmount: amounts.billableAmount, providerCostAmount: amounts.providerCostAmount, grossMarginAmount: amounts.grossMarginAmount, usageSource: input.usage.source, billablePriceSnapshotJson: encodeBillablePriceSnapshot(amounts.accessPointPrice), costPriceSnapshotJson: encodeCostPriceSnapshot(amounts.providerModelCost) },
      accessPointEdges,
      providerCostEvents: input.operations.map((operation) => ({ requestId: input.requestId, providerAttemptId: input.providerAttemptId, operationKind: operation.operationKind, providerOwnerScopeRef: provider.scopeRef, providerId: provider.id, providerModelName: input.resolution.tarModel, providerModelCostId: operation.amounts.providerModelCost.id, costTierKey: operation.amounts.providerModelCost.selectedTierKey, costSnapshotJson: encodeCostPriceSnapshot(operation.amounts.providerModelCost), inputTokens: operation.usage.inputTokens, cachedInputTokens: operation.usage.cachedInputTokens, cacheWriteTokens: operation.usage.cacheWriteTokens, outputTokens: operation.usage.outputTokens, amount: amountForPriceProfile(operation.amounts.providerModelCost, operation.usage, operation.amounts.providerModelCost.selectedServiceTier) })),
    };
    return Object.freeze({ facts: billingInput, requiresUsageCharge, usageChargeAccountId: input.usageChargeAccount?.id ?? null, actorUserId: input.actorUserId, allowUsageOverdraft: this.providerRuntime.preparationStage === "stage1" });
  }

  private async commitProviderBillingDraft(draft: BillingCommitDraft): Promise<BillingEvent> {
    return (await this.commands.settleProviderUsage({
      facts: draft.facts,
      requiresUsageCharge: draft.requiresUsageCharge,
      usageChargeAccountId: draft.usageChargeAccountId,
      actorUserId: draft.actorUserId,
      allowUsageOverdraft: draft.allowUsageOverdraft,
    })).billingEvent;
  }
}

export interface BudgetSubscriptionSummary extends Omit<ActivePlanSubscription, "budgetLimits"> {
  budgetLimits: BudgetSubscriptionSummaryLimit[];
}

export interface RequestCaptureStore {
  writeCapturedExchange(input: WriteRequestCaptureV3ExchangeInput): unknown;
  beginCapturedStream(input: BeginRequestCaptureV3StreamInput): Promise<RequestCaptureV3StreamWriter>;
}

const disabledRequestCaptureStore: RequestCaptureStore = {
  writeCapturedExchange: () => undefined,
  beginCapturedStream: async () => ({
    appendEvent: async () => undefined,
    finalize: async () => undefined,
    abort: async () => undefined
  })
};

const ingressPipelinePlugins: readonly PipelinePlugin<unknown>[] = Object.freeze(
  listIngressPlugins().map((plugin) => adaptIngressPlugin(plugin) as unknown as PipelinePlugin<unknown>)
);
const ingressPipelinePlanCache = new ExecutionPlanCache(128);

class IngressPipelineExecutionError extends Error {
  readonly pipelineSnapshot: PipelineInvocationSnapshot;
  readonly ingressPlugins: readonly InvokedIngressPlugin[];

  constructor(pipelineSnapshot: PipelineInvocationSnapshot, options: ErrorOptions) {
    super("Ingress pipeline execution failed", options);
    this.name = "IngressPipelineExecutionError";
    this.pipelineSnapshot = pipelineSnapshot;
    this.ingressPlugins = ingressInvocationsFromPipeline(pipelineSnapshot);
  }
}

function domainPipelineError(error: unknown): unknown {
  if (!(error instanceof PipelineHookExecutionError)) return error;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof RelayError) return cause;
  return new RelayError("request_policy_error", "Request policy evaluation failed", 500);
}

export interface ProviderAdapterResponse extends Omit<ProviderRuntimeResponse, "evidence"> {
  evidence?: ProviderExecutionEvidenceV1;
  gatewaySummary?: GatewayProviderSummary;
}

export interface GatewayProviderSummary {
  providerKind: string | null;
  accessPointId: string | null;
  billingSubscriptionId: string | null;
  usageSource: GatewayUsage["source"] | null;
  errorCode: string | null;
  captureErrorCode: string | null;
  errorDiagnostic?: ProviderFetchDiagnosticV1;
}

type SubscriptionSelection = {
  subscription: ActivePlanSubscription;
  accessPoint: AccessPoint;
  effectivePrice: EffectivePlanAccessPointPrice;
  usageChargeAccount: CreditAccount | null;
};

type GatewayDomainPipelineRequestInput = Readonly<{
  requestId: string;
  principal: Principal;
  kind: GatewayRequestKind;
  model: string;
  payload: Readonly<Record<string, unknown>>;
  sourceFormat: GatewayApiFormat;
  billingServiceTier: string;
  excludedPlanSourceOrderIds: readonly string[];
  requestLevelGatesChecked: boolean;
  routingBudget: ReturnType<typeof createGatewayRoutingBudget>;
  signal?: AbortSignal;
}>;

type GatewayDomainArtifactKind =
  | "subscription-selection"
  | "access-resolution"
  | "price-quote"
  | "budget-decision"
  | "validated-usage"
  | "billing-draft";

type GatewayDomainArtifactBinding = Readonly<{
  requestHandle: object;
  kind: GatewayDomainArtifactKind;
  authoritativeValue: unknown;
}>;

type BillingFactsInput = Parameters<GatewayCommands["settleProviderUsage"]>[0]["facts"];

type BillingCommitDraft = Readonly<{
  facts: BillingFactsInput;
  requiresUsageCharge: boolean;
  usageChargeAccountId: string | null;
  actorUserId: string;
  allowUsageOverdraft: boolean;
}>;

type BillingUsageCalculationInput = Readonly<{
  usage: GatewayUsage;
  resolution: AccessCandidate;
  providerAttemptId: string;
  accessPointPrices: readonly AccessPointPrice[];
  operations: readonly Readonly<{
    operationKind: "inference";
    usage: GatewayUsage;
    amounts: GatewayPriceCalculation;
  }>[];
  serviceTier: string;
  requireServiceTier: boolean;
}>;

type CandidateQuoteSet = Readonly<{
  effectivePrice: EffectivePlanAccessPointPrice;
  candidates: ReadonlyMap<string, Readonly<{
    resolution: AccessCandidate;
    providerModelCost: ProviderModelCost;
    accessPointPrices: readonly AccessPointPrice[];
  }>>;
}>;

export function providerErrorCodeFromBody(body: unknown, fallback = "provider_error"): string {
  const code = errorCodeFromUnknown(body);
  return code && isSafeErrorCode(code) ? code : fallback;
}

function planSourceAdmissionMayTryNext(error: unknown): boolean {
  return error instanceof RelayError && [
    "plan_subscription_budget_tokens_exceeded",
    "plan_subscription_budget_amount_exceeded",
    "insufficient_credit_reservation",
    "insufficient_credit",
  ].includes(error.code);
}

function providerAdmissionError(error: unknown): unknown {
  if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "P2028") return error;
  return new RelayError(
    "provider_admission_infrastructure_failure",
    "Provider admission infrastructure is unavailable",
    503,
  );
}

export function normalizeProviderInvocationServiceTier(value: string | undefined): "standard" | "priority" {
  const normalized = String(value ?? "standard").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "standard" || normalized === "priority") return normalized;
  throw new RelayError("provider_service_tier_unsupported", `Provider service tier ${normalized || "empty"} is not supported by the stage-one billing contract`, 400);
}

function requestCaptureFailureCode(error: unknown, fallbackCode: string): string {
  return error instanceof RelayError && /^request_capture_[a-z0-9_]+$/.test(error.code)
    ? error.code
    : fallbackCode;
}

function asyncRequestCaptureStreamHooks(
  writer: RequestCaptureV3StreamWriter,
  requestId: string,
  repo: Pick<GatewayQueries, "getRequestLog">,
  recordFailure: (error: unknown, fallbackCode: string) => void,
): {
  captureStreamEvent: (event: ProviderStreamEvent) => Promise<void>;
  captureStreamDone: (errorCode: string | null) => Promise<void>;
} {
  let available = true;
  const markUnavailable = async (error: unknown, fallbackCode: string): Promise<void> => {
    if (!available) return;
    available = false;
    recordFailure(error, fallbackCode);
    try { await writer.abort(); } catch (abortError) { recordFailure(abortError, "request_capture_abort_failed"); }
  };
  return {
    captureStreamEvent: async (event) => {
      if (!available) return;
      try { await writer.appendEvent(event); } catch (error) { await markUnavailable(error, "request_capture_append_failed"); }
    },
    captureStreamDone: async (errorCode) => {
      if (!available) return;
      try {
        const requestLog = await repo.getRequestLog(requestId);
        await writer.finalize({ errorCode, capturedAt: requestLog?.endedAt ?? new Date().toISOString() });
      } catch (error) { await markUnavailable(error, "request_capture_finalize_failed"); }
    },
  };
}

export const requestTimingStages = [
  "http.receive",
  "auth.api_key",
  "body.parse",
  "access.resolve",
  "price.lookup",
  "budget.check",
  "request_log.start",
  "provider.prepare",
  "provider.admit",
  "provider.invoke",
  "stream.forward",
  "usage.extract",
  "billing.write",
  "request_log.finish",
  "http.respond"
] as const;

export type RequestTimingStage = typeof requestTimingStages[number];

export class RequestTiming {
  private readonly createdAt = performance.now();
  private readonly starts = new Map<RequestTimingStage, number>();
  private readonly durations = new Map<RequestTimingStage, number>();

  start(stage: RequestTimingStage): void {
    this.starts.set(stage, performance.now());
  }

  end(stage: RequestTimingStage): void {
    const startedAt = this.starts.get(stage);
    if (startedAt === undefined) return;
    this.durations.set(stage, (this.durations.get(stage) ?? 0) + performance.now() - startedAt);
    this.starts.delete(stage);
  }

  measure<T>(stage: RequestTimingStage, fn: () => T): T {
    this.start(stage);
    try {
      return fn();
    } finally {
      this.end(stage);
    }
  }

  async measureAsync<T>(stage: RequestTimingStage, fn: () => Promise<T>): Promise<T> {
    this.start(stage);
    try {
      return await fn();
    } finally {
      this.end(stage);
    }
  }

  stageMs(): Record<string, number> {
    return Object.fromEntries([...this.durations.entries()].map(([stage, value]) => [stage, Math.round(value)]));
  }

  activeStages(): RequestTimingStage[] {
    return requestTimingStages.filter((stage) => this.starts.has(stage));
  }

  durationMs(): number {
    return Math.round(performance.now() - this.createdAt);
  }
}

export interface Principal {
  apiKey: ApiKey;
  user: User;
  effectiveScopes?: ScopeRef[];
  team?: { id: string };
  apiKeyPlanSourceRestriction?: ApiKeyPlanSourceRestrictionDecision;
}

export type AccessResolutionUnavailableReason = "target_disabled" | "provider_disabled" | "provider_model_disabled" | "provider_binding_not_ready" | null;

/** Legacy Access Resolution Preview wire candidate. ProviderModel stable IDs and
 * structured kernel diagnostics remain internal to Model Access routing. */
export interface AccessResolutionCandidate {
  scopeRef: ScopeRef;
  accessPoint: AccessPoint;
  accessPointChain: readonly AccessPoint[];
  providerId: string;
  providerModelName: string;
  reqModel: string;
  tarModel: string;
  credentialRef: string;
  candidateId: string;
  selectorTargetEdgeId: string;
  pathTargetEdgeIds: readonly string[];
  routingRevisions: readonly { accessPointId: string; routingRevision: number }[];
  available: boolean;
  unavailableReason: AccessResolutionUnavailableReason;
}

export interface AccessResolutionCandidatePlan extends Omit<AccessCandidatePlan, "candidates"> {
  candidates: readonly AccessResolutionCandidate[];
}

export interface AccessResolution extends Omit<AccessResolutionCandidate, "available" | "unavailableReason"> {
  candidatePlan: AccessResolutionCandidatePlan;
}

export interface AccessResolutionTrace extends AccessResolution {
  checkedScopeRefs: ScopeRef[];
  matchedAccessPoints: AccessPoint[];
  candidateAccessPoints: AccessPoint[];
  resolutionPath: Array<{ scopeRef: ScopeRef; ownerId: string; accessPointScopeRef: string; accessPointId: string; exposedModel: string; description: string | null; targetModel: string; targetType: string; targetId: string | null; targetProviderId: string | null; targetProviderModelName: string | null }>;
  planSources: Array<{ orderId: string; position: number; planId: string; subscriptionScopeRef: string; currentSubscriptionId: string | null; entryAccessPointId: string | null; status: "eligible" | "skipped" | "invalid"; reason: string | null }>;
  planSourcesNextCursor: { position: number; id: string } | null;
  selectedPlanSourceOrderId: string | null;
}

export interface AccessResolutionOptions {
  accessPointId?: string;
  bypassVisibility?: boolean;
  requireProviderBinding?: boolean;
  allowUnavailable?: boolean;
}

export interface AccessCandidate {
  scopeRef: ScopeRef;
  accessPoint: AccessPoint;
  accessPointChain: readonly Readonly<GatewayRoutingAccessPointScopeReference>[];
  providerId: string;
  providerModelId: string;
  providerModelName: string;
  reqModel: string;
  tarModel: string;
  candidateId: string;
  selectorTargetEdgeId: string;
  pathTargetEdgeIds: string[];
  routingRevisions: Array<{ accessPointId: string; routingRevision: number }>;
  available: boolean;
  unavailableReason: RoutingUnavailableReason | null;
}

export interface AccessCandidatePlan {
  entryAccessPointId: string;
  selectorAccessPointId: string;
  selectorId: string;
  selectorBehaviorVersion: number;
  selectorConfig: Readonly<AccessPointSelectorConfig>;
  routingRevision: number;
  candidates: readonly AccessCandidate[];
}

function gatewayAccessCandidatePlan(
  snapshot: GatewayRoutingSnapshot,
  subscriptionScopeRef: ScopeRef,
  entryAccessPoint: AccessPoint,
): AccessCandidatePlan {
  const accessPoints = new Map(snapshot.scopeReferences.accessPoints.map((accessPoint) => [accessPoint.id, accessPoint]));
  const candidates = snapshot.candidates.map((candidate): AccessCandidate => {
    const accessPointChain = candidate.accessPointChainIds.map((accessPointId) => {
      const accessPoint = accessPoints.get(accessPointId);
      if (!accessPoint) throw new RelayError("routing_graph_snapshot_invalid", `Routing snapshot is missing AccessPoint ${accessPointId}`, 500);
      return accessPoint;
    });
    return Object.freeze({
      scopeRef: subscriptionScopeRef,
      accessPoint: entryAccessPoint,
      accessPointChain: Object.freeze(accessPointChain),
      providerId: candidate.providerId,
      providerModelId: candidate.providerModelId,
      providerModelName: candidate.providerModelName,
      reqModel: snapshot.plan.requestedModel,
      tarModel: candidate.providerModelName,
      candidateId: candidate.candidateId,
      selectorTargetEdgeId: candidate.selectorTargetEdgeId,
      pathTargetEdgeIds: [...candidate.pathTargetEdgeIds],
      routingRevisions: candidate.routingRevisions.map((revision) => ({ ...revision })),
      available: candidate.available,
      unavailableReason: candidate.unavailableReason,
    });
  });
  return Object.freeze({
    entryAccessPointId: snapshot.plan.entryAccessPointId,
    selectorAccessPointId: snapshot.plan.selectorAccessPointId,
    selectorId: snapshot.plan.selectorId,
    selectorBehaviorVersion: snapshot.plan.selectorBehaviorVersion,
    selectorConfig: snapshot.plan.selectorConfig,
    routingRevision: snapshot.plan.routingRevision,
    candidates: Object.freeze(candidates),
  });
}

function modelUnavailable(): RelayError {
  return new RelayError("model_unavailable", "The requested model is temporarily unavailable", 503);
}

async function* renewRequestExecutionLeaseStream<T>(
  stream: AsyncIterable<T>,
  renew: () => Promise<unknown>,
  leaseTtlSeconds: number,
): AsyncGenerator<T> {
  const renewAfterMs = Math.max(1_000, Math.trunc(leaseTtlSeconds * 500));
  let renewedAt = Date.now();
  for await (const chunk of stream) {
    const now = Date.now();
    if (now - renewedAt >= renewAfterMs) {
      await renew();
      renewedAt = now;
    }
    yield chunk;
  }
}

async function releaseRequestExecutionLeaseAsync(
  leases: Pick<RequestExecutionLeasePort, "release">,
  requestId: string,
  ownerId: string,
): Promise<void> {
  try {
    await leases.release({ requestId, ownerId });
  } catch {
    console.warn(JSON.stringify({ event: "request_execution_lease.release_failed", requestId }));
  }
}

function arbitrateGatewayFailure(
  failure: ProviderAttemptFailureV1,
  outputCommitted: boolean,
  requestCancelled: boolean,
) {
  return arbitrateProviderAttemptFailure({
    costExposure: failure.costExposure,
    finalUsageEvidence: failure.finalUsageEvidence,
    hasTrustedFinalUsage: isTrustedGatewayUsage(failure.trustedUsage),
    outputCommitted,
    requestCancelled,
  });
}

function providerInvocationReconciliationRequired(): RelayError {
  return new RelayError(
    "provider_invocation_reconciliation_required",
    "The Provider invocation outcome is pending reconciliation and was not retried.",
    503,
  );
}

function invocationUsageUnits(usage: GatewayUsage & { source: "provider" | "response" }) {
  return {
    inputTokens: BigInt(usage.inputTokens),
    cachedInputTokens: BigInt(usage.cachedInputTokens),
    cacheWriteTokens: BigInt(usage.cacheWriteTokens),
    outputTokens: BigInt(usage.outputTokens),
    totalTokens: BigInt(usage.totalTokens),
    source: usage.source,
  };
}

function credentialFailureDiagnostic(failure: ProviderAttemptFailureV1): ProviderFetchDiagnosticV1 {
  return Object.freeze({
    version: 1,
    stage: "response_headers",
    transport: "sse",
    retryable: failure.failureClass !== "non_retryable",
    eventsReceived: 0,
    ...(failure.failureReason ? { causeCode: failure.failureReason } : {}),
  });
}

function selectorAttemptResult(
  resolution: AccessCandidate,
  attemptIndex: number,
  failureClass: ProviderFailureClass,
  durationMs: number,
): SelectorAttemptResult {
  return Object.freeze({
    candidateId: resolution.candidateId,
    targetEdgeId: resolution.selectorTargetEdgeId,
    attemptIndex,
    outcome: "failed",
    failureClass,
    outputCommitted: false,
    durationMs: Math.max(0, Math.min(2_147_483_647, Math.round(durationMs))),
  });
}

function replayAsyncIterator(
  buffered: readonly ProviderStreamEvent[],
  iterator: AsyncIterator<ProviderStreamEvent>,
): AsyncIterable<ProviderStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (const event of buffered) yield event;
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await iterator.return?.();
      }
    },
  };
}

async function nextIteratorEvent(
  iterator: AsyncIterator<ProviderStreamEvent>,
  signal?: AbortSignal,
): Promise<IteratorResult<ProviderStreamEvent>> {
  if (!signal) return iterator.next();
  if (signal.aborted) throw abortSignalError(signal);
  return new Promise<IteratorResult<ProviderStreamEvent>>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortSignalError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortSignalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new RelayError("cliproxy_request_aborted", "Provider request was aborted", 499);
}

export function scopeRefsForPrincipal(principal: Principal): ScopeRef[] {
  return [keyScopeRef(principal.apiKey.id), ...[...principalScopes(principal)].reverse()];
}

async function executeIngressPipelineAsync(
  repo: GatewayQueries,
  scopeRefs: readonly ScopeRef[],
  kind: GatewayRequestKind,
  payload: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<Readonly<{ payload: Record<string, unknown>; invokedPlugins: readonly InvokedIngressPlugin[]; pipelineSnapshot: PipelineInvocationSnapshot; session: PipelineRequestSession }>> {
  const settings = await resolveIngressPipelineSettingsAsync(repo, scopeRefs);
  const plan = ingressPipelinePlanCache.getOrCompile({
    kernelApiVersion: 1,
    plugins: ingressPipelinePlugins,
    settings,
    applicability: Object.freeze({ cacheKey: `ingress-${kind}`, facts: Object.freeze({ kind }) }),
  });
  const session = new PipelineRequestSession(plan, Object.freeze({ originalRequest: Object.freeze({ kind, payload }) }), signal ? { signal } : {});
  try {
    await session.executePhase("request.ingress");
    const effective = session.context.artifactReader().get("effectiveSourceRequest") as { payload?: unknown } | undefined;
    const effectivePayload = effective?.payload ?? payload;
    if (!effectivePayload || typeof effectivePayload !== "object" || Array.isArray(effectivePayload)) throw new Error("Ingress pipeline produced an invalid effective request");
    const pipelineSnapshot = session.invocationSnapshot();
    return Object.freeze({ payload: { ...effectivePayload as Record<string, unknown> }, invokedPlugins: ingressInvocationsFromPipeline(pipelineSnapshot), pipelineSnapshot, session });
  } catch (cause) {
    session.finish();
    throw new IngressPipelineExecutionError(session.invocationSnapshot(), { cause });
  }
}

async function resolveIngressPipelineSettingsAsync(repo: Pick<GatewayQueries, "listPipelinePluginSettings">, scopeRefs: readonly ScopeRef[]): Promise<Readonly<{ revision: string; settings: readonly RuntimePipelinePluginSetting[] }>> {
  const ingressRegistry = listIngressPlugins();
  const knownIds = new Set([...ingressRegistry.map((plugin) => plugin.id), ...listGatewayPolicyPipelinePlugins().map((plugin) => plugin.manifest.id)]);
  const rows = await repo.listPipelinePluginSettings([...scopeRefs]);
  for (const row of rows) if (!knownIds.has(row.pluginId)) throw new RelayError("invalid_pipeline_plugin_setting", "Unknown persisted pipeline plugin setting", 500);
  const precedence = new Map(scopeRefs.map((scopeRef, index) => [scopeRef, index]));
  const settings = ingressRegistry.map((plugin): RuntimePipelinePluginSetting => {
    const row = rows.filter((candidate) => candidate.pluginId === plugin.id).sort((left, right) => precedence.get(left.scopeRef as ScopeRef)! - precedence.get(right.scopeRef as ScopeRef)!)[0];
    if (!row) return Object.freeze({ pluginId: plugin.id, enabled: false, config: plugin.defaultConfig, instanceRevision: "builtin-default" });
    let parsed: unknown;
    try { parsed = validateIngressPluginConfig(plugin.id, JSON.parse(row.configJson)); } catch { throw new RelayError("invalid_pipeline_plugin_setting", "Persisted pipeline plugin config is invalid", 500); }
    return Object.freeze({ pluginId: plugin.id, enabled: row.enabled, config: parsed, instanceRevision: `psr_${row.id}_${row.settingRevision}_${row.configRevision}` });
  });
  const revisionMaterial = settings.map((setting) => `${setting.pluginId}:${setting.instanceRevision}:${setting.enabled ? 1 : 0}`).join("|");
  return Object.freeze({ revision: `psr_${createHash("sha256").update(revisionMaterial).digest("hex").slice(0, 24)}`, settings: Object.freeze(settings) });
}

function ingressInvocationsFromPipeline(snapshot: PipelineInvocationSnapshot): readonly InvokedIngressPlugin[] {
  return Object.freeze(snapshot.invocations
    .filter((fact) => fact.hook === "request.ingress")
    .map((fact) => Object.freeze({
      id: fact.pluginId,
      version: fact.behaviorVersion,
      success: fact.outcome === "applied" ? true : fact.outcome === "failed" || fact.outcome === "denied" ? false : null
    })));
}

function parsePipelineInvocationSnapshot(value: unknown): PipelineInvocationSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<PipelineInvocationSnapshot>;
  if (snapshot.schemaVersion !== 1 || typeof snapshot.planRevision !== "string" || !Array.isArray(snapshot.invocations)) return null;
  if (snapshot.invocations.length > 128) return null;
  const invocations = snapshot.invocations.flatMap((fact) => {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) return [];
    const candidate = fact as Record<string, unknown>;
    if (typeof candidate.pluginId !== "string" || !Number.isSafeInteger(candidate.behaviorVersion)
      || typeof candidate.hook !== "string" || typeof candidate.instanceRevision !== "string"
      || !["applied", "noop", "denied", "failed", "fallback"].includes(String(candidate.outcome))) return [];
    return [Object.freeze(candidate) as unknown as PipelineInvocationSnapshot["invocations"][number]];
  });
  if (invocations.length !== snapshot.invocations.length) return null;
  return Object.freeze({ schemaVersion: 1, planRevision: snapshot.planRevision, invocations: Object.freeze(invocations) });
}

async function finalizePipelineSnapshotsAsync(
  repo: Pick<GatewayCommands, "finalizeRequestPipelineSnapshot">,
  requestId: string,
  snapshots: readonly PipelineInvocationSnapshot[],
  onFinalized: () => void,
): Promise<void> {
  const planRevision = `ppr_${createHash("sha256").update(snapshots.map((snapshot) => snapshot.planRevision).join("|")).digest("hex").slice(0, 24)}`;
  const invocations = snapshots.flatMap((snapshot) => snapshot.invocations).map((fact) => ({ ...fact }));
  await repo.finalizeRequestPipelineSnapshot(requestId, { schemaVersion: 1, planRevision, invocations });
  onFinalized();
}

export function planScopeRefsForPrincipal(principal: Principal): ScopeRef[] {
  return principalScopes(principal);
}

export function governanceScopeRefsForPrincipal(principal: Principal): ScopeRef[] {
  return [...principalScopes(principal), keyScopeRef(principal.apiKey.id)];
}

export function governanceBudgetScopeRefsForPrincipal(principal: Principal): ScopeRef[] {
  return principalScopes(principal);
}

function principalScopes(principal: Principal): ScopeRef[] {
  return principal.effectiveScopes ?? ["global:", ...(principal.team ? [teamScopeRef(principal.team.id)] : []), userScopeRef(principal.user.id)];
}

function teamIdFromScopeRef(scopeRef: ScopeRef): string | null {
  const prefix = "team:";
  return scopeRef.startsWith(prefix) ? scopeRef.slice(prefix.length) : null;
}

export function gatewayApiFormatForKind(kind: GatewayRequestKind): GatewayApiFormat {
  if (kind === "messages") return "anthropic";
  if (kind === "responses") return "openai-responses";
  return "openai";
}

export interface StreamToSseOptions {
  heartbeatIntervalMs?: number;
  initialHeartbeat?: boolean;
}

const SSE_HEARTBEAT = new TextEncoder().encode(": keepalive\n\n");

export function streamToSse(stream: AsyncIterable<ProviderStreamEvent>, options: StreamToSseOptions = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = stream[Symbol.asyncIterator]();
  const heartbeatIntervalMs = options.heartbeatIntervalMs;
  if (heartbeatIntervalMs !== undefined && (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0)) {
    throw new TypeError("heartbeatIntervalMs must be a positive safe integer");
  }
  const cancellation = new AbortController();
  let initialHeartbeatPending = options.initialHeartbeat ?? false;
  let pendingNext: Promise<IteratorResult<ProviderStreamEvent>> | null = null;
  let terminalFrameSent = false;
  let finished = false;
  let closing: Promise<void> | null = null;

  const closeIterator = async (): Promise<void> => {
    if (closing) return closing;
    finished = true;
    cancellation.abort();
    closing = (async () => {
      try {
        await iterator.return?.();
      } catch {
        // Cancellation is best-effort; the original downstream reason is authoritative.
      }
    })();
    return closing;
  };

  return new ReadableStream({
    async pull(controller) {
      if (finished) return;
      if (initialHeartbeatPending) {
        initialHeartbeatPending = false;
        controller.enqueue(SSE_HEARTBEAT.slice());
        return;
      }
      try {
        // Usage-only events have no public SSE representation. Continue only until
        // this single downstream demand produces a frame or reaches EOF. Keep one
        // pending next() across heartbeat pulls so liveness never reads ahead, and
        // keep one deadline across hidden events so they cannot suppress liveness.
        const heartbeatDeadline = heartbeatIntervalMs === undefined || terminalFrameSent
          ? null
          : Date.now() + heartbeatIntervalMs;
        while (!finished) {
          if (heartbeatDeadline !== null && Date.now() >= heartbeatDeadline) {
            controller.enqueue(SSE_HEARTBEAT.slice());
            return;
          }
          pendingNext ??= iterator.next();
          const outcome = heartbeatDeadline === null
            ? { kind: "event" as const, result: await pendingNext }
            : await nextProviderEventOrHeartbeat(
                pendingNext,
                Math.max(0, heartbeatDeadline - Date.now()),
                cancellation.signal,
              );
          if (outcome.kind === "cancelled" || finished) return;
          if (outcome.kind === "heartbeat") {
            controller.enqueue(SSE_HEARTBEAT.slice());
            return;
          }
          pendingNext = null;
          const result = outcome.result;
          if (result.done) {
            finished = true;
            controller.close();
            return;
          }
          const event = result.value;
          if (event.type === "chunk") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event.data)}\n\n`));
            return;
          }
          if (event.type === "error") {
            terminalFrameSent = true;
            const publicError = { type: "error", code: event.code, message: event.message, retryable: event.retryable };
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(publicError)}\n\n`));
            return;
          }
          if (event.type === "done") {
            terminalFrameSent = true;
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            return;
          }
        }
      } catch (error) {
        finished = true;
        cancellation.abort();
        controller.error(error);
      }
    },
    async cancel() {
      await closeIterator();
    }
  }, { highWaterMark: 0 });
}

async function nextProviderEventOrHeartbeat(
  pendingNext: Promise<IteratorResult<ProviderStreamEvent>>,
  heartbeatIntervalMs: number,
  signal: AbortSignal,
): Promise<
  | { kind: "event"; result: IteratorResult<ProviderStreamEvent> }
  | { kind: "heartbeat" }
  | { kind: "cancelled" }
> {
  if (signal.aborted) return { kind: "cancelled" };
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => settle(() => resolve({ kind: "heartbeat" })), heartbeatIntervalMs);
    const onAbort = () => settle(() => resolve({ kind: "cancelled" }));
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void pendingNext.then(
      (result) => settle(() => resolve({ kind: "event", result })),
      (error) => settle(() => reject(error)),
    );
  });
}

type WritableStreamEvent = "drain" | "close" | "error";

export interface BackpressureWritable {
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  write(chunk: Uint8Array): boolean;
  once(event: WritableStreamEvent, listener: (...args: any[]) => void): unknown;
  off(event: WritableStreamEvent, listener: (...args: any[]) => void): unknown;
}

/** Pipes a Web stream to a Node-style writable without reading ahead of backpressure. */
export async function pipeReadableStreamToWritable(
  body: ReadableStream<Uint8Array>,
  writable: BackpressureWritable,
  options: { signal?: AbortSignal; onCancel?: (reason: unknown) => void } = {}
): Promise<void> {
  const reader = body.getReader();
  let completed = false;
  let terminationReason: unknown = null;
  let cancelPromise: Promise<void> | null = null;
  let cancelling = false;

  const cancel = (reason: unknown) => {
    if (completed || cancelling) return;
    cancelling = true;
    terminationReason = reason;
    options.onCancel?.(reason);
    cancelPromise = reader.cancel(reason).catch(() => undefined);
  };
  const onClose = () => {
    if (!writable.writableEnded) cancel(new Error("Downstream connection closed"));
  };
  const onError = (error: unknown) => cancel(error);
  const onAbort = () => cancel(options.signal?.reason ?? new DOMException("Request aborted", "AbortError"));

  writable.once("close", onClose);
  writable.once("error", onError);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (options.signal?.aborted) onAbort();
    while (!terminationReason) {
      const result = await reader.read();
      if (terminationReason) throw terminationReason;
      if (result.done) {
        completed = true;
        return;
      }
      if (!writable.write(result.value)) {
        await waitForWritableDrain(writable, options.signal, () => terminationReason);
      }
    }
    throw terminationReason;
  } finally {
    writable.off("close", onClose);
    writable.off("error", onError);
    options.signal?.removeEventListener("abort", onAbort);
    if (!completed && !cancelPromise) cancel(terminationReason ?? new Error("Response piping stopped"));
    await cancelPromise;
    reader.releaseLock();
  }
}

async function waitForWritableDrain(
  writable: BackpressureWritable,
  signal: AbortSignal | undefined,
  terminationReason: () => unknown
): Promise<void> {
  const existingReason = terminationReason();
  if (existingReason) throw existingReason;
  if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      writable.off("drain", onDrain);
      writable.off("close", onClose);
      writable.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void) => {
      cleanup();
      callback();
    };
    const onDrain = () => settle(resolve);
    const onClose = () => settle(() => reject(terminationReason() ?? new Error("Downstream connection closed")));
    const onError = (error: unknown) => settle(() => reject(error));
    const onAbort = () => settle(() => reject(terminationReason() ?? signal?.reason ?? new DOMException("Request aborted", "AbortError")));
    writable.once("drain", onDrain);
    writable.once("close", onClose);
    writable.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorCodeFromUnknown(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const code = (nested as Record<string, unknown>).code;
    return typeof code === "string" ? code : "";
  }
  return typeof record.code === "string" ? record.code : "";
}

function isSafeErrorCode(code: string): boolean {
  return /^[a-z][a-z0-9_]{1,80}$/.test(code);
}

function subscriptionRequiresUsageCharge(billingMode: string): boolean {
  return billingMode === "paygo";
}
