import { RelayError } from "@frely/core";
import { Prisma, type PrismaTransactionOwner } from "@frely/postgres/server";
import {
  GraphCompilationBudget,
  MAX_ACCESS_POINT_TO_ACCESS_POINT_HOPS,
  compileRoutingPlan,
  evaluateRouting,
  type RoutingAvailabilitySnapshot,
  type RoutingGraphAccessPoint,
  type RoutingGraphProviderModel,
  type RoutingGraphSnapshot,
} from "./routing-kernel.js";
import {
  createGatewayRoutingBudget,
  type GatewayRoutingQueryInput,
  type GatewayRoutingQueryPort,
  type GatewayRoutingSnapshot,
} from "./routing-runtime.js";
import type {
  RoutingAccessPointDiagnostic,
  RoutingDiagnosticReport,
  RoutingProviderDiagnostic,
  RoutingProviderModelDiagnostic,
} from "./public-contracts.js";

export type {
  RoutingAccessPointDiagnostic,
  RoutingDiagnosticReport,
  RoutingProviderDiagnostic,
  RoutingProviderModelDiagnostic,
} from "./public-contracts.js";

interface LoadedRoutingGraph {
  readonly graph: RoutingGraphSnapshot;
  readonly availability: RoutingAvailabilitySnapshot;
  readonly accessPoints: readonly RoutingAccessPointDiagnostic[];
  readonly providers: readonly RoutingProviderDiagnostic[];
  readonly providerModels: readonly RoutingProviderModelDiagnostic[];
}

interface RoutingAccessPointSqlRow {
  accessPointId: string;
  ownerId: string;
  scopeRef: string;
  name: string;
  description: string | null;
  exposedModel: string;
  targetModel: string;
  routingRuleId: string;
  routingRuleBehaviorVersion: number;
  routingRuleConfigJson: string;
  routingRevision: number;
  status: string;
  removedAt: string | null;
  targetId: string | null;
  targetType: string | null;
  targetAccessPointId: string | null;
  targetProviderId: string | null;
  targetProviderModelName: string | null;
  targetProviderModelId: string | null;
  targetPosition: number | null;
  targetStatus: string | null;
  targetRemovedAt: string | null;
}

interface RoutingProviderModelSqlRow {
  id: string;
  providerId: string;
  providerModelName: string;
  displayName: string;
  status: string;
  providerIdRef: string;
  providerScopeRef: string;
  providerName: string;
  providerStatus: string;
  providerBindingStatus: string | null;
}

