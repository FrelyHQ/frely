import { describe, expect, test, vi } from "vitest";
import { AsyncGatewayExecutor } from "@frely/gateway-core";
import type {
  PreparedProviderInvocation,
  ProviderPreparationPort,
  ProviderAttemptFailureV1,
  ProviderRuntimeTargetExpectation,
} from "@frely/provider-runtime";
import type { ProviderAdapterRequest, ProviderAdapterResponse } from "@frely/provider-runtime/adapter";
import type { GatewayCommands, GatewayQueries } from "../packages/gateway/src/async-gateway-contract.js";
import type { ProviderRuntimeTargetMaterial, ProviderRuntimeTargetReader } from "@frely/provider-runtime/server";
import { CliProxyClient } from "../packages/providers/src/cliproxy/client.js";
import type { CliProxyConfig } from "../packages/providers/src/cliproxy/config.js";
import { CliProxyTransport } from "../packages/providers/src/cliproxy/transport.js";
import { DefaultProviderAdapter, DefaultProviderRuntime } from "../packages/providers/src/index.js";

const config: CliProxyConfig = {
  baseUrl: "http://cli-proxy-api:8317",
  apiKey: "inference-secret",
  managementApiKey: null,
  timeoutMs: 1_000,
};

function cliProxyRequest(): ProviderAdapterRequest {
  return {
    kind: "responses",
    provider: {
      id: "prv_pipeline",
      cpaInstanceId: "cpa_default",
      bindingRevision: 1,
      authMethod: "oauth",
      credentialOwnership: "cpa-managed",
      credentialRefCount: 1,
    },
    sourceFormat: "openai-responses",
    sourceModel: "public-model",
    tarModel: "gpt-5",
    input: [{ role: "user", content: "pipeline-secret-prompt" }],
    stream: false,
    options: { input: [{ role: "user", content: "pipeline-secret-prompt" }] },
    metadata: { requestId: "req_pipeline", providerAttemptId: "provider_attempt_pipeline", teamId: null, userId: "usr_1", apiKeyId: "key_1" },
  };
}

