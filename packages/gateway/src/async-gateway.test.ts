import { describe, expect, test, vi } from "vitest";
import type { GatewayRoutingQueryPort, GatewayRoutingSnapshot } from "@frely/model-access/routing-runtime";
import { AsyncGatewayModelService } from "./async-gateway.js";
import { AsyncAccessResolutionService } from "./async-services.js";

function source(scopeRef = "team:team-a") {
  return {
    order: { id: "order-a", subscriptionScopeRef: scopeRef },
    subscription: { id: "subscription-a" },
    plan: { id: "plan-a" },
    accessPoint: { id: "ap-a", name: "Model A", apiFamily: "openai", status: "enabled", targetModel: "model-a", exposedModel: "model-a" },
    configurationError: null,
  } as never;
}

function sourcePage(...items: ReturnType<typeof source>[]) {
  return { items, nextCursor: null };
}

function routingSnapshot(
  outcome: "available" | "unavailable" = "available",
  options: { accessPointScopes?: string[]; providerIds?: string[]; providerScopes?: string[] } = {},
): GatewayRoutingSnapshot {
  return {
    outcome,
    evaluatedAt: "2026-08-22T00:00:00.000Z",
    plan: {},
    candidates: [],
    selectedCandidateId: outcome === "available" ? "candidate-a" : null,
    selectedCandidate: outcome === "available" ? {} : null,
    scopeReferences: {
      accessPoints: (options.accessPointScopes ?? ["team:team-a"]).map((scopeRef, index) => ({ id: `ap-${index}`, scopeRef, routingRevision: 1 })),
      providers: (options.providerIds ?? ["provider-a"]).map((id, index) => ({ id, scopeRef: options.providerScopes?.[index] ?? "team:team-a" })),
    },
    work: { visitedNodes: 1, visitedEdges: 1, decodedConfigBytes: 2, evaluatedCandidates: 1 },
  } as unknown as GatewayRoutingSnapshot;
}

function routingQueries(snapshot: GatewayRoutingSnapshot): GatewayRoutingQueryPort {
  return { evaluateGatewayRouting: vi.fn(async () => snapshot) };
}

