import type { SelectorAttemptResult } from "@frely/core";
import {
  GraphCompilationBudget,
  type CompiledRoutingPlan,
  type EvaluatedRoutingCandidate,
  type GraphCompilationBudgetOptions,
  type GraphCompilationBudgetSnapshot,
} from "./routing-kernel.js";

export type {
  CompiledRoutingCandidate,
  CompiledRoutingPlan,
  CompiledRoutingRevisionExpectation,
  EvaluatedRoutingCandidate,
  GraphCompilationBudgetSnapshot,
  RoutingCandidateSelection,
  RoutingUnavailableReason,
} from "./routing-kernel.js";
export { selectNextRoutingCandidate } from "./routing-kernel.js";

export interface GatewayRoutingQueryInput {
  readonly entryAccessPointId: string;
  readonly requestedModel?: string;
  readonly attempts?: readonly Readonly<SelectorAttemptResult>[];
  readonly signal?: AbortSignal;
  readonly budget?: GraphCompilationBudget;
}

export interface GatewayRoutingAccessPointScopeReference {
  readonly id: string;
  readonly scopeRef: string;
  readonly routingRevision: number;
}

export interface GatewayRoutingProviderScopeReference {
  readonly id: string;
  readonly scopeRef: string;
}

export interface GatewayRoutingScopeReferences {
  readonly accessPoints: readonly Readonly<GatewayRoutingAccessPointScopeReference>[];
  readonly providers: readonly Readonly<GatewayRoutingProviderScopeReference>[];
}

export interface GatewayRoutingSnapshot {
  readonly outcome: "available" | "unavailable";
  readonly evaluatedAt: string;
  readonly plan: CompiledRoutingPlan;
  readonly candidates: readonly EvaluatedRoutingCandidate[];
  readonly selectedCandidateId: string | null;
  readonly selectedCandidate: EvaluatedRoutingCandidate | null;
  readonly scopeReferences: GatewayRoutingScopeReferences;
  readonly work: GraphCompilationBudgetSnapshot;
}

export interface GatewayRoutingQueryPort {
  evaluateGatewayRouting(input: GatewayRoutingQueryInput): Promise<GatewayRoutingSnapshot>;
}

export function createGatewayRoutingBudget(
  signal?: AbortSignal,
  options: Partial<Pick<GraphCompilationBudgetOptions, "maxVisitedNodes" | "maxVisitedEdges" | "maxDecodedConfigBytes" | "maxEvaluationCandidates" | "deadlineAtMs" | "now">> = {},
): GraphCompilationBudget {
  return new GraphCompilationBudget({
    maxVisitedNodes: options.maxVisitedNodes ?? 512,
    maxVisitedEdges: options.maxVisitedEdges ?? 2_048,
    maxDecodedConfigBytes: options.maxDecodedConfigBytes ?? 1_048_576,
    maxEvaluationCandidates: options.maxEvaluationCandidates ?? 256,
    ...(options.deadlineAtMs !== undefined ? { deadlineAtMs: options.deadlineAtMs } : {}),
    ...(signal ? { signal } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