describe("CPA-only Provider Runtime", () => {
  test("uses one plugin-free CPA adapter and consumes only the versioned normalized Stage 1 evidence envelope", async () => {
    const trustedUsage = { inputTokens: 3, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 4, source: "provider" as const };
    const fetchMock = vi.fn(async () => Response.json({
      contract: "cpa-basic-json@1",
      version: 1,
      response: { id: "resp_runtime", model: "prv_pipeline/gpt-5", output: [], usage: { future_shape: true } },
      evidence: {
        contract: "cpa-basic@1",
        version: 1,
        providerAttemptRef: "attempt-runtime",
        costExposure: "stopped",
        finalUsageEvidence: "final",
        trustedUsage,
      },
    }));
    const runtime = new DefaultProviderRuntime(targetReader(), new DefaultProviderAdapter({
      cliProxyTransport: new CliProxyTransport(new CliProxyClient(config, { fetch: fetchMock as typeof fetch })),
    }));
    const prepared = await runtime.prepare({
      providerModelId: "provider_model_pipeline",
      providerId: "prv_pipeline",
      providerModelName: "gpt-5",
      kind: "responses",
      sourceFormat: "openai-responses",
      sourceModel: "public-model",
      stream: false,
      serviceTier: "standard",
      options: { input: "x".repeat(32 * 1024), max_output_tokens: 64 },
    });

    expect(prepared).toMatchObject({ preparationStage: "stage1", tokenizer: null, effectiveMaxBillableOutputTokens: null });
    const response = await runtime.invokeAdmittedCandidate({ providerAttemptRef: "attempt-runtime", dispatch: await runtime.refreshForDispatch(prepared) });
    expect(response.status).toBe(200);
    expect(response.usage).toMatchObject({ inputTokens: 3, outputTokens: 1, source: "provider" });
    expect(response.evidence).toMatchObject({ costExposure: "stopped", finalUsageEvidence: "final", trustedUsage: { inputTokens: 3, outputTokens: 1 } });
    expect(response.pipelineInvocationSnapshot).toBeUndefined();
    expect(response.body).toMatchObject({ model: "public-model", usage: { future_shape: true } });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-friday-cpa-evidence-contract")).toBe("cpa-basic@1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("keeps protected CPA preparation fail-closed on a non-positive cap or executed-payload mismatch", async () => {
    let outputCap = 0;
    const capability: ProviderPreparationPort = {
      capability: { authority: "cpa", kind: "provider-preparation", contractVersion: 1 },
      async prepare(input) {
        return {
          ...preparedInvocation(input.target, input.request.options),
          kind: input.request.kind,
          sourceFormat: input.request.sourceFormat,
          sourceModel: input.request.sourceModel,
          stream: input.request.stream,
          serviceTier: input.request.serviceTier,
          effectiveMaxBillableOutputTokens: outputCap,
        };
      },
      async invokePrepared() {
        return {
          executedPreparedPayloadId: "different-cpa-payload",
          response: {
            status: 200,
            body: { ok: true },
            evidence: { version: 1, costExposure: "stopped", finalUsageEvidence: "final", trustedUsage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 2, source: "provider" } },
          },
        };
      },
    };
    const runtime = new DefaultProviderRuntime(targetReader(), undefined, capability);
    const request = { providerModelId: "provider_model_pipeline", providerId: "prv_pipeline", providerModelName: "gpt-5", kind: "responses" as const, sourceFormat: "openai-responses" as const, sourceModel: "public-model", stream: false, serviceTier: "standard", options: { input: [], max_output_tokens: 64 } };
    await expect(runtime.prepare(request)).rejects.toMatchObject({ code: "cpa_preparation_evidence_invalid" });

    outputCap = 64;
    const prepared = await runtime.prepare(request);
    const response = await runtime.invokeAdmittedCandidate({ providerAttemptRef: "attempt-protected", dispatch: await runtime.refreshForDispatch(prepared) });
    expect(response).toMatchObject({ status: 502, evidence: { costExposure: "accruing", finalUsageEvidence: "pending" }, failure: { costExposure: "accruing", finalUsageEvidence: "pending" } });
  });

  test("rejects a changed binding revision before dispatch with authoritative not-started evidence", async () => {
    let material = targetMaterial();
    const reader: ProviderRuntimeTargetReader = { async loadAvailableTarget() { return material; } };
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    const runtime = new DefaultProviderRuntime(reader, new DefaultProviderAdapter({
      cliProxyTransport: new CliProxyTransport(new CliProxyClient(config, { fetch: fetchMock as typeof fetch })),
    }));
    const prepared = preparedInvocation(material, { input: [], max_output_tokens: 64 });
    material = { ...material, bindingRevision: 2 };

    await expect(runtime.refreshForDispatch(prepared)).rejects.toMatchObject({
      code: "provider_runtime_target_changed",
      costExposure: "not_started",
      finalUsageEvidence: "absent",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("gates Stage 1 on positive PayGo balance and already-exhausted hard budgets before CPA", async () => {
    const zeroBalance = gatewayCompositionFixture({ stage1: true, billingMode: "paygo", balanceUnits: 0 });
    await expect(zeroBalance.executor.invoke(
      { apiKey: { id: "key-ordinary" }, user: { id: "user-1" }, effectiveScopes: ["user:user-1"] } as never,
      { kind: "responses", model: "public-model", payload: { model: "public-model", input: "hello" }, requestId: "req-zero-balance" },
    )).rejects.toMatchObject({ code: "insufficient_credit_balance", status: 402 });
    expect(zeroBalance.baseCalls).toHaveLength(0);
    expect(zeroBalance.admitCpaBasic).not.toHaveBeenCalled();

    for (const metric of ["tokens", "amount"] as const) {
      const exhausted = gatewayCompositionFixture({ stage1: true, directBudgetExhausted: metric });
      await expect(exhausted.executor.invoke(
        { apiKey: { id: "key-ordinary" }, user: { id: "user-1" }, effectiveScopes: ["user:user-1"] } as never,
        { kind: "responses", model: "public-model", payload: { model: "public-model", input: "hello" }, requestId: `req-exhausted-${metric}` },
      )).rejects.toMatchObject({ code: metric === "tokens" ? "budget_token_limit_exceeded" : "budget_amount_limit_exceeded", status: 402 });
      expect(exhausted.baseCalls).toHaveLength(0);
      expect(exhausted.admitCpaBasic).not.toHaveBeenCalled();
    }
  });

  test("dispatches stock CPA at most once and settles only normalized returned usage", async () => {
    const admitted = gatewayCompositionFixture({ stage1: true, billingMode: "paygo", balanceUnits: 1 });
    const response = await admitted.executor.invoke(
      { apiKey: { id: "key-ordinary" }, user: { id: "user-1" }, effectiveScopes: ["user:user-1"] } as never,
      { kind: "responses", model: "public-model", payload: { model: "public-model", input: "hello" }, requestId: "req-positive-balance" },
    );

    expect(response.status).toBe(200);
    expect(admitted.baseCalls).toHaveLength(1);
    expect(admitted.admitCpaBasic).toHaveBeenCalledWith(expect.objectContaining({
      planId: "plan-routing",
      planSubscriptionId: "subscription-routing",
      apiKeyId: "key-ordinary",
      userId: "user-1",
      usageChargeAccountId: "credit-routing",
      requireServiceTier: false,
      providerId: "prv_pipeline",
      providerModelId: "provider_model_pipeline",
      providerModelCostId: "cost-routing",
      accessPointPriceIds: ["price-routing"],
    }));
    expect(admitted.assertDispatchOwnership).toHaveBeenCalledWith(
      "provider-attempt-req-positive-balance",
      "req-positive-balance",
      expect.any(String),
    );
    expect(admitted.settleCpaBasicLive).toHaveBeenCalledWith(expect.objectContaining({
      providerAttemptId: "provider-attempt-req-positive-balance",
      outcome: "succeeded",
      usage: expect.objectContaining({ inputTokens: 2n, outputTokens: 1n, source: "response" }),
    }));
    expect(admitted.usageChargeWrites).not.toHaveBeenCalled();
  });

  test("delegates Stage 1 settlement rollback recovery to the single Application command", async () => {
    const fixture = gatewayCompositionFixture({ stage1: true, billingMode: "paygo", balanceUnits: 1, settlementFailure: true });
    await expect(fixture.executor.invoke(
      { apiKey: { id: "key-ordinary" }, user: { id: "user-1" }, effectiveScopes: ["user:user-1"] } as never,
      { kind: "responses", model: "public-model", payload: { model: "public-model", input: "hello" }, requestId: "req-settlement-rollback" },
    )).rejects.toThrow("Verification settlement failure");
    expect(fixture.baseCalls).toHaveLength(1);
    expect(fixture.settleCpaBasicLive).toHaveBeenCalledTimes(1);
    expect(fixture.enterReconciliation).not.toHaveBeenCalled();
    expect(fixture.factWrites).not.toHaveBeenCalled();
    expect(fixture.usageChargeWrites).not.toHaveBeenCalled();
  });

  test("persists zero-cost Stage 1 facts without requiring a Credit ledger posting", async () => {
    const fixture = gatewayCompositionFixture({ stage1: true, billingMode: "paygo", balanceUnits: 1, pricePer1M: 0, providerUsage: { inputTokens: 0, outputTokens: 0 } });
    await expect(fixture.executor.invoke(
      { apiKey: { id: "key-ordinary" }, user: { id: "user-1" }, effectiveScopes: ["user:user-1"] } as never,
      { kind: "responses", model: "public-model", payload: { model: "public-model", input: "hello" }, requestId: "req-zero-cost" },
    )).resolves.toMatchObject({ status: 200 });
    expect(fixture.factWrites).toHaveBeenCalledTimes(0);
    expect(fixture.usageChargeWrites).toHaveBeenCalledTimes(0);
    expect(fixture.settleCpaBasicLive).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ inputTokens: 0n, outputTokens: 0n }),
    }));
    await expect(fixture.settleCpaBasicLive.mock.results[0]!.value).resolves.toMatchObject({ postingLedgerEventId: null });
  });

  test("preserves a completed public response while missing CPA evidence remains pending without fallback", async () => {
    const fixture = gatewayCompositionFixture({ stage1: true, providerUsage: null });
    await expect(fixture.executor.invoke(
      { apiKey: { id: "key-ordinary" }, user: { id: "user-1" }, effectiveScopes: ["user:user-1"] } as never,
      { kind: "responses", model: "public-model", payload: { model: "public-model", input: "hello" }, requestId: "req-usage-missing" },
    )).resolves.toMatchObject({ status: 200 });
    expect(fixture.baseCalls).toHaveLength(1);
    expect(fixture.usageChargeWrites).not.toHaveBeenCalled();
    expect(fixture.factWrites).not.toHaveBeenCalled();
    expect(fixture.enterReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      providerAttemptId: "provider-attempt-req-usage-missing",
      costExposure: "accruing",
      finalUsageEvidence: "pending",
      reason: "provider_final_usage_pending",
    }));
  });

  test("preserves the CPA public failure while its incomplete evidence remains pending without fallback", async () => {
    const fixture = gatewayCompositionFixture({ stage1: true, providerStatus: 503, providerUsage: null });
    await expect(fixture.executor.invoke(
      { apiKey: { id: "key-ordinary" }, user: { id: "user-1" }, effectiveScopes: ["user:user-1"] } as never,
      { kind: "responses", model: "public-model", payload: { model: "public-model", input: "hello" }, requestId: "req-ambiguous-failure" },
    )).resolves.toMatchObject({ status: 503 });
    expect(fixture.baseCalls).toHaveLength(1);
    expect(fixture.usageChargeWrites).not.toHaveBeenCalled();
    expect(fixture.enterReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      providerAttemptId: "provider-attempt-req-ambiguous-failure",
      costExposure: "accruing",
      finalUsageEvidence: "pending",
      reason: "provider_final_usage_pending",
    }));
  });

  test("returns an authoritative not-started stock CPA rejection without reconciliation", async () => {
    const fixture = gatewayCompositionFixture({
      stage1: true,
      providerStatus: 400,
      providerUsage: null,
      providerFailure: {
        version: 1,
        failureClass: "non_retryable",
        costExposure: "not_started",
        finalUsageEvidence: "absent",
      },
    });
    await expect(fixture.executor.invoke(
      { apiKey: { id: "key-ordinary" }, user: { id: "user-1" }, effectiveScopes: ["user:user-1"] } as never,
      { kind: "embeddings", model: "public-model", payload: { model: "public-model", input: "hello" }, requestId: "req-not-started" },
    )).resolves.toMatchObject({ status: 400 });
    expect(fixture.baseCalls).toHaveLength(1);
    expect(fixture.usageChargeWrites).not.toHaveBeenCalled();
    expect(fixture.releaseNotStarted).toHaveBeenCalledWith(expect.objectContaining({
      providerAttemptId: "provider-attempt-req-not-started",
      outcome: "failed",
      failureClass: "non_retryable",
    }));
  });

});

