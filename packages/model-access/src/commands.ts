import {
  createId,
  isRuntimeScopeRef,
  nowIso,
  parseScopeRef,
  RelayError,
  type ScopeRef,
} from "@frely/core";
import type { AccessPoint, AccessPointTarget } from "@frely/postgres/model-types";
import { Prisma, type PrismaTransactionOwner } from "@frely/postgres/server";
import type { ModelAccessAuditAppender } from "./audit-contract.js";
import type {
  AccessPointCommandResult,
  ChangeAccessPointCommand,
  CreateAccessPointCommand,
  ModelAccessAuditInput,
} from "./public-contracts.js";
import { ProviderManagementCommandService } from "./provider-management.js";
import { normalizeAccessPointDescription } from "./description.js";
import {
  normalizeRoutingDefinition,
  canonicalModelAccessHash,
  routingSemanticFingerprint,
  targetIdentityEquals,
  type NormalizedRoutingDefinition,
} from "./domain.js";

export type {
  AccessPointCommandResult,
  ChangeAccessPointCommand,
  CreateAccessPointCommand,
} from "./public-contracts.js";

/**
 * Application-owned admission for non-owner AccessPoint creation.
 *
 * Model Access invokes this only after the scope row and the stable
 * idempotency key have been serialized, and before inserting the AP row. The
 * callback therefore reads the Entitlement/Tenancy facts and the Model Access
 * occupancy in the same PostgreSQL transaction as the insert.
 */
export type AccessPointCreationAdmission = (
  input: Readonly<{
    scopeRef: ScopeRef;
    ownerId: string;
    personalProviderSlotId: string | null;
    countUnremovedAccessPoints: () => Promise<number>;
  }>,
) => Promise<void>;

export class ModelAccessCommandService {
  readonly providers: ProviderManagementCommandService;

  constructor(
    private readonly transactions: PrismaTransactionOwner,
    private readonly auditAppender: ModelAccessAuditAppender,
  ) {
    this.providers = new ProviderManagementCommandService(transactions, auditAppender);
  }

  createAccessPoint(command: CreateAccessPointCommand, audit: ModelAccessAuditInput): Promise<AccessPointCommandResult> {
    return this.transactions.withPrismaTransaction((transaction) => createAccessPoint(transaction, command, audit, this.auditAppender));
  }

  changeAccessPoint(id: string, command: ChangeAccessPointCommand, audit: ModelAccessAuditInput): Promise<AccessPointCommandResult> {
    return this.transactions.withPrismaTransaction((transaction) => changeAccessPoint(transaction, id, command, audit, this.auditAppender));
  }

  removeAccessPoint(id: string, audit: ModelAccessAuditInput): Promise<AccessPointCommandResult> {
    return this.transactions.withPrismaTransaction((transaction) => removeAccessPoint(transaction, id, audit, this.auditAppender));
  }
}