describe("AsyncGatewayModelService", () => {
  test("lists models from an available routing snapshot", async () => {
    const queries = routingQueries(routingSnapshot());
    const service = new AsyncGatewayModelService({
      async listEffectiveUserModelPlanSourceModels() {
        return ["model-a", "model-a", "model-missing"];
      },
      async pageOrderedPlanSourcesForUser(_userId, model) {
        return sourcePage(...(model === "model-missing" ? [] : [source()]));
      },
    }, {
      async assertPartnerAccessActiveForScope() {},
      async assertPartnerAccessActiveForScopes() {},
      async assertTeamProviderAccessActive() {},
      async assertProviderAccessActiveForProviders() {},
    }, queries);

    await expect(service.listModels({ user: { id: "user-a" }, effectiveScopes: ["global:", "team:team-a", "user:user-a"] } as never)).resolves.toMatchObject({
      status: 200,
      body: {
        data: [{ id: "model-a", owned_by: "team:team-a", access_point: { id: "ap-a" } }],
      },
    });
    expect(queries.evaluateGatewayRouting).toHaveBeenCalledTimes(1);
    expect(queries.evaluateGatewayRouting).toHaveBeenCalledWith(expect.objectContaining({ entryAccessPointId: "ap-a", requestedModel: "model-a" }));
  });

  test("excludes a Plan source outside the principal effective scopes", async () => {
    const queries = routingQueries(routingSnapshot());
    const service = new AsyncGatewayModelService({
      async listEffectiveUserModelPlanSourceModels() { return ["model-a"]; },
      async pageOrderedPlanSourcesForUser() { return sourcePage(source("team:team-denied")); },
    }, {
      async assertPartnerAccessActiveForScope() {},
      async assertPartnerAccessActiveForScopes() {},
      async assertTeamProviderAccessActive() {},
      async assertProviderAccessActiveForProviders() {},
    }, queries);

    await expect(service.listModels({ user: { id: "user-a" }, effectiveScopes: ["global:", "team:team-a", "user:user-a"] } as never)).resolves.toMatchObject({
      status: 200,
      body: { data: [] },
    });
    expect(queries.evaluateGatewayRouting).not.toHaveBeenCalled();
  });

  test("continues to a later Plan source that remains inside effective scopes", async () => {
    const queries = routingQueries(routingSnapshot());
    const service = new AsyncGatewayModelService({
      async listEffectiveUserModelPlanSourceModels() { return ["model-a"]; },
      async pageOrderedPlanSourcesForUser() {
        return sourcePage(source("team:team-denied"), source("team:team-a"));
      },
    }, {
      async assertPartnerAccessActiveForScope() {},
      async assertPartnerAccessActiveForScopes() {},
      async assertTeamProviderAccessActive() {},
      async assertProviderAccessActiveForProviders() {},
    }, queries);

    await expect(service.listModels({ user: { id: "user-a" }, effectiveScopes: ["team:team-a"] } as never)).resolves.toMatchObject({
      status: 200,
      body: { data: [{ id: "model-a", owned_by: "team:team-a" }] },
    });
    expect(queries.evaluateGatewayRouting).toHaveBeenCalledTimes(1);
  });

  test("hides models whose routing snapshot is unavailable", async () => {
    const queries = routingQueries(routingSnapshot("unavailable"));
    const service = new AsyncGatewayModelService({
      async listEffectiveUserModelPlanSourceModels() { return ["model-a"]; },
      async pageOrderedPlanSourcesForUser() { return sourcePage(source(), source()); },
    }, {
      async assertPartnerAccessActiveForScope() {},
      async assertPartnerAccessActiveForScopes() {},
      async assertTeamProviderAccessActive() {},
      async assertProviderAccessActiveForProviders() {},
    }, queries);

    await expect(service.listModels({ user: { id: "user-a" }, effectiveScopes: ["team:team-a"] } as never)).resolves.toMatchObject({
      status: 200,
      body: { data: [] },
    });
    expect(queries.evaluateGatewayRouting).toHaveBeenCalledTimes(1);
  });

  test("hides models whose personal Provider slot is no longer active", async () => {
    const personalGuard = vi.fn(async (_providerId?: string, _at?: string, _providerScopeRef?: string) => { throw new Error("personal_provider_entitlement_expired"); });
    const service = new AsyncGatewayModelService({
      async listEffectiveUserModelPlanSourceModels() { return ["model-a"]; },
      async pageOrderedPlanSourcesForUser() { return sourcePage(source("user:user-a")); },
    }, {
      async assertPartnerAccessActiveForScope() {},
      async assertPartnerAccessActiveForScopes() {},
      async assertTeamProviderAccessActive() {},
      async assertProviderAccessActiveForProviders(providers, at) {
        for (const provider of providers) await personalGuard(provider.id, at, provider.scopeRef);
      },
      assertPersonalProviderAccessActive: personalGuard,
    }, routingQueries(routingSnapshot("available", { providerIds: ["provider-personal"], providerScopes: ["user:user-a"] })));

    await expect(service.listModels({ user: { id: "user-a" }, effectiveScopes: ["user:user-a"] } as never)).resolves.toMatchObject({
      status: 200,
      body: { data: [] },
    });
    expect(personalGuard).toHaveBeenCalledWith("provider-personal", expect.any(String), "user:user-a");
  });

  test("hides models whose Team Provider entitlement is no longer active", async () => {
    const service = new AsyncGatewayModelService({
      async listEffectiveUserModelPlanSourceModels() { return ["model-a"]; },
      async pageOrderedPlanSourcesForUser() { return sourcePage(source()); },
    }, {
      async assertPartnerAccessActiveForScope() {},
      async assertPartnerAccessActiveForScopes() {},
      async assertTeamProviderAccessActive() { throw new Error("team_provider_entitlement_expired"); },
      async assertProviderAccessActiveForProviders(providers, at) {
        for (const provider of providers) await this.assertTeamProviderAccessActive(provider.id, at, provider.scopeRef);
      },
    }, routingQueries(routingSnapshot()));

    await expect(service.listModels({ user: { id: "user-a" }, effectiveScopes: ["team:team-a"] } as never)).resolves.toMatchObject({
      status: 200,
      body: { data: [] },
    });
  });
});