function targetReader(): ProviderRuntimeTargetReader {
  return { async loadAvailableTarget() { return targetMaterial(); } };
}

function targetMaterial(): ProviderRuntimeTargetMaterial {
  return {
    providerModelId: "provider_model_pipeline",
    providerId: "prv_pipeline",
    providerModelName: "gpt-5",
    providerKind: "codex",
    cpaInstanceId: "cpa_default",
    providerUpdatedAt: "2026-08-22T00:00:00.000Z",
    providerModelUpdatedAt: "2026-08-22T00:00:00.000Z",
    bindingRevision: 1,
    authMethod: "oauth",
    credentialOwnership: "cpa-managed",
  };
}

function preparedInvocation(
  target: ProviderRuntimeTargetExpectation,
  options: Readonly<Record<string, unknown>>,
): PreparedProviderInvocation {
  return Object.freeze({
    target,
    kind: "responses",
    sourceFormat: "openai-responses",
    sourceModel: "public-model",
    stream: false,
    serviceTier: "standard",
    options: Object.freeze({ ...options }),
    preparationStage: "protected",
    cpaPreparation: Object.freeze({ evidenceId: "cpa-evidence-test", evidenceVersion: 1, preparedPayloadId: "cpa-payload-test" }),
    tokenizer: Object.freeze({ tokenizerId: "cpa-test-tokenizer", revision: 1, inputTokens: 7 }),
    effectiveMaxBillableOutputTokens: 64,
  });
}

