import {
  createId,
  isRuntimeScopeRef,
  nowIso,
  RelayError,
  type ScopeRef,
} from "@frely/core";
import { Prisma, type PrismaTransactionOwner } from "@frely/postgres/server";
import type { ModelAccessAuditAppender } from "./audit-contract.js";
import type {
  BeginProviderBindingTransitionCommand,
  ChangeProviderModelCommand,
  CompleteProviderBindingTransitionCommand,
  ModelAccessAuditInput,
  ProviderBindingTransitionView,
  ProviderCatalogObservationResult,
  ProviderDefinitionCommand,
  ProviderManagementView,
  ProviderModelManagementView,
} from "./public-contracts.js";

const PROVIDER_ID_PATTERN = /^prv_[0-9a-f]{24}$/u;
const PROVIDER_ID_INSERT_ATTEMPTS = 8;
const PROVIDER_MODEL_OBSERVATION_LIMIT = 8192;
const PROVIDER_BINDING_TRANSITION_CODE = "provider_binding_transition_in_progress";
const PROVIDER_BINDING_TRANSITION_RECOVERY_MS = 16 * 60_000;

export type {
  BeginProviderBindingTransitionCommand,
  ChangeProviderModelCommand,
  CompleteProviderBindingTransitionCommand,
  ProviderBindingTransitionView,
  ProviderCatalogObservationResult,
  ProviderDefinitionCommand,
} from "./public-contracts.js";

export class ProviderManagementCommandService {
  constructor(
    private readonly transactions: PrismaTransactionOwner,
    private readonly auditAppender: ModelAccessAuditAppender,
  ) {}

  async createProvider(command: ProviderDefinitionCommand, audit: ModelAccessAuditInput): Promise<ProviderManagementView> {
    let id = requireGeneratedProviderId(command.id);
    for (let attempt = 0; attempt < PROVIDER_ID_INSERT_ATTEMPTS; attempt += 1) {
      try {
        return await this.transactions.withPrismaTransaction((transaction) => createProvider(
          transaction,
          { ...command, id },
          audit,
          this.auditAppender,
        ));
      } catch (error) {
        if (!isUniqueCollision(error) || attempt + 1 >= PROVIDER_ID_INSERT_ATTEMPTS) {
          if (isUniqueCollision(error)) {
            throw new RelayError("provider_id_generation_failed", "Provider ID could not be generated", 503);
          }
          throw error;
        }
        id = requireGeneratedProviderId(createId("prv"));
      }
    }
    throw new RelayError("provider_id_generation_failed", "Provider ID could not be generated", 503);
  }

  changeProvider(id: string, command: ProviderDefinitionCommand, audit: ModelAccessAuditInput): Promise<ProviderManagementView> {
    return this.transactions.withPrismaTransaction((transaction) => changeProvider(
      transaction,
      id,
      command,
      audit,
      this.auditAppender,
    ));
  }

  changeProviderStatus(id: string, status: "enabled" | "disabled", audit: ModelAccessAuditInput): Promise<ProviderManagementView> {
    return this.transactions.withPrismaTransaction((transaction) => changeProviderStatus(
      transaction,
      id,
      status,
      audit,
      this.auditAppender,
    ));
  }

  registerProviderModel(
    providerId: string,
    providerModelName: string,
    displayName: string,
    audit: ModelAccessAuditInput,
  ): Promise<ProviderModelManagementView> {
    return this.transactions.withPrismaTransaction((transaction) => registerProviderModel(
      transaction,
      providerId,
      providerModelName,
      displayName,
      audit,
      this.auditAppender,
    ));
  }

  changeProviderModel(
    providerId: string,
    providerModelName: string,
    command: ChangeProviderModelCommand,
    audit: ModelAccessAuditInput,
  ): Promise<ProviderModelManagementView> {
    return this.transactions.withPrismaTransaction((transaction) => changeProviderModel(
      transaction,
      providerId,
      providerModelName,
      command,
      audit,
      this.auditAppender,
    ));
  }