describe("AsyncAccessResolutionService compatibility", () => {
  test("keeps the legacy trace wire shape and checks every candidate Provider entitlement", async () => {
    const entry = previewAccessPoint("ap-entry", "team:entry", "ordered-fallback");
    const first = previewAccessPoint("ap-first", "team:first", "direct");
    const second = previewAccessPoint("ap-second", "team:second", "direct");
    const accessPoints = new Map([[entry.id, entry], [first.id, first], [second.id, second]]);
    const providers = new Map([
      ["provider-first", { id: "provider-first", scopeRef: "team:provider-first", credentialResolver: "identity:first" }],
      ["provider-second", { id: "provider-second", scopeRef: "team:provider-second", credentialResolver: "identity:second" }],
    ]);
    const providerEntitlements = vi.fn(async (_providerId: string, _at?: string, _scopeRef?: string) => undefined);
    const partnerAvailability = vi.fn(async (_scopeRef: string, _at?: string) => undefined);
    const candidates = [
      previewRoutingCandidate("edge-first", first.id, "provider-first", "provider-model-first", { code: "provider_binding_not_ready", providerId: "provider-first" }),
      previewRoutingCandidate("edge-second", second.id, "provider-second", "provider-model-second", null),
    ];
    const routing = {
      evaluateEntryRouting: vi.fn(async () => ({
        outcome: "available",
        evaluatedAt: "2026-08-22T00:00:00.000Z",
        entryAccessPoint: previewDiagnostic(entry),
        plan: {
          entryAccessPointId: entry.id,
          requestedModel: "model-a",
          selectorAccessPointId: entry.id,
          selectorId: "ordered-fallback",
          selectorBehaviorVersion: 1,
          selectorConfig: { maxAttempts: 2, retryOn: ["timeout"] },
          routingRevision: 1,
          candidates,
        },
        candidates,
        selectedCandidateId: "ap-entry:edge-second",
        accessPoints: [previewDiagnostic(entry), previewDiagnostic(first), previewDiagnostic(second)],
        providers: [
          { id: "provider-first", scopeRef: "team:provider-first", name: "First", status: "enabled", bindingStatus: "pending" },
          { id: "provider-second", scopeRef: "team:provider-second", name: "Second", status: "enabled", bindingStatus: "ready" },
        ],
        providerModels: [],
        work: { visitedNodes: 3, visitedEdges: 4, decodedConfigBytes: 6, evaluatedCandidates: 2 },
      })),
    };
    const targets = new Map<string, Array<{
      id: string;
      targetType: string;
      targetAccessPointId: string | null;
      targetProviderId: string | null;
      targetProviderModelName: string | null;
    }>>([
      [entry.id, [
        { id: "edge-first", targetType: "access-point", targetAccessPointId: first.id, targetProviderId: null, targetProviderModelName: null },
        { id: "edge-second", targetType: "access-point", targetAccessPointId: second.id, targetProviderId: null, targetProviderModelName: null },
      ]],
      [second.id, [{ id: "provider-edge-second", targetType: "provider-model", targetAccessPointId: null, targetProviderId: "provider-second", targetProviderModelName: "model-a" }]],
    ]);
    const service = new AsyncAccessResolutionService({
      async findFirstOrderedPlanSourceForUser() { throw new Error("explicit AccessPoint preview must not select a Plan source"); },
      async pageOrderedPlanSourcesForUser() { return { items: [], nextCursor: null }; },
      async listAccessPointTargets(accessPointId: string) { return targets.get(accessPointId) ?? []; },
      async listAccessPointTargetsByIds(accessPointIds: string[]) { return accessPointIds.flatMap((accessPointId) => targets.get(accessPointId) ?? []); },
      async getAccessPoint(accessPointId: string) { return accessPoints.get(accessPointId); },
      async getAccessPoints(accessPointIds: string[]) { return accessPointIds.map((accessPointId) => accessPoints.get(accessPointId)).filter((accessPoint): accessPoint is NonNullable<typeof accessPoint> => accessPoint !== undefined); },
      async listAccessPointsVisibleAtScope() { return [...accessPoints.values()]; },
      async getProvider(providerId: string) { return providers.get(providerId); },
      async getProviders(providerIds: string[]) { return providerIds.map((providerId) => providers.get(providerId)).filter((provider): provider is NonNullable<typeof provider> => provider !== undefined); },
    } as never, {
      async assertPreferredPartnerSourceActive() {},
      assertPartnerAccessActiveForScope: partnerAvailability,
      async assertPartnerAccessActiveForScopes(scopeRefs, at) {
        for (const scopeRef of scopeRefs) await partnerAvailability(scopeRef, at);
      },
      assertTeamProviderAccessActive: providerEntitlements,
      async assertProviderAccessActiveForProviders(providers, at) {
        for (const provider of providers) await providerEntitlements(provider.id, at, provider.scopeRef);
      },
    }, routing as never);

    const trace = await service.explain(
      { apiKey: { id: "key-a" }, user: { id: "user-a" }, effectiveScopes: ["team:entry"] } as never,
      "model-a",
      { accessPointId: entry.id, bypassVisibility: true, allowUnavailable: true },
    );

    expect(routing.evaluateEntryRouting).toHaveBeenCalledTimes(1);
    expect(providerEntitlements.mock.calls.map(([providerId, , scopeRef]) => [providerId, scopeRef])).toEqual([
      ["provider-first", "team:provider-first"],
      ["provider-second", "team:provider-second"],
    ]);
    expect(partnerAvailability).toHaveBeenCalledTimes(3);
    expect(trace.candidatePlan.candidates.map((candidate) => ({
      providerId: candidate.providerId,
      credentialRef: candidate.credentialRef,
      available: candidate.available,
      unavailableReason: candidate.unavailableReason,
    }))).toEqual([
      { providerId: "provider-first", credentialRef: "identity:first", available: false, unavailableReason: "provider_binding_not_ready" },
      { providerId: "provider-second", credentialRef: "identity:second", available: true, unavailableReason: null },
    ]);
    expect((trace as unknown as { unavailableReason: unknown }).unavailableReason).toBeNull();
    expect(trace.candidateAccessPoints.map((accessPoint) => accessPoint.id)).toEqual(["ap-entry", "ap-first", "ap-second"]);
    expect(JSON.stringify(trace)).not.toContain("providerModelId");
  });
});

