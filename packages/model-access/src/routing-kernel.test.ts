import { RelayError, type SelectorAttemptResult } from "@frely/core";
import { describe, expect, it } from "vitest";
import {
  GraphCompilationBudget,
  compileRoutingPlan,
  evaluateRouting,
  type RoutingAvailabilitySnapshot,
  type RoutingGraphAccessPoint,
  type RoutingGraphProviderModel,
  type RoutingGraphSnapshot,
  type RoutingGraphTarget,
} from "./routing-kernel.js";

describe("RoutingCompilationKernel", () => {
  it("accepts deep acyclic chains while enforcing the graph work budget", () => {
    const accessPoints = linearAccessPoints(40);
    const graph = snapshot(accessPoints, [providerModel("provider_model_a", "provider_a", "model-a")]);
    const budget = compilationBudget({ maxVisitedNodes: 64, maxVisitedEdges: 64 });

    const plan = compileRoutingPlan({ entryAccessPointId: "ap_0", requestedModel: "model-a", graph }, budget);

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      providerId: "provider_a",
      providerModelId: "provider_model_a",
      providerModelName: "model-a",
    });
    expect(plan.candidates[0]!.accessPointChainIds).toHaveLength(40);
    expect(plan.candidates[0]!.routingRevisions.at(-1)).toEqual({ accessPointId: "ap_39", routingRevision: 40 });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.candidates[0]!.routingRevisions)).toBe(true);

    const evaluated = evaluateRouting(plan, { availability: availability(
      [...accessPoints.keys()],
      ["provider_a"],
      ["provider_model_a"],
      ["provider_a"],
    ) }, budget);
    expect(evaluated.selectedCandidate?.providerModelId).toBe("provider_model_a");
    expect(budget.snapshot()).toMatchObject({ visitedNodes: 40, visitedEdges: 40, evaluatedCandidates: 1 });

    expect(() => compileRoutingPlan({
      entryAccessPointId: "ap_0",
      requestedModel: "model-a",
      graph: snapshot(linearAccessPoints(65), [providerModel("provider_model_a", "provider_a", "model-a")]),
    }, compilationBudget({ maxVisitedNodes: 64, maxVisitedEdges: 64 }))).toThrowError(
      expect.objectContaining({ code: "graph_compilation_capacity_exceeded", status: 503 }),
    );
  });

  it("accepts exactly 200 AccessPoint hops and stably rejects the 201st", () => {
    const provider = providerModel("provider_model_a", "provider_a", "model-a");
    const atLimit = compileRoutingPlan({
      entryAccessPointId: "ap_0",
      requestedModel: "model-a",
      graph: snapshot(linearAccessPoints(201), [provider]),
    }, compilationBudget({ maxVisitedNodes: 256, maxVisitedEdges: 256 }));

    expect(atLimit.candidates[0]!.accessPointChainIds).toHaveLength(201);
    expect(() => compileRoutingPlan({
      entryAccessPointId: "ap_0",
      requestedModel: "model-a",
      graph: snapshot(linearAccessPoints(202), [provider]),
    }, compilationBudget({ maxVisitedNodes: 256, maxVisitedEdges: 256 }))).toThrowError(
      expect.objectContaining({ code: "access_point_depth_exceeded", status: 400 }),
    );
  });

  it("evaluates ordered fallback from current effective availability and attempt facts", () => {
    const entry: RoutingGraphAccessPoint = {
      ...directAccessPoint("entry", providerTarget("edge_a", "provider_model_a", "provider_a", "model-a"), 7),
      routingRuleId: "ordered-fallback",
      routingRuleConfigJson: '{"maxAttempts":2,"retryOn":["timeout"]}',
      targets: [
        providerTarget("edge_a", "provider_model_a", "provider_a", "model-a", 0),
        providerTarget("edge_b", "provider_model_b", "provider_b", "model-a", 1),
      ],
    };
    const graph = snapshot(new Map([[entry.id, entry]]), [
      providerModel("provider_model_a", "provider_a", "model-a"),
      providerModel("provider_model_b", "provider_b", "model-a"),
    ]);
    const budget = compilationBudget({ maxEvaluationCandidates: 6 });
    const plan = compileRoutingPlan({ entryAccessPointId: "entry", requestedModel: "model-a", graph }, budget);

    const firstUnavailable = availability(["entry"], ["provider_a", "provider_b"], ["provider_model_a", "provider_model_b"], ["provider_b"]);
    const degraded = evaluateRouting(plan, { availability: firstUnavailable }, budget);
    expect(degraded.selectedCandidate?.providerModelId).toBe("provider_model_b");
    expect(degraded.candidates[0]!.unavailableReason).toEqual({ code: "provider_binding_not_ready", providerId: "provider_a" });

    const recovered = availability(["entry"], ["provider_a", "provider_b"], ["provider_model_a", "provider_model_b"], ["provider_a", "provider_b"]);
    expect(evaluateRouting(plan, { availability: recovered }, budget).selectedCandidate?.providerModelId).toBe("provider_model_a");

    const attempt: SelectorAttemptResult = {
      candidateId: "entry:edge_a",
      targetEdgeId: "edge_a",
      attemptIndex: 0,
      outcome: "failed",
      failureClass: "timeout",
      outputCommitted: false,
      durationMs: 50,
    };
    expect(evaluateRouting(plan, { availability: recovered, attempts: [attempt] }, budget).selectedCandidate?.providerModelId)
      .toBe("provider_model_b");
  });

  it("fails closed for cycles, stable-reference mismatches, and platform capacity exhaustion", () => {
    const cyclic = new Map<string, RoutingGraphAccessPoint>([
      ["ap_a", directAccessPoint("ap_a", accessPointTarget("edge_a", "ap_b"))],
      ["ap_b", directAccessPoint("ap_b", accessPointTarget("edge_b", "ap_a"))],
    ]);
    expectRelayError(
      () => compileRoutingPlan({ entryAccessPointId: "ap_a", requestedModel: "model-a", graph: snapshot(cyclic, []) }, compilationBudget()),
      "access_point_cycle",
      400,
    );

    const mismatched = new Map<string, RoutingGraphAccessPoint>([[
      "entry",
      directAccessPoint("entry", providerTarget("edge", "provider_model_a", "wrong_provider", "model-a")),
    ]]);
    expectRelayError(
      () => compileRoutingPlan({
        entryAccessPointId: "entry",
        requestedModel: "model-a",
        graph: snapshot(mismatched, [providerModel("provider_model_a", "provider_a", "model-a")]),
      }, compilationBudget()),
      "provider_model_reference_mismatch",
      500,
    );

    const bounded = new Map<string, RoutingGraphAccessPoint>([
      ["ap_a", directAccessPoint("ap_a", accessPointTarget("edge_a", "ap_b"))],
      ["ap_b", directAccessPoint("ap_b", providerTarget("edge_b", "provider_model_a", "provider_a", "model-a"))],
    ]);
    expectRelayError(
      () => compileRoutingPlan({
        entryAccessPointId: "ap_a",
        requestedModel: "model-a",
        graph: snapshot(bounded, [providerModel("provider_model_a", "provider_a", "model-a")]),
      }, compilationBudget({ maxVisitedNodes: 1 })),
      "graph_compilation_capacity_exceeded",
      503,
    );
  });
});

