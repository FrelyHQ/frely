import { describe, expect, test } from "vitest";
import { RelayError, type ProviderCredentialFailureReason } from "@frely/core";
import { AsyncGatewayExecutor, normalizeProviderInvocationServiceTier, RequestTiming, type GatewayUsage, type ProviderStreamEvent } from "./index.js";

describe("AsyncGatewayExecutor", () => {
  function createProviderInvocationFixture(preparationStage: "protected" | "stage1" = "protected") {
    const invocationCalls: string[] = [];
    const routingBudgets: unknown[] = [];
    const finishedRequestLogs: Array<{ requestId: string; status: string; errorCode: string | null; failureReason?: ProviderCredentialFailureReason }> = [];
    const terminalFinalizations: Array<Record<string, unknown>> = [];
    const createdRequestLogInputs: Array<Record<string, unknown>> = [];
    let providerOptions: Record<string, unknown> | undefined;
    let providerCredentialFailure: { reason: ProviderCredentialFailureReason; publicCode: string; retryable: boolean } | null = null;
    let preAdmissionError: unknown = null;
    let admittedAttemptCount = 0;
    let adapterCallCount = 0;
    let billingWriteCount = 0;
    let dispatchLeaseUntil = "2999-08-03T01:00:00.000Z";
    const accessPoint = {
      id: "ap-a",
      name: "Model A",
      apiFamily: "openai",
      status: "enabled",
      scopeRef: "user:user-a",
      ownerId: "user-a",
      exposedModel: "model-a",
      targetModel: "model-a",
      targetType: "provider",
      selectorId: "direct",
      selectorBehaviorVersion: 1,
      selectorConfigJson: "{}",
      requestOverridesJson: "{}",
      routingRevision: 1,
    };
    const target = { id: "target-a", accessPointId: "ap-a", position: 0, status: "enabled", targetType: "provider", targetProviderId: "provider-a", targetProviderModelName: "model-a" };
    const provider = { id: "provider-a", kind: "openai", status: "enabled", scopeRef: "user:user-a", credentialResolver: "identity:provider-a", configJson: "{}" };
    const price = { id: "price-a", accessPointId: "ap-a", planId: "plan-a", status: "enabled", inputPer1M: 1, cachedInputPer1M: 1, cacheWritePer1M: null, outputPer1M: 1, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z" };
    const cost = { id: "cost-a", providerId: "provider-a", providerModelName: "model-a", status: "enabled", source: "manual", inputPer1M: 0.1, cachedInputPer1M: 0.1, cacheWritePer1M: null, outputPer1M: 0.1, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z" };
    const subscription = { id: "subscription-a", scopeRef: "user:user-a", planId: "plan-a", subscriptionLifecycle: "active", effectiveStart: "2026-08-01T00:00:00.000Z", effectiveEnd: null, priority: 0, createdAt: "2026-08-01T00:00:00.000Z" };
    const plan = { id: "plan-a", planStatus: "enabled", billingMode: "prepaid", scopeRef: "user:user-a" };
    const subscriptionB = { ...subscription, id: "subscription-b", planId: "plan-b" };
    const planB = { ...plan, id: "plan-b" };
    const requestLog = { id: "request-a", startedAt: "2026-08-03T00:00:00.000Z", endedAt: null, apiKeyId: "key-a", userId: "user-a", teamId: null, reqModel: "model-a" };
    const repository = {
      async isRequestCaptureEnabled() { return false; },
      async listPipelinePluginSettings() { return []; },
      async pageOrderedPlanSourcesForUser() { return { items: [
        { order: { id: "order-a", userId: "user-a", exposedModel: "model-a", planId: "plan-a", subscriptionScopeRef: "user:user-a", position: 0 }, subscription, plan, accessPoint, configurationError: null },
        { order: { id: "order-b", userId: "user-a", exposedModel: "model-a", planId: "plan-b", subscriptionScopeRef: "user:user-a", position: 1 }, subscription: subscriptionB, plan: planB, accessPoint, configurationError: null },
      ], nextCursor: null }; },
      async findFirstEffectiveUserModelPlanScopeOrder() { return null; },
      async listPlanBudgetLimitsForPlans() { return new Map([["plan-a", []], ["plan-b", []]]); },
      async findEffectivePlanAccessPointPrice(planId: string) { const selectedPrice = { ...price, id: `price-${planId}`, planId }; return { price: selectedPrice, source: "plan_access_point", basePrice: null, planAccessPointPrice: selectedPrice }; },
      async findCreditAccountForScope() { return undefined; },
      async getCreditAccountBalance() { return 0; },
      async listScopeBudgetPolicyAssignments() { return []; },
      async listScopeGovernanceBudgetPolicyAssignments() { return []; },
      async listScopeRateLimitPolicyAssignments() { return []; },
      async summarizeScopeBudgetUsageWindows() { return []; },
      async listPlanSubscriptionBudgetUsage() { return []; },
      async usageForSubscription() { return { usedTokens: 0, usedAmount: 0 }; },
      async usageForSubscriptionUser() { return { usedTokens: 0, usedAmount: 0 }; },
      async usageForScope() { return { usedTokens: 0, usedAmount: 0 }; },
      async listActiveSubscriptionsForUser() { return [{ scopeRef: "user:user-a", subscription, plan, budgetLimits: [] }]; },
      async findActivePlanSubscriptions() { return [subscription, subscriptionB]; },
      async listAccessPointsVisibleAtScope() { return [accessPoint]; },
      async getAccessPoint() { return accessPoint; },
      async listAccessPointTargets() { return [target]; },
      async getProvider() { return provider; },
      async getProviderBinding() { return { providerId: "provider-a", syncStatus: "ready", authMethod: "api-key", credentialOwnership: "control", revision: 1, credentialRefsJson: "[]" }; },
      async getProviderModel() { return { providerId: "provider-a", providerModelName: "model-a", status: "enabled" }; },
      async findEnabledProviderModelCost() { return cost; },
      async findEnabledProviderModelCosts() { return [cost]; },
      async findEnabledAccessPointPrice() { return price; },
      async findEnabledAccessPointPrices() { return [price]; },
      async findEffectivePlanAccessPointPrices(planInputs: Array<{ planId: string }>) {
        return planInputs.map((input) => {
          const selectedPrice = { ...price, id: `price-${input.planId}`, planId: input.planId };
          return { planId: input.planId, accessPointId: "ap-a", effectivePrice: { price: selectedPrice, source: "plan_access_point" as const, basePrice: null, planAccessPointPrice: selectedPrice } };
        });
      },
      async createRequestLog(input: Record<string, unknown>) { createdRequestLogInputs.push(input); return requestLog; },
      async getRequestLog() { return requestLog; },
      async enrichRequestLogResolution() { return requestLog; },
      async finishRequestLog(requestId: string, status: string, errorCode?: string | null, failureReason?: ProviderCredentialFailureReason | null) {
        finishedRequestLogs.push({ requestId, status, errorCode: errorCode ?? null, ...(failureReason ? { failureReason } : {}) });
      },
      async finalizeRequestPipelineSnapshot() { return requestLog; },
      async settleProviderUsage() { billingWriteCount += 1; return { billingEvent: { id: "billing-a" } }; },
    } as never;
    const providerInvocation = {
      async admit(command: { planId: string }) {
        invocationCalls.push(`admit:${command.planId}`);
        if (preAdmissionError) throw preAdmissionError;
        if (command.planId === "plan-a") throw new RelayError("plan_subscription_budget_tokens_exceeded", "exact budget denied", 402);
        admittedAttemptCount += 1;
        return { providerAttemptId: "attempt-a", budgetClaimMaxTokens: 0n, budgetClaimMaxChargeUnits: 0n, usageReservationId: null, reservationUnits: null, startedAt: requestLog.startedAt };
      },
      async admitCpaBasic(command: { planId: string }) {
        invocationCalls.push(`admit-basic:${command.planId}`);
        if (command.planId === "plan-a") throw new RelayError("insufficient_credit", "positive balance unavailable", 402);
        admittedAttemptCount += 1;
        return { providerAttemptId: "attempt-basic", startedAt: requestLog.startedAt, replayed: false };
      },
      async assertDispatchOwnership() { invocationCalls.push("dispatch"); },
      async settleFinalUsage(command: Record<string, unknown>) { invocationCalls.push("settle"); terminalFinalizations.push(command); return { actualChargeUnits: 0n, postingLedgerEventId: null }; },
      async settleCpaBasicLive() { invocationCalls.push("settle-basic"); return { actualChargeUnits: 0n, postingLedgerEventId: null, billingEventId: "billing-basic" }; },
      async failRequestExecution() { return undefined; },
      async releaseNotStarted() { throw new Error("unexpected not-started release"); },
      async enterReconciliation() { invocationCalls.push("reconcile"); },
    } as never;
    const executor = new AsyncGatewayExecutor(
      repository,
      repository,
      {
        preparationStage,
        async prepare(input) {
          return {
            target: {
              providerModelId: input.providerModelId,
              providerId: input.providerId,
              providerModelName: input.providerModelName,
              providerKind: "openai",
              cpaInstanceId: "cpa_default",
              providerUpdatedAt: "2026-08-03T00:00:00.000Z",
              providerModelUpdatedAt: "2026-08-03T00:00:00.000Z",
              bindingRevision: 1,
            },
            kind: input.kind,
            sourceFormat: input.sourceFormat,
            sourceModel: input.sourceModel,
            stream: input.stream,
            serviceTier: input.serviceTier,
            options: input.options,
            ...(preparationStage === "protected" ? {
              preparationStage: "protected" as const,
              cpaPreparation: { evidenceId: "cpa-evidence-test", evidenceVersion: 1, preparedPayloadId: "cpa-payload-test" },
              tokenizer: { tokenizerId: "cpa-test-tokenizer", revision: 1, inputTokens: 7 },
              effectiveMaxBillableOutputTokens: 64,
            } : {
              preparationStage: "stage1" as const,
              cpaPreparation: null,
              tokenizer: null,
              effectiveMaxBillableOutputTokens: null,
            }),
          };
        },
        async refreshForDispatch(prepared) {
          return {
            prepared,
            target: { ...prepared.target, authMethod: "api-key", credentialOwnership: "cpa-managed" },
          };
        },
        async invokeAdmittedCandidate(input) {
          invocationCalls.push("invoke-provider");
          adapterCallCount += 1;
          providerOptions = { ...input.dispatch.prepared.options };
          const usage = { inputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 3, source: "provider" as const };
          if (providerCredentialFailure) {
            return {
              status: 502,
              body: { error: { code: providerCredentialFailure.publicCode, message: "safe credential failure" } },
              usage,
              evidence: { version: 1 as const, costExposure: "stopped" as const, finalUsageEvidence: "final" as const, trustedUsage: usage },
              failure: {
                version: 1 as const,
                failureClass: providerCredentialFailure.retryable ? "upstream_5xx" as const : "non_retryable" as const,
                failureReason: providerCredentialFailure.reason,
                costExposure: "stopped" as const,
                finalUsageEvidence: "final" as const,
                trustedUsage: usage,
              },
            };
          }
          return {
            status: 200,
            body: { ok: true, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } },
            usage,
            evidence: { version: 1, costExposure: "stopped", finalUsageEvidence: "final", trustedUsage: usage },
          };
        },
      },
      { writeCapturedExchange() {}, async beginCapturedStream() { throw new Error("capture should be disabled"); } },
      { async assertPreferredPartnerSourceActive() {}, async assertPartnerAccessActiveForScope() {}, async assertPartnerAccessActiveForScopes() {}, async assertTeamProviderAccessActive() {}, async assertProviderAccessActiveForProviders() {}, async assertPersonalProviderAccessActive() {} },
      async () => undefined,
      undefined,
      undefined,
      providerInvocation,
      {
        async evaluateGatewayRouting(input) {
          routingBudgets.push(input.budget);
          const candidate = {
            candidateId: "ap-a:target-a",
            selectorTargetEdgeId: "target-a",
            selectorPosition: 0,
            pathTargetEdgeIds: ["target-a"],
            accessPointChainIds: ["ap-a"],
            routingRevisions: [{ accessPointId: "ap-a", routingRevision: 1 }],
            providerId: "provider-a",
            providerModelId: "provider_model-a",
            providerModelName: "model-a",
            available: true,
            unavailableReason: null,
          };
          return {
            outcome: "available",
            evaluatedAt: "2026-08-03T00:00:00.000Z",
            plan: {
              entryAccessPointId: "ap-a",
              requestedModel: "model-a",
              selectorAccessPointId: "ap-a",
              selectorId: "direct",
              selectorBehaviorVersion: 1,
              selectorConfig: {},
              routingRevision: 1,
              candidates: [candidate],
            },
            candidates: [candidate],
            selectedCandidateId: candidate.candidateId,
            selectedCandidate: candidate,
            scopeReferences: {
              accessPoints: [{ id: "ap-a", scopeRef: "user:user-a", routingRevision: 1 }],
              providers: [{ id: "provider-a", scopeRef: "user:user-a" }],
            },
            work: { visitedNodes: 1, visitedEdges: 1, decodedConfigBytes: 2, evaluatedCandidates: 1 },
          };
        },
      },
      {
        async acquire(command) {
          return { requestId: command.requestId, ownerId: command.ownerId, acquiredAt: requestLog.startedAt, heartbeatAt: requestLog.startedAt, leaseUntil: "2026-08-03T01:00:00.000Z" };
        },
        async renew(command) {
          return { requestId: command.requestId, ownerId: command.ownerId, acquiredAt: requestLog.startedAt, heartbeatAt: requestLog.startedAt, leaseUntil: dispatchLeaseUntil };
        },
        async release() { return true; },
      },
    );
    return {
      executor,
      invocationCalls,
      routingBudgets,
      finishedRequestLogs,
      createdRequestLogInputs,
      terminalFinalizations,
      providerOptions: () => providerOptions,
      admittedAttemptCount: () => admittedAttemptCount,
      adapterCallCount: () => adapterCallCount,
      billingWriteCount: () => billingWriteCount,
      failBeforeAdmission(error: unknown = new Error("pre-admission failure")) { preAdmissionError = error; },
      failProviderCredential(reason: ProviderCredentialFailureReason, publicCode: string, retryable: boolean) { providerCredentialFailure = { reason, publicCode, retryable }; },
      expireDispatchLease() { dispatchLeaseUntil = "2000-01-01T00:00:00.000Z"; },
    };
  }

  test("scans the next Plan source after exact first-admission budget denial", async () => {
    const fixture = createProviderInvocationFixture();
    const timing = new RequestTiming();
    const response = await fixture.executor.invoke({ apiKey: { id: "key-a" }, user: { id: "user-a" }, effectiveScopes: ["global:", "user:user-a"] } as never, { kind: "chat.completions", model: "model-a", payload: { model: "model-a", input: "hello", max_completion_tokens: 64 }, timing });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
    expect(fixture.invocationCalls).toEqual(["admit:plan-a", "admit:plan-b", "dispatch", "invoke-provider", "settle"]);
    expect(fixture.routingBudgets).toHaveLength(2);
    expect(fixture.routingBudgets[1]).toBe(fixture.routingBudgets[0]);
    expect(response.gatewaySummary?.billingSubscriptionId).toBe("subscription-b");
    expect(fixture.providerOptions()?.max_completion_tokens).toBe(64);
    expect(timing.activeStages()).toEqual([]);
    expect(timing.stageMs()["provider.admit"]).toBeDefined();
  });

  test("persists a typed credential failure in the terminal ProviderAttempt and Request Log", async () => {
    const fixture = createProviderInvocationFixture();
    fixture.failProviderCredential("auth_unavailable", "cliproxy_provider_credentials_unavailable", true);

    const response = await fixture.executor.invoke(
      { apiKey: { id: "key-a" }, user: { id: "user-a" }, effectiveScopes: ["global:", "user:user-a"] } as never,
      { kind: "chat.completions", model: "model-a", payload: { model: "model-a", input: "hello", max_completion_tokens: 64 }, requestId: "request-a" },
    );

    expect(response).toMatchObject({
      status: 502,
      body: { error: { code: "cliproxy_provider_credentials_unavailable" } },
      gatewaySummary: { errorDiagnostic: { causeCode: "auth_unavailable" } },
    });
    expect(fixture.terminalFinalizations).toHaveLength(1);
    expect(fixture.terminalFinalizations[0]).toMatchObject({ outcome: "failed", failureClass: "upstream_5xx", failureReason: "auth_unavailable" });
    expect(fixture.finishedRequestLogs).toEqual([{ requestId: "request-a", status: "failed", errorCode: "cliproxy_provider_credentials_unavailable", failureReason: "auth_unavailable" }]);
  });

  test("propagates ingress Host and route snapshots into Request Log creation", async () => {
    const fixture = createProviderInvocationFixture();
    await fixture.executor.invoke(
      { apiKey: { id: "key-a" }, user: { id: "user-a" }, effectiveScopes: ["global:", "user:user-a"] } as never,
      { kind: "chat.completions", model: "model-a", payload: { model: "model-a", input: "hello", max_completion_tokens: 64 }, ingressHostname: "relay.example.test", ingressRouteId: "edge:relay.hk-v1" },
    );

    expect(fixture.createdRequestLogInputs).toHaveLength(1);
    expect(fixture.createdRequestLogInputs[0]).toMatchObject({
      ingressHostname: "relay.example.test",
      ingressRouteId: "edge:relay.hk-v1",
    });
  });

  test("routes claimless Stage 1 through admission ownership before dispatch", async () => {
    const fixture = createProviderInvocationFixture("stage1");
    const response = await fixture.executor.invoke(
      { apiKey: { id: "key-a" }, user: { id: "user-a" }, effectiveScopes: ["global:", "user:user-a"] } as never,
      { kind: "chat.completions", model: "model-a", payload: { model: "model-a", input: "hello", max_completion_tokens: 64 } },
    );

    expect(response.status).toBe(200);
    expect(fixture.invocationCalls).toEqual(["admit-basic:plan-a", "admit-basic:plan-b", "dispatch", "invoke-provider", "settle-basic"]);
    expect(fixture.admittedAttemptCount()).toBe(1);
    expect(fixture.adapterCallCount()).toBe(1);
  });

  test("fails closed when the renewed lease expires after ownership assertion but before Provider dispatch", async () => {
    const fixture = createProviderInvocationFixture("stage1");
    fixture.expireDispatchLease();

    await expect(fixture.executor.invoke(
      { apiKey: { id: "key-a" }, user: { id: "user-a" }, effectiveScopes: ["global:", "user:user-a"] } as never,
      { kind: "chat.completions", model: "model-a", payload: { model: "model-a", input: "hello", max_completion_tokens: 64 } },
    )).rejects.toMatchObject({ code: "provider_invocation_reconciliation_required" });
    expect(fixture.invocationCalls).toEqual(["admit-basic:plan-a", "admit-basic:plan-b", "dispatch", "reconcile"]);
    expect(fixture.adapterCallCount()).toBe(0);
  });

  test("records an untyped pre-admission failure without a ProviderAttempt, billing, or Provider call", async () => {
    const fixture = createProviderInvocationFixture();
    fixture.failBeforeAdmission();
    const timing = new RequestTiming();

    await expect(fixture.executor.invoke(
      { apiKey: { id: "key-a" }, user: { id: "user-a" }, effectiveScopes: ["global:", "user:user-a"] } as never,
      { kind: "chat.completions", model: "model-a", payload: { model: "model-a", input: "hello", max_completion_tokens: 64 }, requestId: "req-pre-admission", timing },
    )).rejects.toThrowError("pre-admission failure");

    expect(fixture.finishedRequestLogs).toEqual([{ requestId: "req-pre-admission", status: "failed", errorCode: "provider_error" }]);
    expect(fixture.admittedAttemptCount()).toBe(0);
    expect(fixture.billingWriteCount()).toBe(0);
    expect(fixture.adapterCallCount()).toBe(0);
    expect(timing.activeStages()).toEqual([]);
    expect(timing.stageMs()["provider.admit"]).toBeDefined();
  });

  test("classifies Prisma transaction timeout as a Gateway admission failure", async () => {
    const fixture = createProviderInvocationFixture();
    fixture.failBeforeAdmission({ code: "P2028", message: "transaction timeout" });
    const timing = new RequestTiming();

    await expect(fixture.executor.invoke(
      { apiKey: { id: "key-a" }, user: { id: "user-a" }, effectiveScopes: ["global:", "user:user-a"] } as never,
      { kind: "chat.completions", model: "model-a", payload: { model: "model-a", input: "hello", max_completion_tokens: 64 }, requestId: "req-p2028", timing },
    )).rejects.toMatchObject({ code: "provider_admission_infrastructure_failure", status: 503 });

    expect(fixture.finishedRequestLogs).toEqual([{ requestId: "req-p2028", status: "failed", errorCode: "provider_admission_infrastructure_failure" }]);
    expect(fixture.admittedAttemptCount()).toBe(0);
    expect(fixture.billingWriteCount()).toBe(0);
    expect(fixture.adapterCallCount()).toBe(0);
    expect(timing.activeStages()).toEqual([]);
    expect(timing.stageMs()["provider.admit"]).toBeDefined();
  });

  const executorForPrivateMethodTests = () => new AsyncGatewayExecutor(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    async () => undefined,
  );

  test("does not run the legacy stream failure charge after ProviderInvocation settled the attempt", async () => {
    const executor = executorForPrivateMethodTests();
    const calls: string[] = [];
    const source = (async function* (): AsyncIterable<ProviderStreamEvent> {
      yield { type: "chunk", data: { delta: "visible" } };
      yield { type: "error", code: "upstream_5xx", message: "failed", retryable: true };
    })();
    const wrapped = (executor as unknown as {
      wrapStreamForBilling(stream: AsyncIterable<ProviderStreamEvent>, input: {
        commitBilling: (usage: GatewayUsage) => Promise<void>;
        completeRequest: (usage: GatewayUsage | undefined) => Promise<void>;
        providerInvocationManaged?: boolean;
        failRequest: (code: string) => Promise<void>;
      }): AsyncIterable<ProviderStreamEvent>;
    }).wrapStreamForBilling(source, {
      async commitBilling() { calls.push("legacy-commit"); },
      async completeRequest() { calls.push("complete"); },
      providerInvocationManaged: true,
      async failRequest(code) { calls.push(`failed:${code}`); },
    });

    const events: ProviderStreamEvent[] = [];
    for await (const event of wrapped) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["chunk", "error"]);
    expect(calls).toEqual(["failed:upstream_5xx"]);
  });

  test("settles response.failed final usage once as failed and preserves its stable error code", async () => {
    const calls: string[] = [];
    const finalizations: Array<{ outcome: "failed" | "aborted"; outputCommitted: boolean; errorCode: string; finalUsageEvidence: string }> = [];
    const executor = executorForPrivateMethodTests();
    const usage = { inputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 3, source: "provider" as const };
    const terminalFailure = { version: 1 as const, failureClass: "non_retryable" as const, failureReason: "auth_unauthorized" as const, costExposure: "stopped" as const, finalUsageEvidence: "final" as const, trustedUsage: usage };
    const terminal = { outcome: "failed" as const, code: "cliproxy_provider_credentials_unauthorized", message: "failed", retryable: false, failure: terminalFailure };
    const source = (async function* (): AsyncIterable<ProviderStreamEvent> {
      yield { type: "chunk", data: { type: "response.failed", response: { status: "failed" } }, terminal };
      yield { type: "error", code: terminal.code, message: terminal.message, retryable: terminal.retryable, failure: terminalFailure };
    })();
    const wrapped = (executor as unknown as {
      wrapStreamForBilling(stream: AsyncIterable<ProviderStreamEvent>, input: {
        commitBilling: (usage: GatewayUsage) => Promise<void>;
        completeRequest: (evidence: unknown) => Promise<void>;
        providerInvocationManaged?: boolean;
        finalizeFailure: (failure: typeof terminalFailure, outcome: "failed" | "aborted", outputCommitted: boolean, errorCode: string) => Promise<void>;
        failRequest: (code: string, diagnostic?: unknown, failureReason?: ProviderCredentialFailureReason) => Promise<void>;
      }): AsyncIterable<ProviderStreamEvent>;
    }).wrapStreamForBilling(source, {
      async commitBilling() { calls.push("unexpected-success-commit"); },
      async completeRequest() { calls.push("unexpected-complete"); },
      providerInvocationManaged: true,
      async finalizeFailure(observed, outcome, outputCommitted, errorCode) {
        finalizations.push({ outcome, outputCommitted, errorCode, finalUsageEvidence: observed.finalUsageEvidence });
      },
      async failRequest(code, _diagnostic, failureReason) { calls.push(`failed:${code}:${failureReason ?? "none"}`); },
    });

    const events: ProviderStreamEvent[] = [];
    for await (const event of wrapped) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["chunk", "error"]);
    expect(finalizations).toEqual([{ outcome: "failed", outputCommitted: true, errorCode: "cliproxy_provider_credentials_unauthorized", finalUsageEvidence: "final" }]);
    expect(calls).toEqual(["failed:cliproxy_provider_credentials_unauthorized:auth_unauthorized"]);
  });

  test("completes exact terminal evidence before a client returns after the public terminal chunk", async () => {
    const calls: string[] = [];
    const executor = executorForPrivateMethodTests();
    const usage = { inputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 3, source: "provider" as const };
    const evidence = { version: 1 as const, costExposure: "stopped" as const, finalUsageEvidence: "final" as const, trustedUsage: usage };
    const source = (async function* (): AsyncIterable<ProviderStreamEvent> {
      yield { type: "chunk", data: { type: "response.completed" }, terminal: { outcome: "succeeded", evidence, usage } };
      await new Promise<never>(() => undefined);
    })();
    const wrapped = (executor as unknown as {
      wrapStreamForBilling(stream: AsyncIterable<ProviderStreamEvent>, input: {
        commitBilling: (usage: GatewayUsage) => Promise<void>;
        completeRequest: (evidence: unknown) => Promise<void>;
        finalizeFailure: () => Promise<void>;
        failRequest: (code: string) => Promise<void>;
      }): AsyncIterable<ProviderStreamEvent>;
    }).wrapStreamForBilling(source, {
      async commitBilling() { calls.push("unexpected-direct-commit"); },
      async completeRequest(observed) {
        expect(observed).toEqual(evidence);
        calls.push("complete");
      },
      async finalizeFailure() { calls.push("unexpected-failure-finalization"); },
      async failRequest(code) { calls.push(`unexpected-failure:${code}`); },
    });
    const iterator = wrapped[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("chunk");
    await iterator.return?.();
    expect(calls).toEqual(["complete"]);
  });

  test("persists public output for claimless incomplete and cancelled streams", async () => {
    const executor = executorForPrivateMethodTests();
    for (const terminal of ["incomplete", "cancel"] as const) {
      const finalizations: Array<{ outcome: "failed" | "aborted"; outputCommitted: boolean; errorCode: string }> = [];
      const source = (async function* (): AsyncIterable<ProviderStreamEvent> {
        yield { type: "chunk", data: { delta: "visible" } };
        if (terminal === "cancel") await new Promise<never>(() => undefined);
      })();
      const wrapped = (executor as unknown as {
        wrapStreamForBilling(stream: AsyncIterable<ProviderStreamEvent>, input: {
          commitBilling: (usage: GatewayUsage) => Promise<void>;
          completeRequest: (usage: GatewayUsage | undefined) => Promise<void>;
          finalizeFailure: (failure: unknown, outcome: "failed" | "aborted", outputCommitted: boolean, errorCode: string) => Promise<void>;
          failRequest: (code: string) => Promise<void>;
        }): AsyncIterable<ProviderStreamEvent>;
      }).wrapStreamForBilling(source, {
        async commitBilling() { throw new Error("unexpected billing"); },
        async completeRequest() { throw new Error("unexpected completion"); },
        async finalizeFailure(_failure, outcome, outputCommitted, errorCode) { finalizations.push({ outcome, outputCommitted, errorCode }); },
        async failRequest() {},
      });
      const iterator = wrapped[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.type).toBe("chunk");
      if (terminal === "cancel") await iterator.return?.();
      else expect((await iterator.next()).done).toBe(true);
      expect(finalizations).toEqual([{
        outcome: terminal === "cancel" ? "aborted" : "failed",
        outputCommitted: true,
        errorCode: terminal === "cancel" ? "cliproxy_request_aborted" : "provider_stream_incomplete",
      }]);
    }
  });

  test("does not turn a done event's unbound usage into final evidence", async () => {
    const calls: unknown[] = [];
    const executor = executorForPrivateMethodTests();
    const usage = { inputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 3, source: "provider" as const };
    const source = (async function* (): AsyncIterable<ProviderStreamEvent> {
      yield { type: "done", usage };
    })();
    const wrapped = (executor as unknown as {
      wrapStreamForBilling(stream: AsyncIterable<ProviderStreamEvent>, input: {
        commitBilling: (usage: GatewayUsage) => Promise<void>;
        completeRequest: (evidence: unknown) => Promise<void>;
        finalizeFailure: () => Promise<void>;
        failRequest: () => Promise<void>;
      }): AsyncIterable<ProviderStreamEvent>;
    }).wrapStreamForBilling(source, {
      async commitBilling() { calls.push("unexpected-commit"); },
      async completeRequest(evidence) { calls.push(evidence); },
      async finalizeFailure() { calls.push("unexpected-failure"); },
      async failRequest() { calls.push("unexpected-request-failure"); },
    });

    expect((await wrapped[Symbol.asyncIterator]().next()).value?.type).toBe("done");
    expect(calls).toEqual([undefined]);
  });
});

describe("provider invocation stage-one evidence", () => {
  test("freezes only stage-one supported service tiers", () => {
    expect(normalizeProviderInvocationServiceTier(undefined)).toBe("standard");
    expect(normalizeProviderInvocationServiceTier(" Priority ")).toBe("priority");
    expect(() => normalizeProviderInvocationServiceTier("flex")).toThrowError(expect.objectContaining({ code: "provider_service_tier_unsupported" }));
  });
});