const cpaPreparationFixture: ProviderPreparationPort = Object.freeze({
  capability: { authority: "cpa", kind: "provider-preparation", contractVersion: 1 },
  async prepare(input): Promise<PreparedProviderInvocation> {
    return Object.freeze({
      ...preparedInvocation(input.target, input.request.options),
      kind: input.request.kind,
      sourceFormat: input.request.sourceFormat,
      sourceModel: input.request.sourceModel,
      stream: input.request.stream,
      serviceTier: input.request.serviceTier,
    });
  },
});

function gatewayCompositionFixture(options: {
  stage1?: boolean;
  billingMode?: "prepaid" | "paygo";
  balanceUnits?: number;
  directBudgetExhausted?: "tokens" | "amount";
  pricePer1M?: number;
  providerStatus?: number;
  providerFailure?: ProviderAttemptFailureV1;
  providerUsage?: { inputTokens: number; outputTokens: number } | null;
  settlementFailure?: boolean;
} = {}) {
  const accessPoint = {
    id: "ap-routing",
    name: "Routing",
    description: null,
    apiFamily: "openai",
    status: "enabled",
    scopeRef: "user:user-1",
    ownerId: "user-1",
    exposedModel: "public-model",
    targetModel: "gpt-5",
    targetType: "provider-model",
    selectorId: "direct",
    selectorBehaviorVersion: 1,
    selectorConfigJson: "{}",
    requestOverridesJson: "{}",
    routingRevision: 1,
  };
  const target = {
    id: "edge-routing",
    accessPointId: accessPoint.id,
    position: 0,
    status: "enabled",
    targetType: "provider-model",
    targetAccessPointId: null,
    targetProviderId: "prv_pipeline",
    targetProviderModelName: "gpt-5",
  };
  const provider = { id: "prv_pipeline", kind: "codex", status: "enabled", scopeRef: "user:user-1", credentialResolver: "identity:prv_pipeline", configJson: "{}" };
  const pricePer1M = options.pricePer1M ?? 1;
  const price = { id: "price-routing", accessPointId: accessPoint.id, planId: "plan-routing", status: "enabled", inputPer1M: pricePer1M, cachedInputPer1M: pricePer1M, cacheWritePer1M: null, outputPer1M: pricePer1M, createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z" };
  const cost = { id: "cost-routing", providerId: provider.id, providerModelName: "gpt-5", status: "enabled", source: "manual", inputPer1M: pricePer1M, cachedInputPer1M: pricePer1M, cacheWritePer1M: null, outputPer1M: pricePer1M, createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z" };
  const subscription = { id: "subscription-routing", scopeRef: "user:user-1", planId: "plan-routing", subscriptionLifecycle: "active", effectiveStart: "2026-08-22T00:00:00.000Z", effectiveEnd: null, priority: 0, createdAt: "2026-08-22T00:00:00.000Z" };
  const plan = { id: "plan-routing", name: "Routing", version: 1, planStatus: "enabled", billingMode: options.billingMode ?? "prepaid", scopeRef: "user:user-1" };
  const creditAccount = { id: "credit-routing", scopeRef: "user:user-1", status: "active", balanceSnapUnits: options.balanceUnits ?? 0 };
  const activeSubscription = { scopeRef: "user:user-1", subscription, plan, budgetLimits: [] };
  const requestLogs = new Map<string, Record<string, unknown>>();
  const planSourceReads = vi.fn(async () => ({
    items: [{
      order: { id: "order-routing", userId: "user-1", exposedModel: "public-model", planId: plan.id, subscriptionScopeRef: subscription.scopeRef, position: 0 },
      subscription,
      plan,
      accessPoint,
      configurationError: null,
    }],
    nextCursor: null,
  }));
  const admitCpaBasic = vi.fn(async (input: { requestId: string }) => ({ providerAttemptId: `provider-attempt-${input.requestId}`, startedAt: "2026-08-22T00:00:00.000Z", replayed: false }));
  const admitProtected = vi.fn(async (input: { requestId: string }) => ({ providerAttemptId: `provider-attempt-${input.requestId}`, startedAt: "2026-08-22T00:00:00.000Z" }));
  const settleCpaBasicLive = vi.fn(async () => {
    if (options.settlementFailure) throw new Error("Verification settlement failure");
    return { actualChargeUnits: 0n, postingLedgerEventId: options.pricePer1M === 0 ? null : "ledger-routing", billingEventId: "billing-routing" };
  });
  const settleFinalUsage = vi.fn(async () => ({ actualChargeUnits: 0n, postingLedgerEventId: null, billingEventId: "billing-routing" }));
  const assertDispatchOwnership = vi.fn(async () => undefined);
  const releaseNotStarted = vi.fn(async () => ({ actualChargeUnits: 0n, postingLedgerEventId: null, billingEventId: "billing-routing" }));
  const enterReconciliation = vi.fn(async () => undefined);
  const factWrites = vi.fn(async () => ({ billingEvent: { id: "billing-routing" } }));
  const usageChargeWrites = vi.fn(async (input: { billingEvent: { billableAmount: number } }) => ({
    billingEvent: { id: "billing-routing" },
    ledgerEvent: input.billingEvent.billableAmount === 0 ? null : { id: "ledger-routing" },
  }));
  const repository = {
    async isRequestCaptureEnabled() { return false; },
    async listPipelinePluginSettings() { return []; },
    pageOrderedPlanSourcesForUser: planSourceReads,
    async listPlanBudgetLimitsForPlans() { return new Map([[plan.id, []]]); },
    async findEffectivePlanAccessPointPrices(inputs: Array<{ planId: string; accessPointId: string }>) {
      return inputs.map((input) => ({
        planId: input.planId,
        accessPointId: input.accessPointId,
        effectivePrice: {
          price: { ...price, id: `price-${input.planId}`, planId: input.planId },
          source: "plan_access_point",
          basePrice: null,
          planAccessPointPrice: { ...price, id: `price-${input.planId}`, planId: input.planId },
        },
      }));
    },
    async findEffectivePlanAccessPointPrice() { return { price, source: "plan_access_point", basePrice: null, planAccessPointPrice: price }; },
    async findCreditAccountForScope() { return plan.billingMode === "paygo" ? creditAccount : undefined; },
    async getCreditAccountBalanceUnits() { return creditAccount.balanceSnapUnits; },
    async getCreditAccountBalance() { return creditAccount.balanceSnapUnits / 1_000_000; },
    async listScopeBudgetPolicyAssignments() { return options.directBudgetExhausted ? [{
      id: "direct-budget-routing",
      scopeRef: "key:key-ordinary",
      status: "enabled",
      createdAt: "2026-08-22T00:00:00.000Z",
      budgetPolicy: { id: "budget-routing", status: "enabled", metric: options.directBudgetExhausted, limitValue: 1, windowType: "cumulative", windowSeconds: null },
    }] : []; },
    async listScopeGovernanceBudgetPolicyAssignments() { return []; },
    async listScopeRateLimitPolicyAssignments() { return []; },
    async usageForSubscription() { return { usedTokens: 0, usedAmount: 0 }; },
    async usageForSubscriptionUser() { return { usedTokens: 0, usedAmount: 0 }; },
    async usageForScope() {
      return options.directBudgetExhausted === "tokens"
        ? { usedTokens: 1, usedAmount: 0 }
        : options.directBudgetExhausted === "amount"
          ? { usedTokens: 0, usedAmount: 1 }
          : { usedTokens: 0, usedAmount: 0 };
    },
    async listPlanSubscriptionBudgetUsage() { return []; },
    async summarizeScopeBudgetUsageWindows(_scopeRef: string, windows: Array<Record<string, unknown>>) {
      return windows.map((window) => ({
        ...window,
        usedTokens: options.directBudgetExhausted === "tokens" ? 1 : 0,
        usedAmount: options.directBudgetExhausted === "amount" ? 1 : 0,
        recovery: { nextRecoveryAt: null, nextRecoveryValue: null, fullRecoveryAt: null },
      }));
    },
    async listActiveSubscriptionsForUser() { return [activeSubscription]; },
    async findActivePlanSubscriptions() { return [subscription]; },
    async findEnabledProviderModelCost() { return cost; },
    async findEnabledProviderModelCosts() { return [cost]; },
    async findEnabledAccessPointPrice() { return price; },
    async findEnabledAccessPointPrices() { return [price]; },
    async listAccessPointTargets() { return [target]; },
    async getProvider() { return provider; },
    async getApiKey(id: string) { return { id, userId: "user-1", status: "enabled", revokedAt: null }; },
    async createRequestLog(input: { id: string }) {
      const log = { ...input, startedAt: "2026-08-22T00:00:00.000Z", endedAt: null };
      requestLogs.set(input.id, log);
      return log;
    },
    async getRequestLog(id: string) { return requestLogs.get(id); },
    async enrichRequestLogResolution(id: string, input: Record<string, unknown>) {
      const log = { ...(requestLogs.get(id) ?? {}), ...input };
      requestLogs.set(id, log);
      return log;
    },
    async finishRequestLog(id: string, status: string, errorCode?: string | null) {
      requestLogs.set(id, { ...(requestLogs.get(id) ?? {}), status, errorCode: errorCode ?? null, endedAt: "2026-08-22T00:00:01.000Z" });
    },
    async finalizeRequestPipelineSnapshot() { return undefined; },
    async settleProviderUsage(input: Parameters<GatewayCommands["settleProviderUsage"]>[0]) {
      return input.requiresUsageCharge
        ? usageChargeWrites({ ...input.facts, usageChargeAccountId: input.usageChargeAccountId, actorUserId: input.actorUserId, allowOverdraft: input.allowUsageOverdraft })
        : factWrites(input.facts);
    },
  } as unknown as GatewayQueries & GatewayCommands;
  const routingCandidate = {
    candidateId: "ap-routing:edge-routing",
    selectorTargetEdgeId: "edge-routing",
    selectorPosition: 0,
    pathTargetEdgeIds: ["edge-routing"],
    accessPointChainIds: [accessPoint.id],
    routingRevisions: [{ accessPointId: accessPoint.id, routingRevision: 1 }],
    providerId: provider.id,
    providerModelId: "provider_model_pipeline",
    providerModelName: "gpt-5",
    available: true,
    unavailableReason: null,
  };
  const routingReads = vi.fn(async () => ({
    outcome: "available",
    evaluatedAt: "2026-08-22T00:00:00.000Z",
    plan: {
      entryAccessPointId: accessPoint.id,
      requestedModel: "public-model",
      selectorAccessPointId: accessPoint.id,
      selectorId: "direct",
      selectorBehaviorVersion: 1,
      selectorConfig: {},
      routingRevision: 1,
      candidates: [routingCandidate],
    },
    candidates: [routingCandidate],
    selectedCandidateId: routingCandidate.candidateId,
    selectedCandidate: routingCandidate,
    scopeReferences: {
      accessPoints: [{ id: accessPoint.id, scopeRef: accessPoint.scopeRef, routingRevision: 1 }],
      providers: [{ id: provider.id, scopeRef: provider.scopeRef }],
    },
    work: { visitedNodes: 1, visitedEdges: 1, decodedConfigBytes: 2, evaluatedCandidates: 1 },
  }));
  const targetReads = vi.fn(async () => targetMaterial());
  const baseCalls: ProviderAdapterRequest[] = [];
  const baseAdapter = {
    async invoke(request: ProviderAdapterRequest): Promise<ProviderAdapterResponse> {
      baseCalls.push(request);
      const usageInput = options.providerUsage === undefined ? { inputTokens: 2, outputTokens: 1 } : options.providerUsage;
      const usage = usageInput ? { inputTokens: usageInput.inputTokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: usageInput.outputTokens, totalTokens: usageInput.inputTokens + usageInput.outputTokens, source: "response" as const } : undefined;
      const evidence = options.providerFailure
        ? {
            version: 1 as const,
            costExposure: options.providerFailure.costExposure,
            finalUsageEvidence: options.providerFailure.finalUsageEvidence,
            ...(options.providerFailure.trustedUsage ? { trustedUsage: options.providerFailure.trustedUsage } : {}),
          }
        : usage
          ? { version: 1 as const, costExposure: "stopped" as const, finalUsageEvidence: "final" as const, trustedUsage: usage }
          : { version: 1 as const, costExposure: "accruing" as const, finalUsageEvidence: "pending" as const };
      return {
        status: options.providerStatus ?? 200,
        body: { output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] },
        evidence,
        ...(usage ? { usage } : {}),
        ...(options.providerFailure ? { failure: options.providerFailure } : {}),
      };
    },
  };
  const runtime = new DefaultProviderRuntime(
    { loadAvailableTarget: targetReads },
    baseAdapter,
    options.stage1 ? undefined : cpaPreparationFixture,
  );
  const executor = new AsyncGatewayExecutor(
    repository,
    repository,
    runtime,
    { writeCapturedExchange() {}, async beginCapturedStream() { throw new Error("capture is disabled"); } },
    { async assertPreferredPartnerSourceActive() {}, async assertPartnerAccessActiveForScope() {}, async assertPartnerAccessActiveForScopes() {}, async assertTeamProviderAccessActive() {}, async assertProviderAccessActiveForProviders() {}, async assertPersonalProviderAccessActive() {} },
    async () => undefined,
    undefined,
    undefined,
    {
      admit: admitProtected,
      admitCpaBasic,
      settleFinalUsage,
      settleCpaBasicLive,
      assertDispatchOwnership,
      releaseNotStarted,
      enterReconciliation,
    } as never,
    { evaluateGatewayRouting: routingReads } as never,
    {
      async acquire(command) { return { ...command, acquiredAt: "2026-08-22T00:00:00.000Z", heartbeatAt: "2026-08-22T00:00:00.000Z", leaseUntil: "2999-08-22T01:00:00.000Z" }; },
      async renew(command) { return { ...command, acquiredAt: "2026-08-22T00:00:00.000Z", heartbeatAt: "2026-08-22T00:00:00.000Z", leaseUntil: "2999-08-22T01:00:00.000Z" }; },
      async release() { return true; },
    },
  );
  return { executor, planSourceReads, routingReads, targetReads, baseCalls, admitCpaBasic, admitProtected, settleCpaBasicLive, settleFinalUsage, assertDispatchOwnership, releaseNotStarted, enterReconciliation, factWrites, usageChargeWrites };
}