export function createAccessPoint(
  transaction: Prisma.TransactionClient,
  command: CreateAccessPointCommand,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<AccessPointCommandResult> {
  return createAccessPointRecord(transaction, command, null, audit, auditAppender);
}

export function createAccessPointWithAdmission(
  transaction: Prisma.TransactionClient,
  command: CreateAccessPointCommand,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
  admission: AccessPointCreationAdmission,
): Promise<AccessPointCommandResult> {
  return createAccessPointRecord(transaction, command, null, audit, auditAppender, admission);
}

async function createAccessPointRecord(
  transaction: Prisma.TransactionClient,
  command: CreateAccessPointCommand,
  personalProviderSlotId: string | null,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
  admission?: AccessPointCreationAdmission,
): Promise<AccessPointCommandResult> {
  await lockRoutingGraph(transaction);
  const scopeRef = requireScopeRef(command.scopeRef);
  await lockScope(transaction, scopeRef);
  if ((command.status ?? "disabled") !== "disabled") {
    throw new RelayError("access_point_create_must_be_disabled", "New AccessPoint must be created disabled", 409);
  }
  const targetModel = requiredTrimmed(command.targetModel, "targetModel");
  const exposedModel = requiredTrimmed(command.exposedModel, "exposedModel");
  const routing = normalizeRoutingDefinition(command.routing, targetModel);
  const ownerId = requiredTrimmed(command.ownerId, "ownerId");
  const idempotencyKeyHash = canonicalModelAccessHash(requiredTrimmed(command.idempotencyKey, "Idempotency-Key"), "access_point_idempotency_key_invalid");
  const requestHash = canonicalModelAccessHash({
    ownerId,
    scopeRef,
    name: requiredTrimmed(command.name, "name"),
    description: normalizeAccessPointDescription(command.description),
    apiFamily: requiredTrimmed(command.apiFamily, "apiFamily"),
    exposedModel,
    targetModel,
    routing: {
      ruleId: routing.ruleId,
      behaviorVersion: routing.behaviorVersion,
      configJson: routing.configJson,
      requestOverridesJson: routing.requestOverridesJson,
      targets: routing.targets.map((target) => ({ ...target, id: target.id ?? null })),
    },
    priority: integerOrDefault(command.priority, 100, "priority"),
    weight: integerOrDefault(command.weight, 1, "weight"),
    fallbackOrder: integerOrDefault(command.fallbackOrder, 100, "fallbackOrder"),
    status: "disabled",
    personalProviderSlotId,
  }, "access_point_request_hash_invalid");
  const prior = await transaction.accessPoint.findFirst({ where: { scopeRef, createIdempotencyKeyHash: idempotencyKeyHash } });
  if (prior) {
    if (prior.createRequestHash !== requestHash) {
      throw new RelayError("access_point_idempotency_conflict", "Idempotency-Key was already used with different AccessPoint parameters", 409, { accessPointId: prior.id });
    }
    return { id: prior.id, routingRevision: prior.routingRevision, routingChanged: false, removed: prior.removedAt !== null, replayed: true };
  }
  if (admission) {
    await admission({
      scopeRef,
      ownerId,
      personalProviderSlotId,
      countUnremovedAccessPoints: () => transaction.accessPoint.count({
        where: personalProviderSlotId === null
          ? { scopeRef, removedAt: null }
          : { personalProviderSlotId, removedAt: null },
      }),
    });
  }
  const id = createId("ap");
  if (routing.targets.some((target) => target.targetAccessPointId === id)) {
    throw new RelayError("invalid_access_point", "AccessPoint cannot target itself", 400);
  }
  const providerModelIds = await validateRoutingTargets(transaction, { sourceId: id, sourceScopeRef: scopeRef, targetModel, sourceStatus: "disabled", routing });
  const now = nowIso();
  const primary = routing.targets.find((target) => target.status === "enabled") ?? routing.targets[0]!;
  await transaction.accessPoint.create({ data: {
    id,
    ownerId,
    scopeRef,
    name: requiredTrimmed(command.name, "name"),
    description: normalizeAccessPointDescription(command.description),
    apiFamily: requiredTrimmed(command.apiFamily, "apiFamily"),
    exposedModel,
    targetModel,
    routingRuleId: routing.ruleId,
    routingRuleBehaviorVersion: routing.behaviorVersion,
    routingRuleConfigJson: routing.configJson,
    requestOverridesJson: routing.requestOverridesJson,
    routingRevision: 1,
    ...legacyTargetProjection(primary),
    priority: integerOrDefault(command.priority, 100, "priority"),
    weight: integerOrDefault(command.weight, 1, "weight"),
    fallbackOrder: integerOrDefault(command.fallbackOrder, 100, "fallbackOrder"),
    status: "disabled",
    personalProviderSlotId,
    removedAt: null,
    createIdempotencyKeyHash: idempotencyKeyHash,
    createRequestHash: requestHash,
    createdAt: now,
    updatedAt: now,
    targets: { create: routing.targets.map((target) => ({
      id: target.id ?? createId("ap_target"),
      targetType: target.type,
      targetAccessPointId: target.targetAccessPointId,
      targetProviderId: target.targetProviderId,
      targetProviderModelName: target.targetProviderModelName,
      targetProviderModelId: stableProviderModelId(target, providerModelIds),
      position: target.position,
      status: target.status,
      removedAt: null,
      createdAt: now,
      updatedAt: now,
    })) },
  } });
  await validateProspectiveGraph(transaction);
  await auditAppender.append(transaction, {
    ...audit,
    action: "access_point.create",
    resourceType: "access_point",
    resourceId: id,
    result: "success",
    metadata: { accessPointId: id, scopeRef },
  });
  return { id, routingRevision: 1, routingChanged: true, removed: false, replayed: false };
}

export async function createPersonalProviderAccessPoint(
  transaction: Prisma.TransactionClient,
  slot: Readonly<{ id: string; userId: string; providerId: string | null; lifecycle: "active" }>,
  command: Omit<CreateAccessPointCommand, "ownerId" | "scopeRef">,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
  admission: AccessPointCreationAdmission,
): Promise<AccessPointCommandResult> {
  if (!slot.providerId) throw new RelayError("provider_slot_provider_required", "Personal Provider slot must have a Provider before creating AccessPoints", 409);
  if (audit.actor.actorType !== "user" || audit.actor.actorId !== slot.userId) throw new RelayError("provider_slot_actor_forbidden", "Personal Provider slot belongs to another user", 403);
  const normalized = normalizeRoutingDefinition(command.routing, requiredTrimmed(command.targetModel, "targetModel"));
  if (normalized.ruleId !== "direct" || normalized.targets.length !== 1 || normalized.targets[0]?.type !== "provider-model"
    || normalized.targets[0].targetProviderId !== slot.providerId) {
    if (normalized.targets.some((target) => target.type === "access-point")) {
      throw new RelayError("personal_access_point_facade_not_supported", "Platform AccessPoint facade delegation is not available in this release", 409);
    }
    throw new RelayError("personal_access_point_target_forbidden", "Personal AccessPoint must target a ProviderModel in the selected slot", 403);
  }
  return createAccessPointRecord(transaction, {
    ...command, ownerId: slot.userId, scopeRef: `user:${slot.userId}`,
  }, slot.id, audit, auditAppender, admission);
}

export async function changeAccessPoint(
  transaction: Prisma.TransactionClient,
  id: string,
  command: ChangeAccessPointCommand,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<AccessPointCommandResult> {
  await lockRoutingGraph(transaction);
  await lockAccessPoint(transaction, id);
  const existing = await transaction.accessPoint.findUnique({ where: { id }, include: { targets: true } });
  if (!existing || existing.removedAt) throw new RelayError("access_point_not_found", `AccessPoint ${id} not found`, 404);
  const scopeRef = requireScopeRef(command.scopeRef ?? existing.scopeRef);
  if (scopeRef !== existing.scopeRef) {
    throw new RelayError("access_point_scope_immutable", "AccessPoint scope cannot change", 409);
  }
  if (command.ownerId !== undefined && command.ownerId !== existing.ownerId) {
    throw new RelayError("access_point_owner_immutable", "AccessPoint owner cannot change", 409);
  }
  await lockScope(transaction, scopeRef);
  const targetModel = requiredTrimmed(command.targetModel, "targetModel");
  const exposedModel = requiredTrimmed(command.exposedModel, "exposedModel");
  const nextStatus = command.status ?? existing.status;
  if (nextStatus !== "enabled" && nextStatus !== "disabled") throw new RelayError("invalid_access_point_status", "AccessPoint status must be enabled or disabled", 400);
  if (existing.status !== "enabled" && nextStatus === "enabled") {
    const enabledPrice = await transaction.access_point_prices.findFirst({
      where: { access_point_id: id, status: "enabled" },
      select: { id: true },
    });
    if (!enabledPrice) throw new RelayError("access_point_price_not_configured", "AccessPoint requires an enabled sale price before it can be enabled", 409);
  }
  if (command.routing?.expectedRoutingRevision !== undefined && command.routing.expectedRoutingRevision !== existing.routingRevision) {
    throw new RelayError("access_point_routing_revision_conflict", "AccessPoint routing revision does not match", 409, { routingRevision: existing.routingRevision });
  }
  const currentRouting = routingFromRows(existing);
  const routing = command.routing ? normalizeRoutingDefinition(command.routing, targetModel) : currentRouting;
  if (routing.targets.some((target) => target.targetAccessPointId === id)) {
    throw new RelayError("invalid_access_point", "AccessPoint cannot target itself", 400);
  }
  const providerModelIds = await validateRoutingTargets(transaction, { sourceId: id, sourceScopeRef: scopeRef, targetModel, sourceStatus: nextStatus, routing });
  const resolvedTargets = resolveTargetIdentities(existing.targets, routing, providerModelIds);
  const previousFingerprint = routingSemanticFingerprint({
    exposedModel: existing.exposedModel,
    targetModel: existing.targetModel,
    ruleId: existing.routingRuleId,
    behaviorVersion: existing.routingRuleBehaviorVersion,
    configJson: existing.routingRuleConfigJson,
    requestOverridesJson: existing.requestOverridesJson,
    targets: existing.targets.map(domainTarget),
  });
  const nextFingerprint = routingSemanticFingerprint({
    exposedModel,
    targetModel,
    ruleId: routing.ruleId,
    behaviorVersion: routing.behaviorVersion,
    configJson: routing.configJson,
    requestOverridesJson: routing.requestOverridesJson,
    targets: resolvedTargets.map((target) => ({ ...target, type: target.targetType })),
  });
  const routingChanged = previousFingerprint !== nextFingerprint;
  const routingRevision = existing.routingRevision + (routingChanged ? 1 : 0);
  const now = nowIso();

  if (command.routing) {
    const retainedIds = new Set(resolvedTargets.map((target) => target.id));
    for (const target of existing.targets) {
      if (target.removedAt || retainedIds.has(target.id)) continue;
      await transaction.accessPointTarget.update({ where: { id: target.id }, data: { status: "disabled", removedAt: now, updatedAt: now } });
    }
    for (const target of resolvedTargets) {
      const current = existing.targets.find((candidate) => candidate.id === target.id);
      if (current) {
        if (current.status !== target.status || current.position !== target.position) {
          await transaction.accessPointTarget.update({ where: { id: target.id }, data: { status: target.status, position: target.position, updatedAt: now } });
        }
      } else {
        await transaction.accessPointTarget.create({ data: {
          id: target.id, accessPointId: id, targetType: target.targetType,
          targetAccessPointId: target.targetAccessPointId, targetProviderId: target.targetProviderId,
          targetProviderModelName: target.targetProviderModelName, targetProviderModelId: target.targetProviderModelId,
          position: target.position,
          status: target.status, removedAt: null, createdAt: now, updatedAt: now,
        } });
      }
    }
  }
  const primary = resolvedTargets.find((target) => target.status === "enabled") ?? resolvedTargets[0]!;
  await transaction.accessPoint.update({ where: { id }, data: {
    name: requiredTrimmed(command.name, "name"),
    description: command.description === undefined ? existing.description : normalizeAccessPointDescription(command.description),
    apiFamily: requiredTrimmed(command.apiFamily, "apiFamily"),
    exposedModel,
    targetModel,
    routingRuleId: routing.ruleId,
    routingRuleBehaviorVersion: routing.behaviorVersion,
    routingRuleConfigJson: routing.configJson,
    requestOverridesJson: routing.requestOverridesJson,
    routingRevision,
    ...legacyTargetProjection({
      type: primary.targetType as "provider-model" | "access-point",
      targetAccessPointId: primary.targetAccessPointId,
      targetProviderId: primary.targetProviderId,
      targetProviderModelName: primary.targetProviderModelName,
    }),
    priority: integerOrDefault(command.priority, existing.priority, "priority"),
    weight: integerOrDefault(command.weight, existing.weight, "weight"),
    fallbackOrder: integerOrDefault(command.fallbackOrder, existing.fallbackOrder, "fallbackOrder"),
    status: nextStatus,
    updatedAt: now,
  } });
  await validateProspectiveGraph(transaction);
  await auditAppender.append(transaction, {
    ...audit,
    action: "access_point.update",
    resourceType: "access_point",
    resourceId: id,
    result: "success",
    metadata: {
      accessPointId: id, oldRoutingRevision: existing.routingRevision, newRoutingRevision: routingRevision,
      routingChanged, descriptionChanged: command.description !== undefined && normalizeAccessPointDescription(command.description) !== existing.description,
      targetEdgeCount: resolvedTargets.length,
    },
  });
  return { id, routingRevision, routingChanged, removed: false, replayed: false };
}

export async function removeAccessPoint(
  transaction: Prisma.TransactionClient,
  id: string,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<AccessPointCommandResult> {
  await lockRoutingGraph(transaction);
  await lockAccessPoint(transaction, id);
  const existing = await transaction.accessPoint.findUnique({ where: { id } });
  if (!existing) throw new RelayError("access_point_not_found", `AccessPoint ${id} not found`, 404);
  if (existing.removedAt) return { id, routingRevision: existing.routingRevision, routingChanged: false, removed: true, replayed: true };
  await lockScope(transaction, requireScopeRef(existing.scopeRef));
  if (existing.status !== "disabled") throw new RelayError("access_point_must_be_disabled", "AccessPoint must be disabled before removal", 409);
  const inbound = await transaction.accessPointTarget.findFirst({
    where: { targetAccessPointId: id, removedAt: null },
    select: { id: true, accessPointId: true },
  });
  if (inbound) {
    throw new RelayError("access_point_has_inbound_edge", "AccessPoint is referenced by an active routing edge", 409, { edgeId: inbound.id, sourceAccessPointId: inbound.accessPointId });
  }
  const referencedPlan = await transaction.plan_access_points.findFirst({
    where: { access_point_id: id, plans: { plan_status: { not: "disabled" } } },
    select: { plan_id: true },
  });
  if (referencedPlan) throw new RelayError("access_point_has_enabled_plan", "AccessPoint is referenced by a Plan and cannot be removed until every reference is disabled", 409, { planId: referencedPlan.plan_id });
  const now = nowIso();
  await transaction.accessPointTarget.updateMany({
    where: { accessPointId: id, removedAt: null },
    data: { status: "disabled", removedAt: now, updatedAt: now },
  });
  await transaction.accessPoint.update({ where: { id }, data: { removedAt: now, updatedAt: now } });
  await auditAppender.append(transaction, {
    ...audit,
    action: "access_point.remove",
    resourceType: "access_point",
    resourceId: id,
    result: "success",
    metadata: { accessPointId: id, routingRevision: existing.routingRevision },
  });
  return { id, routingRevision: existing.routingRevision, routingChanged: false, removed: true, replayed: false };
}

function routingFromRows(existing: AccessPoint & { targets: AccessPointTarget[] }): NormalizedRoutingDefinition {
  const targets = existing.targets.filter((target) => !target.removedAt).map((target) => ({
    id: target.id,
    type: target.targetType as "provider-model" | "access-point",
    targetAccessPointId: target.targetAccessPointId,
    targetProviderId: target.targetProviderId,
    targetProviderModelName: target.targetProviderModelName,
    position: target.position,
    status: target.status as "enabled" | "disabled",
  }));
  return normalizeRoutingDefinition({
    selector: {
      id: existing.routingRuleId as "direct" | "ordered-fallback",
      behaviorVersion: existing.routingRuleBehaviorVersion as 1,
      config: parseJson(existing.routingRuleConfigJson),
    },
    requestOverrides: parseJson(existing.requestOverridesJson),
    targets,
  }, existing.targetModel);
}

function resolveTargetIdentities(
  existing: AccessPointTarget[],
  routing: NormalizedRoutingDefinition,
  providerModelIds: ReadonlyMap<string, string>,
) {
  return routing.targets.map((target) => {
    const id = target.id ?? createId("ap_target");
    const current = existing.find((candidate) => candidate.id === id);
    const targetProviderModelId = stableProviderModelId(target, providerModelIds);
    if (current?.removedAt) throw new RelayError("access_point_target_removed", `Removed target ${id} cannot be restored`, 409);
    if (current && !targetIdentityEquals(current, target)) {
      throw new RelayError("access_point_target_identity_immutable", `Target identity ${id} cannot be changed`, 409);
    }
    if (current && current.targetProviderModelId !== targetProviderModelId) {
      throw new RelayError("provider_model_reference_mismatch", `Target ${id} has an inconsistent ProviderModelId`, 500);
    }
    return {
      id,
      targetType: target.type,
      targetAccessPointId: target.targetAccessPointId,
      targetProviderId: target.targetProviderId,
      targetProviderModelName: target.targetProviderModelName,
      targetProviderModelId,
      position: target.position,
      status: target.status,
      removedAt: null as string | null,
    };
  });
}

async function validateRoutingTargets(
  transaction: Prisma.TransactionClient,
  input: { sourceId: string; sourceScopeRef: ScopeRef; targetModel: string; sourceStatus: string; routing: NormalizedRoutingDefinition },
): Promise<Map<string, string>> {
  const providerModelIds = new Map<string, string>();
  for (const target of input.routing.targets) {
    if (target.type === "provider-model") {
      const provider = await transaction.providers.findUnique({ where: { id: target.targetProviderId! } });
      if (!provider || !(await scopeCanSee(transaction, input.sourceScopeRef, provider.scope_ref as ScopeRef))) {
        throw new RelayError("invalid_access_point", `Unknown or invisible Provider: ${target.targetProviderId}`, 400);
      }
      const model = await transaction.provider_models.findUnique({
        where: { provider_id_provider_model_name: {
          provider_id: provider.id,
          provider_model_name: target.targetProviderModelName!,
        } },
      });
      if (!model) throw new RelayError("provider_model_not_found", `Provider model ${provider.id}:${target.targetProviderModelName} not found`, 404);
      const cost = await transaction.provider_model_costs.findFirst({
        where: { provider_id: provider.id, provider_model_name: target.targetProviderModelName!, status: "enabled" },
        select: { id: true },
      });
      if (!cost) throw new RelayError("provider_model_cost_not_configured", `Provider model ${provider.id}:${target.targetProviderModelName} has no enabled cost`, 409);
      providerModelIds.set(providerModelIdentityKey(provider.id, target.targetProviderModelName!), model.id);
      continue;
    }
    const targetAccessPoint = await transaction.accessPoint.findUnique({ where: { id: target.targetAccessPointId! } });
    if (!targetAccessPoint || targetAccessPoint.removedAt) throw new RelayError("invalid_access_point", `Unknown AccessPoint: ${target.targetAccessPointId}`, 400);
    if (targetAccessPoint.id === input.sourceId) throw new RelayError("invalid_access_point", "AccessPoint cannot target itself", 400);
    if (targetAccessPoint.exposedModel !== input.targetModel) throw new RelayError("access_point_target_model_mismatch", `Target AccessPoint ${targetAccessPoint.id} does not expose ${input.targetModel}`, 400);
    if (!(await scopeCanSee(transaction, input.sourceScopeRef, targetAccessPoint.scopeRef as ScopeRef))) {
      throw new RelayError("access_point_source_not_authorized", `Target AccessPoint ${targetAccessPoint.id} is not visible from ${input.sourceScopeRef}`, 403);
    }
    if (input.sourceStatus === "enabled" && target.status === "enabled" && targetAccessPoint.status !== "enabled") {
      throw new RelayError("access_point_target_disabled", `Target AccessPoint ${targetAccessPoint.id} must be enabled first`, 409);
    }
  }
  return providerModelIds;
}

async function validateProspectiveGraph(transaction: Prisma.TransactionClient): Promise<void> {
  const accessPoints = await transaction.accessPoint.findMany({ where: { removedAt: null }, include: { targets: { where: { removedAt: null } } } });
  const byId = new Map(accessPoints.map((accessPoint) => [accessPoint.id, accessPoint]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitCycle = (id: string): void => {
    if (visiting.has(id)) throw new RelayError("access_point_cycle", "AccessPoint routing graph contains a cycle", 409, { accessPointId: id });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of byId.get(id)?.targets ?? []) {
      if (target.status === "enabled" && target.targetType === "access-point" && target.targetAccessPointId && byId.has(target.targetAccessPointId)) visitCycle(target.targetAccessPointId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visitCycle(id);

  const visitFallbackCount = (id: string, count: number, path: Set<string>): void => {
    const accessPoint = byId.get(id);
    if (!accessPoint || accessPoint.status !== "enabled") return;
    const nextCount = count + (accessPoint.routingRuleId === "ordered-fallback" ? 1 : 0);
    if (nextCount > 1) throw new RelayError("access_point_multiple_fallback_rules", "An enabled routing path may contain at most one ordered-fallback@1 rule", 409, { accessPointId: id });
    const nextPath = new Set(path).add(id);
    for (const target of accessPoint.targets) {
      if (target.status === "enabled" && target.targetType === "access-point" && target.targetAccessPointId && !nextPath.has(target.targetAccessPointId)) {
        visitFallbackCount(target.targetAccessPointId, nextCount, nextPath);
      }
    }
  };
  for (const id of byId.keys()) visitFallbackCount(id, 0, new Set());
}

async function scopeCanSee(transaction: Prisma.TransactionClient, sourceScopeRef: ScopeRef, targetScopeRef: ScopeRef): Promise<boolean> {
  if (targetScopeRef === "global:" || sourceScopeRef === targetScopeRef) return true;
  const source = parseScopeRef(sourceScopeRef);
  const target = parseScopeRef(targetScopeRef);
  if (source.scopeType === "global") return false;
  if (source.scopeType === "team") return target.scopeType === "team" && source.scopeId === target.scopeId;
  const userId = source.scopeType === "user"
    ? source.scopeId
    : (await transaction.api_keys.findUnique({ where: { id: source.scopeId }, select: { user_id: true } }))?.user_id;
  if (!userId) return false;
  if (target.scopeType === "user") return target.scopeId === userId;
  if (target.scopeType === "key") return source.scopeType === "key" && target.scopeId === source.scopeId;
  if (target.scopeType !== "team") return false;
  return Boolean(await transaction.team_memberships.findFirst({ where: { team_id: target.scopeId, user_id: userId }, select: { id: true } }));
}

async function lockScope(transaction: Prisma.TransactionClient, scopeRef: ScopeRef): Promise<void> {
  const scope = parseScopeRef(scopeRef);
  if (scope.scopeType === "global") {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scopeRef}, 0))`;
    return;
  }
  const table = scope.scopeType === "team" ? "teams" : scope.scopeType === "user" ? "user_controls" : "api_keys";
  const rows = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, scope.scopeId);
  if (rows.length !== 1) throw new RelayError("scope_not_found", `Scope ${scopeRef} not found`, 404);
}

async function lockRoutingGraph(transaction: Prisma.TransactionClient): Promise<void> {
  // Routing validity is a graph-wide invariant: two changes in different
  // scopes must not both validate against the same stale graph and commit a
  // cycle. A transaction-scoped lock serializes only Model Access routing
  // writes and adds no persisted lock/quota state.
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('friday-relay:model-access-routing-graph', 0))`;
}

async function lockAccessPoint(transaction: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "access_points" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new RelayError("access_point_not_found", `AccessPoint ${id} not found`, 404);
}

function legacyTargetProjection(target: {
  type: "provider-model" | "access-point";
  targetAccessPointId: string | null;
  targetProviderId: string | null;
  targetProviderModelName: string | null;
}) {
  return {
    legacyTargetType: target.type,
    legacyTargetId: target.type === "access-point" ? target.targetAccessPointId : null,
    legacyTargetProviderId: target.type === "provider-model" ? target.targetProviderId : null,
    legacyTargetProviderModelName: target.type === "provider-model" ? target.targetProviderModelName : null,
  };
}

function domainTarget(target: AccessPointTarget) {
  return {
    id: target.id, type: target.targetType, targetAccessPointId: target.targetAccessPointId,
    targetProviderId: target.targetProviderId, targetProviderModelName: target.targetProviderModelName,
    targetProviderModelId: target.targetProviderModelId,
    position: target.position, status: target.status, removedAt: target.removedAt,
  };
}

function stableProviderModelId(
  target: Pick<NormalizedRoutingDefinition["targets"][number], "type" | "targetProviderId" | "targetProviderModelName">,
  providerModelIds: ReadonlyMap<string, string>,
): string | null {
  if (target.type !== "provider-model") return null;
  const id = providerModelIds.get(providerModelIdentityKey(target.targetProviderId!, target.targetProviderModelName!));
  if (!id) throw new RelayError("provider_model_reference_missing", "ProviderModel stable reference was not resolved", 500);
  return id;
}

function providerModelIdentityKey(providerId: string, providerModelName: string): string {
  return `${providerId}\u0000${providerModelName}`;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { throw new RelayError("invalid_access_point_routing_rule", "Stored routing config is invalid", 500); }
}

function requiredTrimmed(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RelayError("invalid_access_point", `${name} is required`, 400);
  return value.trim();
}

function integerOrDefault(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved)) throw new RelayError("invalid_access_point", `${name} must be an integer`, 400);
  return resolved;
}

function requireScopeRef(value: string): ScopeRef {
  if (!isRuntimeScopeRef(value)) throw new RelayError("invalid_scope_ref", `Invalid scope_ref: ${value}`, 400);
  return value;
}
