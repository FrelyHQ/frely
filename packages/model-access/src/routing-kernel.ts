import {
  getAccessPointSelector,
  RelayError,
  type AccessPointSelectorConfig,
  type SelectorAttemptResult,
  type SelectorCandidate,
} from "@frely/core";

export const MAX_ACCESS_POINT_TO_ACCESS_POINT_HOPS = 200;

export interface RoutingGraphTarget {
  readonly id: string;
  readonly type: "provider-model" | "access-point";
  readonly targetAccessPointId: string | null;
  readonly targetProviderModelId: string | null;
  readonly targetProviderId?: string | null;
  readonly targetProviderModelName?: string | null;
  readonly position: number;
  readonly status: string;
  readonly removedAt?: string | null;
}

export interface RoutingGraphAccessPoint {
  readonly id: string;
  readonly exposedModel: string;
  readonly targetModel: string;
  readonly routingRuleId: string;
  readonly routingRuleBehaviorVersion: number;
  readonly routingRuleConfigJson: string;
  readonly routingRevision: number;
  readonly removedAt?: string | null;
  readonly targets: readonly RoutingGraphTarget[];
}

export interface RoutingGraphProviderModel {
  readonly id: string;
  readonly providerId: string;
  readonly providerModelName: string;
}

export interface RoutingGraphSnapshot {
  readonly accessPoints: ReadonlyMap<string, Readonly<RoutingGraphAccessPoint>>;
  readonly providerModels: ReadonlyMap<string, Readonly<RoutingGraphProviderModel>>;
}

export interface CompiledRoutingRevisionExpectation {
  readonly accessPointId: string;
  readonly routingRevision: number;
}

export interface CompiledRoutingCandidate {
  readonly candidateId: string;
  readonly selectorTargetEdgeId: string;
  readonly selectorPosition: number;
  readonly pathTargetEdgeIds: readonly string[];
  readonly accessPointChainIds: readonly string[];
  readonly routingRevisions: readonly CompiledRoutingRevisionExpectation[];
  readonly providerId: string;
  readonly providerModelId: string;
  readonly providerModelName: string;
}

export interface CompiledRoutingPlan {
  readonly entryAccessPointId: string;
  readonly requestedModel: string;
  readonly selectorAccessPointId: string;
  readonly selectorId: string;
  readonly selectorBehaviorVersion: number;
  readonly selectorConfig: Readonly<AccessPointSelectorConfig>;
  readonly routingRevision: number;
  readonly candidates: readonly CompiledRoutingCandidate[];
}

export interface CompileRoutingPlanInput {
  readonly entryAccessPointId: string;
  readonly requestedModel: string;
  readonly graph: RoutingGraphSnapshot;
}

export interface GraphCompilationBudgetOptions {
  readonly maxVisitedNodes: number;
  readonly maxVisitedEdges: number;
  readonly maxDecodedConfigBytes: number;
  readonly maxEvaluationCandidates: number;
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface GraphCompilationBudgetSnapshot {
  readonly visitedNodes: number;
  readonly visitedEdges: number;
  readonly decodedConfigBytes: number;
  readonly evaluatedCandidates: number;
}

export class GraphCompilationBudget {
  readonly #options: GraphCompilationBudgetOptions;
  readonly #visitedNodeIds = new Set<string>();
  readonly #visitedEdgeIds = new Set<string>();
  #decodedConfigBytes = 0;
  #evaluatedCandidates = 0;