function previewAccessPoint(id: string, scopeRef: string, selectorId: string) {
  return {
    id,
    name: id,
    description: null,
    apiFamily: "openai",
    status: "enabled",
    scopeRef,
    ownerId: "owner-a",
    exposedModel: "model-a",
    targetModel: "model-a",
    targetType: selectorId === "ordered-fallback" ? "access-point" : "provider-model",
    selectorId,
    selectorBehaviorVersion: 1,
    selectorConfigJson: selectorId === "ordered-fallback" ? '{"maxAttempts":2,"retryOn":["timeout"]}' : "{}",
    requestOverridesJson: "{}",
    routingRevision: 1,
  };
}

function previewDiagnostic(accessPoint: ReturnType<typeof previewAccessPoint>) {
  return {
    id: accessPoint.id,
    ownerId: accessPoint.ownerId,
    scopeRef: accessPoint.scopeRef,
    name: accessPoint.name,
    description: accessPoint.description,
    exposedModel: accessPoint.exposedModel,
    targetModel: accessPoint.targetModel,
    status: accessPoint.status,
    routingRevision: accessPoint.routingRevision,
  };
}

function previewRoutingCandidate(
  selectorTargetEdgeId: string,
  targetAccessPointId: string,
  providerId: string,
  providerModelId: string,
  unavailableReason: null | { code: "provider_binding_not_ready"; providerId: string },
) {
  return {
    candidateId: `ap-entry:${selectorTargetEdgeId}`,
    selectorTargetEdgeId,
    selectorPosition: selectorTargetEdgeId === "edge-first" ? 0 : 1,
    pathTargetEdgeIds: [selectorTargetEdgeId, `provider-${selectorTargetEdgeId}`],
    accessPointChainIds: ["ap-entry", targetAccessPointId],
    routingRevisions: [{ accessPointId: "ap-entry", routingRevision: 1 }, { accessPointId: targetAccessPointId, routingRevision: 1 }],
    providerId,
    providerModelId,
    providerModelName: "model-a",
    available: unavailableReason === null,
    unavailableReason,
  };
}