  applyProviderCatalogObservation(
    providerId: string,
    modelNames: readonly string[],
    audit: ModelAccessAuditInput,
  ): Promise<ProviderCatalogObservationResult> {
    return this.transactions.withPrismaTransaction((transaction) => applyProviderCatalogObservation(
      transaction,
      providerId,
      modelNames,
      audit,
      this.auditAppender,
    ));
  }

  beginProviderBindingTransition(
    providerId: string,
    options: BeginProviderBindingTransitionCommand,
  ): Promise<ProviderBindingTransitionView> {
    return this.transactions.withPrismaTransaction((transaction) => beginProviderBindingTransition(
      transaction,
      providerId,
      options,
      this.auditAppender,
    ));
  }

  completeProviderBindingTransition(
    providerId: string,
    expectedRevision: number,
    command: CompleteProviderBindingTransitionCommand,
  ): Promise<ProviderBindingTransitionView> {
    return this.transactions.withPrismaTransaction((transaction) => completeProviderBindingTransition(
      transaction,
      providerId,
      expectedRevision,
      command,
    ));
  }

  removeProvider(id: string, audit: ModelAccessAuditInput): Promise<{ id: string; deleted: true }> {
    return this.transactions.withPrismaTransaction((transaction) => removeProvider(
      transaction,
      id,
      audit,
      this.auditAppender,
    ));
  }
}