  constructor(options: GraphCompilationBudgetOptions) {
    for (const [name, value] of Object.entries({
      maxVisitedNodes: options.maxVisitedNodes,
      maxVisitedEdges: options.maxVisitedEdges,
      maxDecodedConfigBytes: options.maxDecodedConfigBytes,
      maxEvaluationCandidates: options.maxEvaluationCandidates,
    })) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RelayError("graph_compilation_budget_invalid", `${name} must be a non-negative safe integer`, 500);
      }
    }
    if (options.deadlineAtMs !== undefined && !Number.isFinite(options.deadlineAtMs)) {
      throw new RelayError("graph_compilation_budget_invalid", "deadlineAtMs must be finite", 500);
    }
    this.#options = Object.freeze({ ...options });
  }

  checkpoint(): void {
    if (this.#options.signal?.aborted) {
      throw new RelayError("request_aborted", "The request was aborted", 499);
    }
    if (this.#options.deadlineAtMs !== undefined && (this.#options.now ?? Date.now)() >= this.#options.deadlineAtMs) {
      throw capacityExceeded("deadline", this.#options.deadlineAtMs, this.#options.deadlineAtMs);
    }
  }

  visitNode(accessPointId: string, decodedConfigBytes: number): void {
    this.checkpoint();
    if (this.#visitedNodeIds.has(accessPointId)) return;
    if (!Number.isSafeInteger(decodedConfigBytes) || decodedConfigBytes < 0) {
      throw new RelayError("routing_graph_snapshot_invalid", "Routing config byte size is invalid", 500);
    }
    this.#visitedNodeIds.add(accessPointId);
    this.#decodedConfigBytes += decodedConfigBytes;
    this.assertWithin("visited_nodes", this.#visitedNodeIds.size, this.#options.maxVisitedNodes);
    this.assertWithin("decoded_config_bytes", this.#decodedConfigBytes, this.#options.maxDecodedConfigBytes);
  }

  visitEdge(edgeId: string): void {
    this.checkpoint();
    if (this.#visitedEdgeIds.has(edgeId)) return;
    this.#visitedEdgeIds.add(edgeId);
    this.assertWithin("visited_edges", this.#visitedEdgeIds.size, this.#options.maxVisitedEdges);
  }

  evaluateCandidate(): void {
    this.checkpoint();
    this.#evaluatedCandidates += 1;
    this.assertWithin("evaluation_candidates", this.#evaluatedCandidates, this.#options.maxEvaluationCandidates);
  }

  snapshot(): GraphCompilationBudgetSnapshot {
    return Object.freeze({
      visitedNodes: this.#visitedNodeIds.size,
      visitedEdges: this.#visitedEdgeIds.size,
      decodedConfigBytes: this.#decodedConfigBytes,
      evaluatedCandidates: this.#evaluatedCandidates,
    });
  }

  private assertWithin(dimension: string, consumed: number, limit: number): void {
    if (consumed > limit) throw capacityExceeded(dimension, consumed, limit);
  }
}

export interface RoutingAvailabilitySnapshot {
  readonly accessPointStatuses: ReadonlyMap<string, string>;
  readonly providerStatuses: ReadonlyMap<string, string>;
  readonly providerModelStatuses: ReadonlyMap<string, string>;
  readonly providerBindingStatuses: ReadonlyMap<string, string>;
}

export type RoutingUnavailableReason =
  | Readonly<{ code: "access_point_disabled"; accessPointId: string }>
  | Readonly<{ code: "provider_disabled"; providerId: string }>
  | Readonly<{ code: "provider_model_disabled"; providerModelId: string }>
  | Readonly<{ code: "provider_binding_not_ready"; providerId: string }>;

export interface EvaluatedRoutingCandidate extends CompiledRoutingCandidate {
  readonly available: boolean;
  readonly unavailableReason: RoutingUnavailableReason | null;
}

export interface EvaluatedRoutingPlan {
  readonly plan: CompiledRoutingPlan;
  readonly candidates: readonly EvaluatedRoutingCandidate[];
  readonly selectedCandidateId: string | null;
  readonly selectedCandidate: EvaluatedRoutingCandidate | null;
}

export interface EvaluateRoutingInput {
  readonly availability: RoutingAvailabilitySnapshot;
  readonly attempts?: readonly Readonly<SelectorAttemptResult>[];
}

export interface RoutingCandidateSelection {
  readonly selectedCandidateId: string | null;
  readonly selectedCandidate: EvaluatedRoutingCandidate | null;
}

interface CompiledRule {
  readonly config: Readonly<AccessPointSelectorConfig>;
  readonly targets: readonly RoutingGraphTarget[];
}

interface SelectorPath {
  readonly selector: RoutingGraphAccessPoint;
  readonly accessPointChain: readonly RoutingGraphAccessPoint[];
  readonly targetEdgeIds: readonly string[];
  readonly rule: CompiledRule;
}

export function compileRoutingPlan(input: CompileRoutingPlanInput, budget: GraphCompilationBudget): CompiledRoutingPlan {
  budget.checkpoint();
  const entry = requireAccessPoint(input.graph, input.entryAccessPointId);
  if (entry.exposedModel !== input.requestedModel) {
    throw new RelayError("access_point_requested_model_mismatch", `AccessPoint ${entry.id} does not expose requested model ${input.requestedModel}`, 400);
  }
  const selectorPath = findSelector(input.graph, entry, budget);
  const candidates = selectorPath.rule.targets.map((target) => compileCandidate(input.graph, selectorPath, target, budget));
  return Object.freeze({
    entryAccessPointId: entry.id,
    requestedModel: input.requestedModel,
    selectorAccessPointId: selectorPath.selector.id,
    selectorId: selectorPath.selector.routingRuleId,
    selectorBehaviorVersion: selectorPath.selector.routingRuleBehaviorVersion,
    selectorConfig: selectorPath.rule.config,
    routingRevision: selectorPath.selector.routingRevision,
    candidates: Object.freeze(candidates),
  });
}

export function evaluateRouting(plan: CompiledRoutingPlan, input: EvaluateRoutingInput, budget: GraphCompilationBudget): EvaluatedRoutingPlan {
  budget.checkpoint();
  const candidates = plan.candidates.map((candidate): EvaluatedRoutingCandidate => {
    budget.evaluateCandidate();
    const unavailableReason = candidateUnavailableReason(candidate, input.availability);
    return Object.freeze({ ...candidate, available: unavailableReason === null, unavailableReason });
  });
  const selection = selectNextRoutingCandidate(plan, candidates, input.attempts ?? []);
  return Object.freeze({ plan, candidates: Object.freeze(candidates), ...selection });
}

export function selectNextRoutingCandidate(
  plan: CompiledRoutingPlan,
  candidates: readonly EvaluatedRoutingCandidate[],
  attempts: readonly Readonly<SelectorAttemptResult>[],
): RoutingCandidateSelection {
  validateEvaluatedCandidates(plan, candidates);
  validateAttemptFacts(candidates, attempts);
  const selectorCandidates: SelectorCandidate[] = candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    targetEdgeId: candidate.selectorTargetEdgeId,
    position: candidate.selectorPosition,
    available: candidate.available,
  }));
  let selectedCandidateId: string | null;
  try {
    selectedCandidateId = getAccessPointSelector(plan.selectorId, plan.selectorBehaviorVersion)
      .decide(selectorCandidates, attempts, plan.selectorConfig);
  } catch (error) {
    throw new RelayError("invalid_access_point_selector_decision", error instanceof Error ? error.message : "RoutingRule evaluation failed", 500);
  }
  if (selectedCandidateId !== null && !candidates.some((candidate) => candidate.candidateId === selectedCandidateId)) {
    throw new RelayError("invalid_access_point_selector_decision", "RoutingRule selected an unknown candidate", 500);
  }
  const selectedCandidate = candidates.find((candidate) => candidate.candidateId === selectedCandidateId) ?? null;
  return Object.freeze({ selectedCandidateId, selectedCandidate });
}

function findSelector(graph: RoutingGraphSnapshot, entry: RoutingGraphAccessPoint, budget: GraphCompilationBudget): SelectorPath {
  const accessPointChain: RoutingGraphAccessPoint[] = [];
  const targetEdgeIds: string[] = [];
  const visited = new Set<string>();
  let current = entry;
  while (true) {
    budget.checkpoint();
    if (visited.has(current.id)) throw routingCycle(current.id);
    visited.add(current.id);
    accessPointChain.push(current);
    const rule = compileRule(current, budget);
    if (current.routingRuleId === "ordered-fallback") return { selector: current, accessPointChain, targetEdgeIds, rule };
    const target = rule.targets[0]!;
    if (target.type === "provider-model") return { selector: current, accessPointChain, targetEdgeIds, rule };
    assertAccessPointHopAvailable(accessPointChain.length - 1);
    const downstream = requireTargetAccessPoint(graph, current, target);
    targetEdgeIds.push(target.id);
    current = downstream;
  }
}

function compileCandidate(
  graph: RoutingGraphSnapshot,
  selectorPath: SelectorPath,
  selectorTarget: RoutingGraphTarget,
  budget: GraphCompilationBudget,
): CompiledRoutingCandidate {
  const accessPointChain = [...selectorPath.accessPointChain];
  const pathTargetEdgeIds = [...selectorPath.targetEdgeIds];
  const visited = new Set(accessPointChain.map((accessPoint) => accessPoint.id));
  let current = selectorPath.selector;
  let target = selectorTarget;
  while (true) {
    budget.checkpoint();
    pathTargetEdgeIds.push(target.id);
    if (target.type === "access-point") {
      assertAccessPointHopAvailable(accessPointChain.length - 1);
      const downstream = requireTargetAccessPoint(graph, current, target);
      if (visited.has(downstream.id)) throw routingCycle(downstream.id);
      visited.add(downstream.id);
      accessPointChain.push(downstream);
      const downstreamRule = compileRule(downstream, budget);
      if (downstream.routingRuleId === "ordered-fallback") {
        throw new RelayError("access_point_ordered_selector_nested", "Each AccessPoint path may contain at most one ordered-fallback@1 rule", 400);
      }
      current = downstream;
      target = downstreamRule.targets[0]!;
      continue;
    }
    const providerModel = requireProviderModel(graph, current, target);
    return Object.freeze({
      candidateId: `${selectorPath.selector.id}:${selectorTarget.id}`,
      selectorTargetEdgeId: selectorTarget.id,
      selectorPosition: selectorTarget.position,
      pathTargetEdgeIds: Object.freeze(pathTargetEdgeIds),
      accessPointChainIds: Object.freeze(accessPointChain.map((accessPoint) => accessPoint.id)),
      routingRevisions: Object.freeze(accessPointChain.map((accessPoint) => Object.freeze({
        accessPointId: accessPoint.id,
        routingRevision: accessPoint.routingRevision,
      }))),
      providerId: providerModel.providerId,
      providerModelId: providerModel.id,
      providerModelName: providerModel.providerModelName,
    });
  }
}

function compileRule(accessPoint: RoutingGraphAccessPoint, budget: GraphCompilationBudget): CompiledRule {
  if (accessPoint.removedAt) throw new RelayError("access_point_target_not_found", `AccessPoint ${accessPoint.id} is removed`, 404);
  budget.visitNode(accessPoint.id, new TextEncoder().encode(accessPoint.routingRuleConfigJson).byteLength);
  const targets = accessPoint.targets
    .filter((target) => target.status === "enabled" && !target.removedAt)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  const positions = new Set<number>();
  for (const target of targets) {
    budget.visitEdge(target.id);
    if (!Number.isSafeInteger(target.position) || target.position < 0 || positions.has(target.position)) {
      throw new RelayError("invalid_access_point_routing", `AccessPoint ${accessPoint.id} has invalid enabled target positions`, 500);
    }
    positions.add(target.position);
    validateTargetShape(target);
  }
  let configInput: unknown;
  try {
    configInput = JSON.parse(accessPoint.routingRuleConfigJson) as unknown;
  } catch {
    throw new RelayError("invalid_access_point_routing_rule", `AccessPoint ${accessPoint.id} has invalid routing config JSON`, 500);
  }
  try {
    const selector = getAccessPointSelector(accessPoint.routingRuleId, accessPoint.routingRuleBehaviorVersion);
    return { config: selector.normalizeConfig(configInput, targets.length), targets: Object.freeze(targets) };
  } catch (error) {
    throw new RelayError("invalid_access_point_routing_rule", error instanceof Error ? error.message : `AccessPoint ${accessPoint.id} has an invalid RoutingRule`, 500);
  }
}

function requireAccessPoint(graph: RoutingGraphSnapshot, id: string): RoutingGraphAccessPoint {
  const accessPoint = graph.accessPoints.get(id);
  if (!accessPoint || accessPoint.removedAt) throw new RelayError("access_point_target_not_found", `AccessPoint ${id} not found`, 404);
  return accessPoint;
}

function requireTargetAccessPoint(graph: RoutingGraphSnapshot, source: RoutingGraphAccessPoint, target: RoutingGraphTarget): RoutingGraphAccessPoint {
  if (!target.targetAccessPointId) {
    throw new RelayError("access_point_target_not_found", `AccessPoint target ${target.id} is missing its stable reference`, 404);
  }
  const downstream = requireAccessPoint(graph, target.targetAccessPointId);
  if (downstream.exposedModel !== source.targetModel) {
    throw new RelayError("access_point_target_model_not_allowed", `Target AccessPoint ${downstream.id} does not expose targetModel ${source.targetModel}`, 400);
  }
  return downstream;
}

function requireProviderModel(graph: RoutingGraphSnapshot, source: RoutingGraphAccessPoint, target: RoutingGraphTarget): RoutingGraphProviderModel {
  if (!target.targetProviderModelId) {
    throw new RelayError("provider_model_stable_reference_missing", `Provider-model target ${target.id} is missing ProviderModelId`, 500);
  }
  const providerModel = graph.providerModels.get(target.targetProviderModelId);
  if (!providerModel) throw new RelayError("provider_model_not_found", `ProviderModel ${target.targetProviderModelId} not found`, 404);
  if (
    providerModel.providerModelName !== source.targetModel
    || (target.targetProviderId !== undefined && target.targetProviderId !== null && target.targetProviderId !== providerModel.providerId)
    || (target.targetProviderModelName !== undefined && target.targetProviderModelName !== null && target.targetProviderModelName !== providerModel.providerModelName)
  ) {
    throw new RelayError("provider_model_reference_mismatch", `Provider-model target ${target.id} does not match its stable ProviderModel reference`, 500);
  }
  return providerModel;
}

function validateTargetShape(target: RoutingGraphTarget): void {
  if (target.type === "access-point") {
    if (!target.targetAccessPointId || target.targetProviderModelId !== null) {
      throw new RelayError("invalid_access_point_routing", `AccessPoint target ${target.id} has an invalid reference shape`, 500);
    }
    return;
  }
  if (target.type !== "provider-model" || target.targetAccessPointId !== null || !target.targetProviderModelId) {
    throw new RelayError("invalid_access_point_routing", `Provider-model target ${target.id} has an invalid reference shape`, 500);
  }
}

function candidateUnavailableReason(candidate: CompiledRoutingCandidate, availability: RoutingAvailabilitySnapshot): RoutingUnavailableReason | null {
  for (const accessPointId of candidate.accessPointChainIds) {
    if (requiredAvailability(availability.accessPointStatuses, accessPointId, "AccessPoint") !== "enabled") {
      return Object.freeze({ code: "access_point_disabled", accessPointId });
    }
  }
  if (requiredAvailability(availability.providerStatuses, candidate.providerId, "Provider") !== "enabled") {
    return Object.freeze({ code: "provider_disabled", providerId: candidate.providerId });
  }
  if (requiredAvailability(availability.providerModelStatuses, candidate.providerModelId, "ProviderModel") !== "enabled") {
    return Object.freeze({ code: "provider_model_disabled", providerModelId: candidate.providerModelId });
  }
  if (availability.providerBindingStatuses.get(candidate.providerId) !== "ready") {
    return Object.freeze({ code: "provider_binding_not_ready", providerId: candidate.providerId });
  }
  return null;
}

function requiredAvailability(statuses: ReadonlyMap<string, string>, id: string, type: string): string {
  const status = statuses.get(id);
  if (status === undefined) {
    throw new RelayError("routing_availability_snapshot_incomplete", `${type} ${id} is missing from the routing availability snapshot`, 500);
  }
  return status;
}

function validateAttemptFacts(candidates: readonly EvaluatedRoutingCandidate[], attempts: readonly Readonly<SelectorAttemptResult>[]): void {
  const byCandidateId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const [index, attempt] of attempts.entries()) {
    const candidate = byCandidateId.get(attempt.candidateId);
    if (!candidate || candidate.selectorTargetEdgeId !== attempt.targetEdgeId || attempt.attemptIndex !== index) {
      throw new RelayError("routing_attempt_facts_invalid", "Routing attempt facts do not match the compiled plan", 500);
    }
  }
}

function validateEvaluatedCandidates(plan: CompiledRoutingPlan, candidates: readonly EvaluatedRoutingCandidate[]): void {
  if (plan.candidates.length !== candidates.length) {
    throw new RelayError("routing_evaluated_candidates_invalid", "Evaluated routing candidates do not match the compiled plan", 500);
  }
  for (const [index, candidate] of candidates.entries()) {
    const compiled = plan.candidates[index];
    if (
      !compiled
      || candidate.candidateId !== compiled.candidateId
      || candidate.selectorTargetEdgeId !== compiled.selectorTargetEdgeId
      || candidate.selectorPosition !== compiled.selectorPosition
      || candidate.providerId !== compiled.providerId
      || candidate.providerModelId !== compiled.providerModelId
      || candidate.providerModelName !== compiled.providerModelName
      || !sameStrings(candidate.pathTargetEdgeIds, compiled.pathTargetEdgeIds)
      || !sameStrings(candidate.accessPointChainIds, compiled.accessPointChainIds)
      || !sameRoutingRevisions(candidate.routingRevisions, compiled.routingRevisions)
    ) {
      throw new RelayError("routing_evaluated_candidates_invalid", "Evaluated routing candidates do not match the compiled plan", 500);
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRoutingRevisions(
  left: readonly CompiledRoutingRevisionExpectation[],
  right: readonly CompiledRoutingRevisionExpectation[],
): boolean {
  return left.length === right.length && left.every((value, index) => (
    value.accessPointId === right[index]?.accessPointId
    && value.routingRevision === right[index]?.routingRevision
  ));
}

function routingCycle(accessPointId: string): RelayError {
  return new RelayError("access_point_cycle", `AccessPoint cycle detected at ${accessPointId}`, 400);
}

function assertAccessPointHopAvailable(currentHopCount: number): void {
  if (currentHopCount >= MAX_ACCESS_POINT_TO_ACCESS_POINT_HOPS) {
    throw new RelayError(
      "access_point_depth_exceeded",
      `AccessPoint routing exceeds the ${MAX_ACCESS_POINT_TO_ACCESS_POINT_HOPS}-hop limit`,
      400,
      { maxHops: MAX_ACCESS_POINT_TO_ACCESS_POINT_HOPS },
    );
  }
}

function capacityExceeded(dimension: string, consumed: number, limit: number): RelayError {
  return new RelayError("graph_compilation_capacity_exceeded", "Routing graph work exceeded platform capacity", 503, { dimension, consumed, limit });
}