export class ModelAccessRoutingQueryService implements GatewayRoutingQueryPort {
  constructor(
    private readonly transactions: PrismaTransactionOwner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  inspectAccessPointRouting(accessPointId: string, budget: GraphCompilationBudget): Promise<RoutingDiagnosticReport> {
    return this.evaluateEntryRouting({ entryAccessPointId: requiredId(accessPointId, "AccessPointId") }, budget);
  }

  evaluateGatewayRouting(input: GatewayRoutingQueryInput): Promise<GatewayRoutingSnapshot> {
    const entryAccessPointId = requiredId(input.entryAccessPointId, "entryAccessPointId");
    const budget = input.budget ?? createGatewayRoutingBudget(input.signal);
    return this.transactions.withPrismaTransaction(async (transaction) => {
      const loaded = await loadReachableRoutingGraph(transaction, entryAccessPointId, budget);
      const entry = loaded.accessPoints.find((accessPoint) => accessPoint.id === entryAccessPointId);
      if (!entry) throw new RelayError("access_point_not_found", `AccessPoint ${entryAccessPointId} not found`, 404);
      const requestedModel = input.requestedModel === undefined
        ? entry.exposedModel
        : requiredId(input.requestedModel, "requestedModel");
      const plan = compileRoutingPlan({ entryAccessPointId, requestedModel, graph: loaded.graph }, budget);
      const evaluation = evaluateRouting(plan, {
        availability: loaded.availability,
        ...(input.attempts ? { attempts: input.attempts } : {}),
      }, budget);
      return Object.freeze({
        outcome: evaluation.selectedCandidateId === null ? "unavailable" : "available",
        evaluatedAt: this.now().toISOString(),
        plan,
        candidates: evaluation.candidates,
        selectedCandidateId: evaluation.selectedCandidateId,
        selectedCandidate: evaluation.selectedCandidate,
        scopeReferences: Object.freeze({
          accessPoints: Object.freeze(loaded.accessPoints.map((accessPoint) => Object.freeze({
            id: accessPoint.id,
            scopeRef: accessPoint.scopeRef,
            routingRevision: accessPoint.routingRevision,
          }))),
          providers: Object.freeze(loaded.providers.map((provider) => Object.freeze({
            id: provider.id,
            scopeRef: provider.scopeRef,
          }))),
        }),
        work: budget.snapshot(),
      });
    }, 1, {
      isolationLevel: "RepeatableRead",
    });
  }

  evaluateEntryRouting(
    input: { readonly entryAccessPointId: string; readonly requestedModel?: string },
    budget: GraphCompilationBudget,
  ): Promise<RoutingDiagnosticReport> {
    const entryAccessPointId = requiredId(input.entryAccessPointId, "entryAccessPointId");
    return this.transactions.withPrismaTransaction(async (transaction) => {
      const loaded = await loadReachableRoutingGraph(transaction, entryAccessPointId, budget);
      const entry = loaded.accessPoints.find((accessPoint) => accessPoint.id === entryAccessPointId);
      if (!entry) throw new RelayError("access_point_not_found", `AccessPoint ${entryAccessPointId} not found`, 404);
      const requestedModel = input.requestedModel === undefined
        ? entry.exposedModel
        : requiredId(input.requestedModel, "requestedModel");
      const plan = compileRoutingPlan({ entryAccessPointId, requestedModel, graph: loaded.graph }, budget);
      const evaluation = evaluateRouting(plan, { availability: loaded.availability }, budget);
      return Object.freeze({
        outcome: evaluation.selectedCandidateId === null ? "unavailable" : "available",
        evaluatedAt: this.now().toISOString(),
        entryAccessPoint: entry,
        plan,
        candidates: evaluation.candidates,
        selectedCandidateId: evaluation.selectedCandidateId,
        accessPoints: loaded.accessPoints,
        providers: loaded.providers,
        providerModels: loaded.providerModels,
        work: budget.snapshot(),
      });
    }, 1, {
      isolationLevel: "RepeatableRead",
    });
  }
}

export function createModelAccessRoutingQueryBudget(signal?: AbortSignal): GraphCompilationBudget {
  return createGatewayRoutingBudget(signal);
}

async function loadReachableRoutingGraph(
  transaction: Prisma.TransactionClient,
  entryAccessPointId: string,
  budget: GraphCompilationBudget,
): Promise<LoadedRoutingGraph> {
  const accessPointRows = new Map<string, {
    id: string;
    ownerId: string;
    scopeRef: string;
    name: string;
    description: string | null;
    exposedModel: string;
    targetModel: string;
    routingRuleId: string;
    routingRuleBehaviorVersion: number;
    routingRuleConfigJson: string;
    routingRevision: number;
    status: string;
    removedAt: string | null;
    targets: Array<{
      id: string;
      targetType: string;
      targetAccessPointId: string | null;
      targetProviderId: string | null;
      targetProviderModelName: string | null;
      targetProviderModelId: string | null;
      position: number;
      status: string;
      removedAt: string | null;
    }>;
  }>();
  const providerModelIds = new Set<string>();

  budget.checkpoint();
  const routingRows = await readReachableRoutingRows(transaction, entryAccessPointId);
  for (const row of routingRows) {
    let accessPoint = accessPointRows.get(row.accessPointId);
    if (!accessPoint) {
      accessPoint = {
        id: row.accessPointId,
        ownerId: row.ownerId,
        scopeRef: row.scopeRef,
        name: row.name,
        description: row.description,
        exposedModel: row.exposedModel,
        targetModel: row.targetModel,
        routingRuleId: row.routingRuleId,
        routingRuleBehaviorVersion: row.routingRuleBehaviorVersion,
        routingRuleConfigJson: row.routingRuleConfigJson,
        routingRevision: row.routingRevision,
        status: row.status,
        removedAt: row.removedAt,
        targets: [],
      };
      accessPointRows.set(row.accessPointId, accessPoint);
      budget.visitNode(row.accessPointId, new TextEncoder().encode(row.routingRuleConfigJson).byteLength);
    }
    if (row.targetId) {
      const target = {
        id: row.targetId,
        targetType: row.targetType!,
        targetAccessPointId: row.targetAccessPointId,
        targetProviderId: row.targetProviderId,
        targetProviderModelName: row.targetProviderModelName,
        targetProviderModelId: row.targetProviderModelId,
        position: row.targetPosition!,
        status: row.targetStatus!,
        removedAt: row.targetRemovedAt,
      };
      accessPoint.targets.push(target);
      budget.visitEdge(target.id);
      if (target.targetType === "provider-model" && target.targetProviderModelId) providerModelIds.add(target.targetProviderModelId);
    }
  }

  budget.checkpoint();
  const providerModelRows = providerModelIds.size === 0
    ? []
    : await readProviderModelBatch(transaction, [...providerModelIds]);

  const graphAccessPoints = new Map<string, RoutingGraphAccessPoint>();
  const accessPointStatuses = new Map<string, string>();
  const accessPoints: RoutingAccessPointDiagnostic[] = [];
  for (const row of accessPointRows.values()) {
    graphAccessPoints.set(row.id, Object.freeze({
      id: row.id,
      exposedModel: row.exposedModel,
      targetModel: row.targetModel,
      routingRuleId: row.routingRuleId,
      routingRuleBehaviorVersion: row.routingRuleBehaviorVersion,
      routingRuleConfigJson: row.routingRuleConfigJson,
      routingRevision: row.routingRevision,
      removedAt: row.removedAt,
      targets: Object.freeze(row.targets.map((target) => Object.freeze({
        id: target.id,
        type: target.targetType as "provider-model" | "access-point",
        targetAccessPointId: target.targetAccessPointId,
        targetProviderModelId: target.targetProviderModelId,
        targetProviderId: target.targetProviderId,
        targetProviderModelName: target.targetProviderModelName,
        position: target.position,
        status: target.status,
        removedAt: target.removedAt,
      }))),
    }));
    accessPointStatuses.set(row.id, row.status);
    accessPoints.push(Object.freeze({
      id: row.id,
      ownerId: row.ownerId,
      scopeRef: row.scopeRef,
      name: row.name,
      description: row.description,
      exposedModel: row.exposedModel,
      targetModel: row.targetModel,
      status: row.status,
      routingRevision: row.routingRevision,
    }));
  }

  const graphProviderModels = new Map<string, RoutingGraphProviderModel>();
  const providerStatuses = new Map<string, string>();
  const providerModelStatuses = new Map<string, string>();
  const providerBindingStatuses = new Map<string, string>();
  const providers = new Map<string, RoutingProviderDiagnostic>();
  const providerModels: RoutingProviderModelDiagnostic[] = [];
  for (const row of providerModelRows) {
    graphProviderModels.set(row.id, Object.freeze({
      id: row.id,
      providerId: row.providerId,
      providerModelName: row.providerModelName,
    }));
    providerModelStatuses.set(row.id, row.status);
    providerStatuses.set(row.providerIdRef, row.providerStatus);
    if (row.providerBindingStatus) providerBindingStatuses.set(row.providerIdRef, row.providerBindingStatus);
    providers.set(row.providerIdRef, Object.freeze({
      id: row.providerIdRef,
      scopeRef: row.providerScopeRef,
      name: row.providerName,
      status: row.providerStatus,
      bindingStatus: row.providerBindingStatus,
    }));
    providerModels.push(Object.freeze({
      id: row.id,
      providerId: row.providerId,
      providerModelName: row.providerModelName,
      displayName: row.displayName,
      status: row.status,
    }));
  }

  return Object.freeze({
    graph: Object.freeze({ accessPoints: graphAccessPoints, providerModels: graphProviderModels }),
    availability: Object.freeze({ accessPointStatuses, providerStatuses, providerModelStatuses, providerBindingStatuses }),
    accessPoints: Object.freeze(accessPoints.sort((left, right) => left.id.localeCompare(right.id))),
    providers: Object.freeze([...providers.values()].sort((left, right) => left.id.localeCompare(right.id))),
    providerModels: Object.freeze(providerModels.sort((left, right) => left.id.localeCompare(right.id))),
  });
}

function readReachableRoutingRows(transaction: Prisma.TransactionClient, entryAccessPointId: string) {
  return transaction.$queryRaw<RoutingAccessPointSqlRow[]>`
    WITH RECURSIVE reachable("access_point_id", "depth") AS (
      SELECT ap."id", 0::integer
      FROM "access_points" ap
      WHERE ap."id" = ${entryAccessPointId} AND ap."removed_at" IS NULL
      UNION
      SELECT target."target_access_point_id", reachable."depth" + 1
      FROM reachable
      INNER JOIN "access_point_targets" target
        ON target."access_point_id" = reachable."access_point_id"
       AND target."target_type" = 'access-point'
       AND target."target_access_point_id" IS NOT NULL
       AND target."status" = 'enabled'
       AND target."removed_at" IS NULL
      INNER JOIN "access_points" downstream
        ON downstream."id" = target."target_access_point_id"
       AND downstream."removed_at" IS NULL
      -- Include one sentinel hop so the pure kernel can classify an over-limit
      -- path instead of seeing its first out-of-range target as missing.
      WHERE reachable."depth" < ${MAX_ACCESS_POINT_TO_ACCESS_POINT_HOPS + 1}
    ),
    reachable_ids AS (
      SELECT "access_point_id", MIN("depth") AS "depth"
      FROM reachable
      GROUP BY "access_point_id"
    )
    SELECT
      ap."id" AS "accessPointId",
      ap."owner_id" AS "ownerId",
      ap."scope_ref" AS "scopeRef",
      ap."name" AS "name",
      ap."description" AS "description",
      ap."exposed_model" AS "exposedModel",
      ap."target_model" AS "targetModel",
      ap."selector_id" AS "routingRuleId",
      ap."selector_behavior_version" AS "routingRuleBehaviorVersion",
      ap."selector_config_json" AS "routingRuleConfigJson",
      ap."routing_revision" AS "routingRevision",
      ap."status" AS "status",
      ap."removed_at" AS "removedAt",
      target."id" AS "targetId",
      target."target_type" AS "targetType",
      target."target_access_point_id" AS "targetAccessPointId",
      target."target_provider_id" AS "targetProviderId",
      target."target_provider_model_name" AS "targetProviderModelName",
      target."target_provider_model_id" AS "targetProviderModelId",
      target."position" AS "targetPosition",
      target."status" AS "targetStatus",
      target."removed_at" AS "targetRemovedAt"
    FROM reachable_ids
    INNER JOIN "access_points" ap ON ap."id" = reachable_ids."access_point_id"
    LEFT JOIN "access_point_targets" target
      ON target."access_point_id" = ap."id"
     AND target."status" = 'enabled'
     AND target."removed_at" IS NULL
    ORDER BY ap."id" ASC, target."position" ASC NULLS LAST, target."id" ASC NULLS LAST
  `;
}

function readProviderModelBatch(transaction: Prisma.TransactionClient, ids: readonly string[]) {
  return transaction.$queryRaw<RoutingProviderModelSqlRow[]>`
    SELECT
      model."id" AS "id",
      model."provider_id" AS "providerId",
      model."provider_model_name" AS "providerModelName",
      model."display_name" AS "displayName",
      model."status" AS "status",
      provider."id" AS "providerIdRef",
      provider."scope_ref" AS "providerScopeRef",
      provider."name" AS "providerName",
      provider."status" AS "providerStatus",
      binding."sync_status" AS "providerBindingStatus"
    FROM "provider_models" model
    INNER JOIN "providers" provider ON provider."id" = model."provider_id"
    LEFT JOIN "provider_bindings" binding ON binding."provider_id" = provider."id"
    WHERE model."id" = ANY(${ids}::text[])
    ORDER BY model."id" ASC
  `;
}

function requiredId(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new RelayError("routing_query_input_invalid", `${name} is required`, 400);
  return normalized;
}