export async function createProvider(
  transaction: Prisma.TransactionClient,
  command: ProviderDefinitionCommand,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<ProviderManagementView> {
  const definition = normalizeProviderDefinition(command);
  if (definition.status !== "disabled") {
    throw new RelayError("provider_create_must_be_disabled", "New Provider must be created disabled", 409);
  }
  await requireAssignableCpaInstance(transaction, definition.cpaInstanceId);
  const now = nowIso();
  const row = await transaction.providers.create({ data: {
    id: definition.id,
    owner_id: definition.ownerId,
    scope_ref: definition.scopeRef,
    name: definition.name,
    kind: definition.kind,
    status: "disabled",
    base_url_resolver: definition.baseUrlResolver,
    credential_resolver: definition.credentialResolver,
    models_resolver: definition.modelsResolver,
    config_json: definition.configJson,
    cpa_instance_id: definition.cpaInstanceId,
    created_at: now,
    updated_at: now,
    provider_bindings: { create: {
      auth_method: requiredTrimmed(definition.authMethod, "authMethod"),
      credential_ownership: "cpa-managed",
      credential_refs_json: "[]",
      credential_preview: null,
      revision: 1,
      sync_status: "pending",
      error_code: null,
      created_at: now,
      updated_at: now,
    } },
  } });
  await auditAppender.append(transaction, {
    ...audit,
    action: "provider.create",
    resourceType: "provider",
    resourceId: row.id,
    result: "success",
    metadata: providerAuditMetadata(row),
  });
  return providerView(row);
}

export async function createPersonalCodexProvider(
  transaction: Prisma.TransactionClient,
  input: Readonly<{ id: string; slotId: string; userId: string; name: string; providerId: string | null; lifecycle: "active" }>,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<ProviderManagementView> {
  if (input.providerId) throw new RelayError("provider_slot_occupied", "Personal Provider slot already has a Provider", 409);
  if (audit.actor.actorType !== "user" || audit.actor.actorId !== input.userId) throw new RelayError("provider_slot_actor_forbidden", "Personal Provider slot belongs to another user", 403);
  return createProvider(transaction, {
    id: input.id,
    ownerId: input.userId,
    scopeRef: `user:${input.userId}`,
    name: requiredTrimmed(input.name, "name"),
    kind: "codex",
    status: "disabled",
    baseUrlResolver: "literal:",
    credentialResolver: "oauth:",
    modelsResolver: "cliproxyapi:catalog",
    configJson: "{}",
    cpaInstanceId: "cpa_default",
    authMethod: "oauth",
  }, audit, auditAppender);
}

export async function getPersonalCodexProvider(
  transaction: Prisma.TransactionClient,
  providerId: string,
  userId: string,
): Promise<ProviderManagementView> {
  const provider = await transaction.providers.findUnique({ where: { id: providerId }, include: { provider_bindings: true } });
  if (!provider || provider.owner_id !== userId) throw new RelayError("provider_not_found", "Personal Provider not found", 404);
  assertPersonalProviderDefinition(provider, userId);
  return providerView(provider);
}

export async function changeProvider(
  transaction: Prisma.TransactionClient,
  id: string,
  command: ProviderDefinitionCommand,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<ProviderManagementView> {
  await lockProvider(transaction, id);
  const existing = await transaction.providers.findUnique({ where: { id }, include: { provider_bindings: true } });
  if (!existing) throw new RelayError("provider_not_found", `Provider ${id} not found`, 404);
  const definition = normalizeProviderDefinition({ ...command, id });
  if (definition.ownerId !== existing.owner_id) throw new RelayError("provider_owner_immutable", "Provider owner cannot change", 409);
  const personalSlot = await transaction.user_provider_slots.findUnique({ where: { provider_id: id } });
  if (personalSlot) {
    assertPersonalProviderDefinition(existing, personalSlot.user_id);
    if (definition.ownerId !== existing.owner_id || definition.scopeRef !== existing.scope_ref || definition.kind !== existing.kind
      || definition.baseUrlResolver !== existing.base_url_resolver || definition.credentialResolver !== existing.credential_resolver
      || definition.modelsResolver !== existing.models_resolver || definition.configJson !== existing.config_json
      || definition.cpaInstanceId !== existing.cpa_instance_id || definition.authMethod !== existing.provider_bindings?.auth_method) {
      throw new RelayError("personal_provider_definition_immutable", "Personal Provider owner, scope, Codex OAuth, CPA, resolver, and configuration fields are server-managed", 409);
    }
  }
  await requireAssignableCpaInstance(transaction, definition.cpaInstanceId, existing.cpa_instance_id, existing.provider_bindings?.sync_status);
  if (existing.provider_bindings?.error_code === PROVIDER_BINDING_TRANSITION_CODE) {
    throw new RelayError("provider_binding_transition_in_progress", "Provider binding operation is still in progress", 409);
  }
  const materialChanged = existing.kind !== definition.kind
    || existing.config_json !== definition.configJson
    || existing.provider_bindings?.auth_method !== definition.authMethod;
  const status = materialChanged ? "disabled" : definition.status;
  if (status === "enabled") await requireProviderReady(transaction, id);
  const now = nowIso();
  const row = await transaction.providers.update({ where: { id }, data: {
    scope_ref: definition.scopeRef,
    name: definition.name,
    kind: definition.kind,
    status,
    base_url_resolver: definition.baseUrlResolver,
    credential_resolver: definition.credentialResolver,
    models_resolver: definition.modelsResolver,
    config_json: definition.configJson,
    cpa_instance_id: definition.cpaInstanceId,
    updated_at: now,
  } });
  const currentBinding = existing.provider_bindings;
  await transaction.provider_bindings.upsert({
    where: { provider_id: id },
    create: {
      provider_id: id,
      auth_method: definition.authMethod,
      credential_ownership: "cpa-managed",
      credential_refs_json: "[]",
      credential_preview: null,
      revision: 1,
      sync_status: "pending",
      error_code: null,
      created_at: now,
      updated_at: now,
    },
    update: materialChanged ? {
      auth_method: definition.authMethod,
      credential_ownership: "cpa-managed",
      credential_refs_json: "[]",
      credential_preview: null,
      revision: (currentBinding?.revision ?? 0) + 1,
      sync_status: "pending",
      error_code: null,
      updated_at: now,
    } : {
      auth_method: definition.authMethod,
      credential_ownership: "cpa-managed",
      updated_at: now,
    },
  });
  await auditAppender.append(transaction, {
    ...audit,
    action: "provider.update",
    resourceType: "provider",
    resourceId: id,
    result: "success",
    metadata: { ...providerAuditMetadata(row), materialChanged },
  });
  return providerView(row);
}

export async function changeProviderStatus(
  transaction: Prisma.TransactionClient,
  id: string,
  status: "enabled" | "disabled",
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<ProviderManagementView> {
  await lockProvider(transaction, id);
  const existing = await transaction.providers.findUnique({ where: { id }, include: { provider_bindings: true } });
  if (!existing) throw new RelayError("provider_not_found", `Provider ${id} not found`, 404);
  const personalSlot = await transaction.user_provider_slots.findUnique({ where: { provider_id: id } });
  if (personalSlot) assertPersonalProviderDefinition(existing, personalSlot.user_id);
  if (status === "enabled") await requireProviderReady(transaction, id);
  const row = existing.status === status ? existing : await transaction.providers.update({
    where: { id },
    data: { status, updated_at: nowIso() },
  });
  await auditAppender.append(transaction, {
    ...audit,
    action: "provider.update",
    resourceType: "provider",
    resourceId: id,
    result: "success",
    metadata: {
      providerId: id,
      status: auditProviderStatus(row.status),
      statusChanged: existing.status !== row.status,
    },
  });
  return providerView(row);
}

export async function registerProviderModel(
  transaction: Prisma.TransactionClient,
  providerId: string,
  providerModelName: string,
  displayName: string,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<ProviderModelManagementView> {
  await lockProvider(transaction, providerId);
  await requireProvider(transaction, providerId);
  const modelName = requiredTrimmed(providerModelName, "providerModelName");
  const prior = await uniqueProviderModel(transaction, providerId, modelName);
  if (prior) return providerModelView(prior);
  const now = nowIso();
  const row = await transaction.provider_models.create({ data: {
    id: createId("provider_model"),
    provider_id: providerId,
    provider_model_name: modelName,
    display_name: requiredTrimmed(displayName, "displayName"),
    status: "disabled",
    created_at: now,
    updated_at: now,
  } });
  await appendProviderModelAudit(auditAppender, transaction, audit, row, false);
  return providerModelView(row);
}

export async function changeProviderModel(
  transaction: Prisma.TransactionClient,
  providerId: string,
  providerModelName: string,
  command: ChangeProviderModelCommand,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<ProviderModelManagementView> {
  await lockProvider(transaction, providerId);
  await requireProvider(transaction, providerId);
  const modelName = requiredTrimmed(providerModelName, "providerModelName");
  const existing = await uniqueProviderModel(transaction, providerId, modelName);
  if (!existing) throw new RelayError("provider_model_not_found", `Provider model ${providerId}/${modelName} not found`, 404);
  const status = command.status ?? existing.status;
  if (status !== "enabled" && status !== "disabled") throw new RelayError("invalid_provider_model_status", "ProviderModel status must be enabled or disabled", 400);
  const displayName = command.displayName === undefined ? existing.display_name : requiredTrimmed(command.displayName, "displayName");
  const changed = status !== existing.status || displayName !== existing.display_name;
  const row = changed ? await transaction.provider_models.update({
    where: { id: existing.id },
    data: { status, display_name: displayName, updated_at: nowIso() },
  }) : existing;
  await appendProviderModelAudit(auditAppender, transaction, audit, row, changed);
  return providerModelView(row);
}

export async function applyProviderCatalogObservation(
  transaction: Prisma.TransactionClient,
  providerId: string,
  modelNames: readonly string[],
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<ProviderCatalogObservationResult> {
  await lockProvider(transaction, providerId);
  await requireProvider(transaction, providerId);
  if (modelNames.length > PROVIDER_MODEL_OBSERVATION_LIMIT) {
    throw new RelayError("provider_catalog_too_large", "Provider catalog observation exceeds the supported limit", 400);
  }
  const normalized = [...new Set(modelNames.map((name) => requiredTrimmed(name, "providerModelName")))].sort();
  const items: ProviderModelManagementView[] = [];
  let created = 0;
  for (const modelName of normalized) {
    const existing = await uniqueProviderModel(transaction, providerId, modelName);
    if (existing) {
      items.push(providerModelView(existing));
      continue;
    }
    const now = nowIso();
    const row = await transaction.provider_models.create({ data: {
      id: createId("provider_model"),
      provider_id: providerId,
      provider_model_name: modelName,
      display_name: modelName,
      status: "disabled",
      created_at: now,
      updated_at: now,
    } });
    created += 1;
    items.push(providerModelView(row));
  }
  await auditAppender.append(transaction, {
    ...audit,
    action: "provider_model.sync",
    resourceType: "provider",
    resourceId: providerId,
    result: "success",
    metadata: { providerId, observed: normalized.length, created },
  });
  return { providerId, observed: normalized.length, created, items };
}

export async function beginProviderBindingTransition(
  transaction: Prisma.TransactionClient,
  providerId: string,
  options: BeginProviderBindingTransitionCommand,
  auditAppender: ModelAccessAuditAppender,
): Promise<ProviderBindingTransitionView> {
  await lockProvider(transaction, providerId);
  const provider = await transaction.providers.findUnique({ where: { id: providerId } });
  if (!provider) throw new RelayError("provider_not_found", `Provider ${providerId} not found`, 404);
  const binding = await transaction.provider_bindings.findUnique({ where: { provider_id: providerId } });
  if (!binding) throw new RelayError("cliproxy_binding_not_found", "CLIProxyAPI Provider binding is missing", 409);
  if (binding.revision !== options.expectedRevision
    || binding.auth_method !== options.expectedAuthMethod
    || binding.sync_status !== options.expectedSyncStatus
    || binding.error_code !== options.expectedErrorCode
    || binding.updated_at !== options.expectedBindingUpdatedAt
    || provider.updated_at !== options.expectedProviderUpdatedAt) {
    throw new RelayError("provider_binding_revision_conflict", "Provider or binding changed before the external operation started", 409, { revision: binding.revision });
  }
  if (binding.error_code === PROVIDER_BINDING_TRANSITION_CODE) {
    const updatedAt = Date.parse(binding.updated_at);
    const stale = Number.isFinite(updatedAt) && Date.now() - updatedAt >= PROVIDER_BINDING_TRANSITION_RECOVERY_MS;
    if (!options.allowStaleRecovery || !stale) {
      throw new RelayError("provider_binding_transition_in_progress", "Provider binding operation is still in progress", 409, { revision: binding.revision });
    }
  }
  const now = nowIso();
  if (options.disableProvider && provider.status !== "disabled") {
    const disabled = await transaction.providers.update({ where: { id: providerId }, data: { status: "disabled", updated_at: now } });
    if (!options.audit) throw new Error("provider_binding_transition_audit_required");
    await auditAppender.append(transaction, {
      ...options.audit,
      action: "provider.update",
      resourceType: "provider",
      resourceId: providerId,
      result: "success",
      metadata: {
        providerId,
        status: auditProviderStatus(disabled.status),
        statusChanged: true,
        reason: "credential_transition",
      },
    });
  }
  const pending = await transaction.provider_bindings.update({ where: { provider_id: providerId }, data: {
    revision: binding.revision + 1,
    sync_status: "error",
    error_code: PROVIDER_BINDING_TRANSITION_CODE,
    updated_at: now,
  } });
  return providerBindingTransitionView(pending, binding.sync_status);
}

export async function completeProviderBindingTransition(
  transaction: Prisma.TransactionClient,
  providerId: string,
  expectedRevision: number,
  command: CompleteProviderBindingTransitionCommand,
): Promise<ProviderBindingTransitionView> {
  await lockProvider(transaction, providerId);
  const binding = await transaction.provider_bindings.findUnique({ where: { provider_id: providerId } });
  if (!binding) throw new RelayError("cliproxy_binding_not_found", "CLIProxyAPI Provider binding is missing", 409);
  if (binding.revision !== expectedRevision
    || binding.sync_status !== "error"
    || binding.error_code !== PROVIDER_BINDING_TRANSITION_CODE) {
    throw new RelayError("provider_binding_revision_conflict", "Provider binding changed while the external operation was in progress", 409, { revision: binding.revision });
  }
  const completed = await transaction.provider_bindings.update({ where: { provider_id: providerId }, data: {
    ...(command.credentialRefsJson === undefined ? {} : { credential_refs_json: command.credentialRefsJson }),
    ...(command.credentialPreview === undefined ? {} : { credential_preview: command.credentialPreview }),
    sync_status: command.syncStatus,
    error_code: command.errorCode ?? null,
    updated_at: nowIso(),
  } });
  return providerBindingTransitionView(completed, binding.sync_status);
}

export async function removeProvider(
  transaction: Prisma.TransactionClient,
  id: string,
  audit: ModelAccessAuditInput,
  auditAppender: ModelAccessAuditAppender,
): Promise<{ id: string; deleted: true }> {
  await lockProvider(transaction, id);
  const provider = await transaction.providers.findUnique({ where: { id }, include: { provider_bindings: true } });
  if (!provider) throw new RelayError("provider_not_found", `Provider ${id} not found`, 404);
  if (await transaction.user_provider_slots.findUnique({ where: { provider_id: id }, select: { id: true } })) {
    throw new RelayError("personal_provider_retirement_not_implemented", "Slot-bound personal Provider retirement and replacement are not implemented", 409);
  }
  if (provider.status !== "disabled") throw new RelayError("provider_must_be_disabled", `Provider ${id} must be disabled before deletion`, 409);
  const accessPointReference = await transaction.accessPointTarget.findFirst({
    where: { targetProviderId: id, targetType: "provider-model" },
    select: { id: true },
  });
  if (accessPointReference) throw new RelayError("provider_in_use", `Provider ${id} is used by an AccessPoint`, 409);
  const billingHistory = await transaction.billing_provider_cost_events.findFirst({
    where: { provider_id: id },
    select: { id: true },
  });
  if (billingHistory) throw new RelayError("provider_history_retained", `Provider ${id} is retained by online billing history`, 409);
  const binding = provider.provider_bindings;
  const credentialCleared = !binding || (
    binding.credential_refs_json === "[]"
    && binding.credential_preview === null
    && binding.error_code === null
    && binding.sync_status === "cleared"
  );
  if (!credentialCleared) throw new RelayError("provider_credential_not_cleared", `Provider ${id} credential must be cleared before deletion`, 409);
  await transaction.provider_models.deleteMany({ where: { provider_id: id } });
  await transaction.provider_bindings.deleteMany({ where: { provider_id: id } });
  await transaction.providers.delete({ where: { id } });
  await auditAppender.append(transaction, {
    ...audit,
    action: "provider.delete",
    resourceType: "provider",
    resourceId: id,
    result: "success",
    metadata: { providerId: id, deleted: true },
  });
  return { id, deleted: true };
}

function assertPersonalProviderDefinition(provider: {
  owner_id: string; scope_ref: string; kind: string; base_url_resolver: string; credential_resolver: string;
  models_resolver: string; config_json: string; cpa_instance_id: string;
  provider_bindings?: { auth_method: string; credential_ownership: string } | null;
}, userId: string): void {
  if (provider.owner_id !== userId || provider.scope_ref !== `user:${userId}` || provider.kind !== "codex"
    || provider.base_url_resolver !== "literal:" || provider.credential_resolver !== "oauth:"
    || provider.models_resolver !== "cliproxyapi:catalog" || provider.config_json !== "{}"
    || provider.cpa_instance_id !== "cpa_default" || provider.provider_bindings?.auth_method !== "oauth"
    || provider.provider_bindings.credential_ownership !== "cpa-managed") {
    throw new RelayError("personal_provider_definition_invalid", "Personal Provider does not satisfy the fixed server-managed Codex OAuth definition", 409);
  }
}

function normalizeProviderDefinition(command: ProviderDefinitionCommand): ProviderDefinitionCommand {
  const status = command.status;
  if (status !== "enabled" && status !== "disabled") throw new RelayError("invalid_provider_status", "Provider status must be enabled or disabled", 400);
  const scopeRef = requiredTrimmed(command.scopeRef, "scopeRef");
  if (!isRuntimeScopeRef(scopeRef)) throw new RelayError("invalid_scope_ref", "Provider scope must be a runtime scope", 400);
  return {
    id: requireGeneratedProviderId(command.id),
    ownerId: requiredTrimmed(command.ownerId, "ownerId"),
    scopeRef,
    name: requiredTrimmed(command.name, "name"),
    kind: requiredTrimmed(command.kind, "kind"),
    status,
    baseUrlResolver: requiredTrimmed(command.baseUrlResolver, "baseUrlResolver"),
    credentialResolver: requiredTrimmed(command.credentialResolver, "credentialResolver"),
    modelsResolver: requiredTrimmed(command.modelsResolver, "modelsResolver"),
    configJson: requiredTrimmed(command.configJson, "configJson"),
    cpaInstanceId: requiredTrimmed(command.cpaInstanceId, "cpaInstanceId"),
    authMethod: requiredTrimmed(command.authMethod, "authMethod"),
  };
}

async function requireAssignableCpaInstance(
  transaction: Prisma.TransactionClient,
  cpaInstanceId: string,
  currentCpaInstanceId?: string,
  currentBindingStatus?: string,
): Promise<void> {
  const cpa = await transaction.cpa_instances.findUnique({ where: { id: cpaInstanceId } });
  if (!cpa) throw new RelayError("cpa_instance_not_found", "CPA Instance is not registered", 409);
  if (currentCpaInstanceId && currentCpaInstanceId !== cpaInstanceId && currentBindingStatus !== "cleared") {
    throw new RelayError("cpa_instance_immutable", "Provider CPA Instance cannot change after credential lifecycle starts", 409);
  }
  if (cpa.status !== "enabled" && currentCpaInstanceId !== cpaInstanceId) {
    throw new RelayError("cpa_instance_disabled", "CPA Instance is disabled", 409);
  }
}

async function requireProviderReady(transaction: Prisma.TransactionClient, providerId: string): Promise<void> {
  const binding = await transaction.provider_bindings.findUnique({ where: { provider_id: providerId } });
  const models = await transaction.provider_models.findMany({
    where: { provider_id: providerId },
    select: { id: true, provider_id: true, provider_model_name: true, status: true },
    orderBy: [{ provider_model_name: "asc" }, { id: "asc" }],
  });
  assertProviderModelRowsUnique(models);
  if (!binding || binding.sync_status !== "ready" || !models.some((model) => model.status === "enabled")) {
    throw new RelayError("cliproxy_provider_not_ready", "CLIProxyAPI Provider needs a ready binding and an enabled model before it can be enabled", 409);
  }
}

async function requireProvider(transaction: Prisma.TransactionClient, providerId: string) {
  const provider = await transaction.providers.findUnique({ where: { id: providerId } });
  if (!provider) throw new RelayError("provider_not_found", `Provider ${providerId} not found`, 404);
  return provider;
}

function assertProviderModelRowsUnique(rows: Array<{ id: string; provider_id: string; provider_model_name: string }>): void {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.provider_id}\u0000${row.provider_model_name}`;
    if (keys.has(key)) {
      throw new RelayError("provider_model_identity_ambiguous", `Provider model ${row.provider_id}/${row.provider_model_name} has duplicate identities`, 409);
    }
    keys.add(key);
  }
}

async function uniqueProviderModel(transaction: Prisma.TransactionClient, providerId: string, providerModelName: string) {
  return await transaction.provider_models.findUnique({
    where: { provider_id_provider_model_name: {
      provider_id: providerId,
      provider_model_name: providerModelName,
    } },
  });
}

async function lockProvider(transaction: Prisma.TransactionClient, providerId: string): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "providers" WHERE "id" = ${providerId} FOR UPDATE`;
  if (rows.length === 0) throw new RelayError("provider_not_found", `Provider ${providerId} not found`, 404);
}

async function appendProviderModelAudit(
  auditAppender: ModelAccessAuditAppender,
  transaction: Prisma.TransactionClient,
  audit: ModelAccessAuditInput,
  row: { id: string; provider_id: string; provider_model_name: string; display_name: string; status: string },
  changed: boolean,
): Promise<void> {
  await auditAppender.append(transaction, {
    ...audit,
    action: "provider_model.upsert",
    resourceType: "provider_model",
    resourceId: row.id,
    result: "success",
    metadata: {
      providerId: row.provider_id,
      providerModelId: row.id,
      status: auditProviderStatus(row.status),
      changed,
    },
  });
}

function providerBindingTransitionView(row: {
  provider_id: string;
  auth_method: string;
  credential_ownership: string;
  credential_refs_json: string;
  credential_preview: string | null;
  revision: number;
  sync_status: string;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}, previousSyncStatus: string): ProviderBindingTransitionView {
  return {
    providerId: row.provider_id,
    authMethod: row.auth_method as ProviderBindingTransitionView["authMethod"],
    credentialOwnership: row.credential_ownership as ProviderBindingTransitionView["credentialOwnership"],
    credentialRefsJson: row.credential_refs_json,
    credentialPreview: row.credential_preview,
    revision: row.revision,
    syncStatus: row.sync_status as ProviderBindingTransitionView["syncStatus"],
    previousSyncStatus: previousSyncStatus as ProviderBindingTransitionView["previousSyncStatus"],
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerAuditMetadata(row: {
  id: string;
  owner_id: string;
  scope_ref: string;
  kind: string;
  status: string;
  base_url_resolver: string;
  credential_resolver: string;
  models_resolver: string;
}) {
  return {
    providerId: row.id,
    ownerId: row.owner_id,
    scopeRef: row.scope_ref,
    kind: row.kind,
    status: auditProviderStatus(row.status),
    baseUrlResolverName: auditResolverName(row.base_url_resolver),
    credentialResolverName: auditResolverName(row.credential_resolver),
    modelsResolverName: auditResolverName(row.models_resolver),
  };
}

function auditResolverName(value: string): string {
  const separator = value.indexOf(":");
  const candidate = separator < 0 ? value : value.slice(0, separator);
  return /^[a-z][a-z0-9-]{0,63}$/u.test(candidate) ? candidate : "unknown";
}

function auditProviderStatus(value: string): "enabled" | "disabled" {
  if (value !== "enabled" && value !== "disabled") throw new Error("provider_audit_status_invalid");
  return value;
}

function providerView(row: {
  id: string;
  owner_id: string;
  scope_ref: string;
  name: string;
  kind: string;
  status: string;
  base_url_resolver: string;
  credential_resolver: string;
  models_resolver: string;
  config_json: string;
  cpa_instance_id: string;
  created_at: string;
  updated_at: string;
}): ProviderManagementView {
  return {
    id: row.id,
    ownerId: row.owner_id,
    scopeRef: row.scope_ref as ScopeRef,
    name: row.name,
    kind: row.kind,
    status: row.status,
    baseUrlResolver: row.base_url_resolver,
    credentialResolver: row.credential_resolver,
    modelsResolver: row.models_resolver,
    configJson: row.config_json,
    cpaInstanceId: row.cpa_instance_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerModelView(row: {
  id: string;
  provider_id: string;
  provider_model_name: string;
  display_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}): ProviderModelManagementView {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerModelName: row.provider_model_name,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requiredTrimmed(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new RelayError("invalid_provider", `${field} is required`, 400);
  return text;
}

function requireGeneratedProviderId(value: string): string {
  if (!PROVIDER_ID_PATTERN.test(value)) {
    throw new RelayError("provider_id_generation_failed", "Provider ID generator returned an invalid ID", 503);
  }
  return value;
}

function isUniqueCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