function linearAccessPoints(accessPointCount: number): Map<string, RoutingGraphAccessPoint> {
  const accessPoints = new Map<string, RoutingGraphAccessPoint>();
  for (let index = 0; index < accessPointCount; index += 1) {
    const id = `ap_${index}`;
    accessPoints.set(id, directAccessPoint(
      id,
      index === accessPointCount - 1
        ? providerTarget(`edge_${index}`, "provider_model_a", "provider_a", "model-a")
        : accessPointTarget(`edge_${index}`, `ap_${index + 1}`),
      index + 1,
    ));
  }
  return accessPoints;
}

function directAccessPoint(id: string, target: RoutingGraphTarget, routingRevision = 1): RoutingGraphAccessPoint {
  return {
    id,
    exposedModel: "model-a",
    targetModel: "model-a",
    routingRuleId: "direct",
    routingRuleBehaviorVersion: 1,
    routingRuleConfigJson: "{}",
    routingRevision,
    removedAt: null,
    targets: [target],
  };
}

function accessPointTarget(id: string, targetAccessPointId: string): RoutingGraphTarget {
  return {
    id,
    type: "access-point",
    targetAccessPointId,
    targetProviderModelId: null,
    position: 0,
    status: "enabled",
    removedAt: null,
  };
}

function providerTarget(
  id: string,
  targetProviderModelId: string,
  targetProviderId: string,
  targetProviderModelName: string,
  position = 0,
): RoutingGraphTarget {
  return {
    id,
    type: "provider-model",
    targetAccessPointId: null,
    targetProviderModelId,
    targetProviderId,
    targetProviderModelName,
    position,
    status: "enabled",
    removedAt: null,
  };
}

function providerModel(id: string, providerId: string, providerModelName: string): RoutingGraphProviderModel {
  return { id, providerId, providerModelName };
}

function snapshot(
  accessPoints: ReadonlyMap<string, RoutingGraphAccessPoint>,
  providerModels: readonly RoutingGraphProviderModel[],
): RoutingGraphSnapshot {
  return { accessPoints, providerModels: new Map(providerModels.map((model) => [model.id, model])) };
}

function availability(
  accessPointIds: readonly string[],
  providerIds: readonly string[],
  providerModelIds: readonly string[],
  readyProviderIds: readonly string[],
): RoutingAvailabilitySnapshot {
  return {
    accessPointStatuses: new Map(accessPointIds.map((id) => [id, "enabled"])),
    providerStatuses: new Map(providerIds.map((id) => [id, "enabled"])),
    providerModelStatuses: new Map(providerModelIds.map((id) => [id, "enabled"])),
    providerBindingStatuses: new Map(readyProviderIds.map((id) => [id, "ready"])),
  };
}

function compilationBudget(overrides: Partial<ConstructorParameters<typeof GraphCompilationBudget>[0]> = {}): GraphCompilationBudget {
  return new GraphCompilationBudget({
    maxVisitedNodes: 64,
    maxVisitedEdges: 64,
    maxDecodedConfigBytes: 8_192,
    maxEvaluationCandidates: 16,
    ...overrides,
  });
}

function expectRelayError(callback: () => unknown, code: string, status: number): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    expect(error).toMatchObject({ code, status });
    return;
  }
  throw new Error(`Expected RelayError ${code}`);
}
