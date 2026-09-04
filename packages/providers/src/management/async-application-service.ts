import { existsSync } from "node:fs";
import type { AuditCommands } from "@frely/audit";
import { assertProviderBaseUrl, RelayError, type ScopeRef } from "@frely/core";
import type { ChangeProviderModelCommand, ModelAccessManagementQueryService, ProviderBindingTransitionView, ProviderManagementCommandService, ProviderManagementView } from "@frely/model-access/server";
import { assertSafeProviderConfigInput, sanitizeProvider } from "../provider-credentials.js";
import {
  auditFailureAsync,
  auditSuccessAsync,
  DEFAULT_CPA_INSTANCE_ID,
  type AuditActor,
  type AuditSource,
  type ApplicationCommands,
  type ApplicationQueries,
  type Provider,
  type ProviderBinding,
} from "@frely/application/runtime";
import { CliProxyControlClient, isConfirmedCliProxyCredentialFailureCode, type CliProxyControlCredentialSummary, type CliProxyControlModelMapping, type CliProxyControlReconciliationSummary } from "../cliproxy/control-client.js";
import { assertCliProxyKindAuthMethod, type CliProxyAuthMethod } from "../cliproxy/provider-kinds.js";
import { cliProxyCredentialResolver, safeProviderBinding, validateCliProxyProviderDefinition } from "./cliproxy-binding-control.js";
import { generateProviderId } from "./provider-id.js";

export interface AsyncProviderManagementContext {
  actor: AuditActor;
  source: AuditSource;
  requestId?: string | null;
  fixedScopeRef?: ScopeRef;
  privateProviderOrigin?: string | undefined;
}

export interface ProviderBindingRefreshInput {
  providerId: string;
  expectedRevision: number;
}

export interface ProviderBindingRefreshResult {
  providerId: string;
  result: "ready" | "error" | "transient" | "conflict" | "skipped";
  syncStatus: ProviderBinding["syncStatus"] | null;
  errorCode: string | null;
}

/**
 * Keeps external CLIProxyAPI calls outside database transactions and persists
 * only the resulting binding state through separate Application Queries and Commands.
 */
export class AsyncProviderManagementService {
  private readonly applicationQueries: ApplicationQueries;
  private readonly applicationCommands: ApplicationCommands;
  private readonly commands: ProviderManagementCommandService;
  private readonly queries: ModelAccessManagementQueryService;

  constructor(
    applicationQueries: ApplicationQueries,
    applicationCommands: ApplicationCommands,
    commands: ProviderManagementCommandService,
    queries: ModelAccessManagementQueryService,
    private readonly audit: Pick<AuditCommands, "record">,
  ) {
    this.applicationQueries = applicationQueries;
    this.applicationCommands = applicationCommands;
    this.commands = commands;
    this.queries = queries;
  }

  async mutate(method: "POST" | "PATCH", body: Record<string, unknown>, context: AsyncProviderManagementContext) {
    if (method === "POST" && Object.prototype.hasOwnProperty.call(body, "id")) throw new RelayError("provider_id_server_generated", "Provider ID is assigned by the server", 400);
    if (context.fixedScopeRef && (Object.prototype.hasOwnProperty.call(body, "ownerId") || Object.prototype.hasOwnProperty.call(body, "scopeRef"))) {
      throw new RelayError("provider_scope_server_managed", "Provider owner and Team scope are assigned by the server", 400);
    }
    if (context.fixedScopeRef && Object.prototype.hasOwnProperty.call(body, "cpaInstanceId")) {
      throw new RelayError("provider_cpa_instance_server_managed", "Provider CPA Instance is assigned by the server", 400);
    }
    const id = method === "POST" ? generateProviderId() : String(body.id ?? "").trim();
    const existing = method === "PATCH" ? await this.queries.getProvider(id) : undefined;
    const name = String(body.name ?? existing?.name ?? "").trim();
    const kind = String(body.kind ?? existing?.kind ?? "").trim();
    if (!id || !name || !kind) throw new RelayError("invalid_provider", "Provider id, name, and kind are required", 400);
    if (method === "PATCH" && !existing) throw new RelayError("provider_not_found", `Provider ${id} not found`, 404);
    if (context.fixedScopeRef && existing && existing.scopeRef !== context.fixedScopeRef) throw new RelayError("provider_scope_forbidden", "Provider is not managed by this Team", 403);

    const currentBinding = await this.applicationQueries.getProviderBinding(id);
    const authMethod = String(body.authMethod ?? currentBinding?.authMethod ?? "").trim() as CliProxyAuthMethod;
    const validated = validateCliProxyProviderDefinition({
      id,
      kind,
      authMethod,
      credentialResolver: cliProxyCredentialResolver(authMethod),
      modelsResolver: "cliproxyapi:catalog",
      baseUrlResolver: "literal:",
      configJson: JSON.stringify(providerConfigInput(body.config ?? parseExistingConfig(existing?.configJson))),
    });
    if (!validated) throw new RelayError("cliproxy_provider_config_invalid", "CLIProxyAPI Provider definition is invalid", 400);
    const publicConfig = parsePublicConfig(validated.configJson);
    const e2eAllowedBaseUrl = existsSync("/app/.friday-relay-e2e-runtime") ? process.env.CLIPROXY_CONTROL_E2E_ALLOWED_BASE_URL : undefined;
    if (publicConfig.baseUrl && !isExactE2eBaseUrl(publicConfig.baseUrl, e2eAllowedBaseUrl)) {
      await assertProviderBaseUrl(publicConfig.baseUrl, { privateOrigin: context.privateProviderOrigin });
    }

    const status = String(body.status ?? (existing ? existing.status : "disabled")) as "enabled" | "disabled";
    if (status === "enabled") {
      if (!currentBinding || currentBinding.syncStatus !== "ready" || !await this.queries.hasEnabledProviderModel(id)) {
        throw new RelayError("cliproxy_provider_not_ready", "CLIProxyAPI Provider needs a ready binding and an enabled model before it can be enabled", 409);
      }
    }
    const providerInput = {
      id,
      ownerId: existing?.ownerId ?? (context.fixedScopeRef ? context.actor.actorId : String(body.ownerId ?? context.actor.actorId)),
      scopeRef: (context.fixedScopeRef ?? String(body.scopeRef ?? existing?.scopeRef ?? `user:${context.actor.actorId}`)) as ScopeRef,
      name,
      kind,
      status,
      baseUrlResolver: "literal:",
      credentialResolver: validated.authMethod === "api-key" ? "api-key:" : validated.authMethod === "oauth" ? "oauth:" : "identity:",
      modelsResolver: "cliproxyapi:catalog",
      configJson: validated.configJson,
      cpaInstanceId: context.fixedScopeRef ? existing?.cpaInstanceId ?? DEFAULT_CPA_INSTANCE_ID : String(body.cpaInstanceId ?? existing?.cpaInstanceId ?? DEFAULT_CPA_INSTANCE_ID),
    };
    const audit = modelAccessAudit(context);
    const provider = existing
      ? await this.commands.changeProvider(id, { ...providerInput, authMethod: validated.authMethod }, audit)
      : await this.commands.createProvider({ ...providerInput, authMethod: validated.authMethod }, audit);
    const binding = await this.applicationQueries.getProviderBinding(provider.id);
    const { cpaInstanceId: _cpaInstanceId, ...safeProvider } = sanitizeProvider(provider);
    return { ...safeProvider, binding: safeProviderBinding(binding) };
  }

  async saveCredential(providerId: string, body: Record<string, unknown>, context: AsyncProviderManagementContext) {
    const provider = await this.requiredProvider(providerId, context);
    const binding = await this.requiredBinding(providerId, "api-key");
    if (String(body.type ?? "") !== "api-key") throw new RelayError("provider_credential_type_mismatch", "This CLIProxyAPI Auth Method does not use the API-key endpoint", 400);
    const apiKey = parseApiKeyPayload(body.payload);
    const config = parsePublicConfig(provider.configJson);
    const pending = await this.commands.beginProviderBindingTransition(providerId, bindingTransitionOptions(provider, binding));
    try {
      const result = await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).putApiKey({ providerId: provider.id, kind: provider.kind as Parameters<CliProxyControlClient["putApiKey"]>[0]["kind"], apiKey, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), models: config.models });
      const ready = await this.completeReadyBinding(pending, result);
      await auditSuccessAsync(this.audit, { ...modelAccessAudit(context), action: "provider_credential.replace", resource: { resourceType: "provider", resourceId: provider.id }, metadata: { type: "api-key", kind: provider.kind, authMethod: binding.authMethod, result: ready.syncStatus } });
      return { providerId, credential: { type: "api-key", configured: true, preview: ready.credentialPreview }, binding: safeProviderBinding(ready) };
    } catch (error) {
      await this.completeBindingError(providerId, pending.revision, error);
      throw error;
    }
  }

  async importCredential(providerId: string, serviceAccountJson: string, location: string, context: AsyncProviderManagementContext) {
    const provider = await this.requiredProvider(providerId, context);
    const binding = await this.requiredBinding(providerId, "credential-import");
    if (provider.kind !== "vertex") throw new RelayError("provider_credential_type_mismatch", "Only Vertex Providers accept credential imports", 400);
    const pending = await this.commands.beginProviderBindingTransition(providerId, bindingTransitionOptions(provider, binding));
    try {
      const result = await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).importCredential({ providerId: provider.id, serviceAccountJson, location });
      const ready = await this.completeReadyBinding(pending, result);
      await auditSuccessAsync(this.audit, { ...modelAccessAudit(context), action: "provider_credential.import", resource: { resourceType: "provider", resourceId: provider.id }, metadata: { type: "credential-import", kind: provider.kind, authMethod: binding.authMethod, result: ready.syncStatus } });
      return { providerId, credential: { type: "credential-import", configured: true, preview: ready.credentialPreview }, binding: safeProviderBinding(ready) };
    } catch (error) {
      await this.completeBindingError(providerId, pending.revision, error);
      throw error;
    }
  }

  async clearCredential(providerId: string, context: AsyncProviderManagementContext) {
    const provider = await this.requiredProvider(providerId, context);
    const binding = await this.applicationQueries.getProviderBinding(providerId);
    let disabled = provider;
    if (binding) {
      const pending = await this.commands.beginProviderBindingTransition(providerId, bindingTransitionOptions(provider, binding, {
        disableProvider: true,
        audit: modelAccessAudit(context),
      }));
      disabled = await this.queries.getProvider(providerId) ?? provider;
      try {
        await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).deleteCredential(providerId);
        await this.commands.completeProviderBindingTransition(providerId, pending.revision, {
          credentialRefsJson: "[]",
          credentialPreview: null,
          syncStatus: "cleared",
          errorCode: null,
        });
      } catch (error) {
        await this.completeBindingError(providerId, pending.revision, error);
        throw error;
      }
    } else {
      disabled = await this.commands.changeProviderStatus(providerId, "disabled", modelAccessAudit(context));
    }
    const result = await this.applicationQueries.getProviderBinding(providerId);
    await auditSuccessAsync(this.audit, { ...modelAccessAudit(context), action: "provider_credential.clear", resource: { resourceType: "provider", resourceId: providerId }, metadata: { resolver: disabled.credentialResolver } });
    return { providerId, credential: { type: result?.authMethod ?? null, configured: false, preview: null }, binding: safeProviderBinding(result) };
  }

  async syncModels(providerId: string, context: AsyncProviderManagementContext) {
    const provider = await this.requiredProvider(providerId, context);
    const models = await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).catalog(providerId);
    const result = await this.commands.applyProviderCatalogObservation(providerId, models, modelAccessAudit(context));
    return { providerId, synced: result.observed, created: result.created, items: result.items };
  }

  async changeProviderModel(
    providerId: string,
    providerModelName: string,
    command: ChangeProviderModelCommand,
    context: AsyncProviderManagementContext,
  ) {
    await this.requiredProvider(providerId, context);
    return this.commands.changeProviderModel(providerId, providerModelName, command, modelAccessAudit(context));
  }

  async reconcile(providerId: string, context: AsyncProviderManagementContext) {
    const provider = await this.requiredProvider(providerId, context);
    const binding = await this.requiredBinding(providerId);
    const result = await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).reconcile(providerId);
    const confirmedFailure = result.credentialStatus === "unready" && isConfirmedCliProxyCredentialFailureCode(result.credentialErrorCode);
    const saved = result.catalogStatus === "unknown" && !confirmedFailure
      ? binding
      : await this.applicationCommands.updateProviderBindingStatusIfCurrent({
          providerId,
          expectedCpaInstanceId: provider.cpaInstanceId,
          expectedRevision: binding.revision,
          syncStatus: confirmedFailure ? "error" : "ready",
          errorCode: confirmedFailure ? result.credentialErrorCode : null,
          ...(isMissingCredentialErrorCode(result.credentialErrorCode) ? { clearCredentialSummary: true } : {}),
        });
    if (!saved) throw new RelayError("provider_binding_changed", "Provider binding changed while reconciliation was running", 409);
    await auditSuccessAsync(this.audit, { ...modelAccessAudit(context), action: "provider_binding.reconcile", resource: { resourceType: "provider", resourceId: providerId }, metadata: { authMethod: saved.authMethod, result: saved.syncStatus, revision: saved.revision } });
    return { providerId, binding: safeProviderBinding(saved) };
  }

  async reconcileVisible(inputs: ProviderBindingRefreshInput[], context: AsyncProviderManagementContext): Promise<{ items: ProviderBindingRefreshResult[] }> {
    if (!Array.isArray(inputs) || inputs.length > 50) throw new RelayError("provider_reconcile_batch_invalid", "Provider reconcile batch accepts at most 50 items", 400);
    const seen = new Set<string>();
    const normalized = inputs.map((input) => {
      const providerId = String(input.providerId ?? "").trim();
      if (!providerId || seen.has(providerId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new RelayError("provider_reconcile_batch_invalid", "Provider reconcile batch item is invalid", 400);
      }
      seen.add(providerId);
      return { providerId, expectedRevision: input.expectedRevision };
    });
    let snapshots: Awaited<ReturnType<ApplicationQueries["getProviderBindingRefreshSnapshots"]>>;
    try {
      snapshots = await this.applicationQueries.getProviderBindingRefreshSnapshots(normalized.map((input) => input.providerId));
      const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.provider.id, snapshot]));
      if (normalized.some((input) => !snapshotById.has(input.providerId))) throw new RelayError("provider_not_found", "Provider refresh contains an unavailable Provider", 404);
      if (context.fixedScopeRef && snapshots.some((snapshot) => snapshot.provider.scopeRef !== context.fixedScopeRef)) {
        throw new RelayError("provider_scope_forbidden", "Provider refresh contains a Provider outside this Team", 403);
      }
    } catch (error) {
      await auditFailureAsync(this.audit, {
        ...modelAccessAudit(context),
        action: "provider_binding.reconcile_batch",
        resource: { resourceType: "provider", resourceId: "visible" },
        metadata: { count: normalized.length, phase: "preflight" },
        error,
      });
      throw error;
    }
    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.provider.id, snapshot]));
    const resultById = new Map<string, ProviderBindingRefreshResult>();
    const groups = new Map<string, Array<{ input: ProviderBindingRefreshInput; provider: Provider; binding: ProviderBinding }>>();
    for (const input of normalized) {
      const snapshot = snapshotById.get(input.providerId)!;
      const binding = snapshot.binding;
      if (!binding || binding.revision !== input.expectedRevision) {
        resultById.set(input.providerId, { providerId: input.providerId, result: "conflict", syncStatus: binding?.syncStatus ?? null, errorCode: null });
        continue;
      }
      if (binding.syncStatus === "cleared" || binding.credentialPreview === null) {
        resultById.set(input.providerId, { providerId: input.providerId, result: "skipped", syncStatus: binding.syncStatus, errorCode: null });
        continue;
      }
      const group = groups.get(snapshot.provider.cpaInstanceId) ?? [];
      group.push({ input, provider: snapshot.provider, binding });
      groups.set(snapshot.provider.cpaInstanceId, group);
    }
    await mapWithConcurrency([...groups.entries()], 3, async ([cpaInstanceId, group]) => {
      let observations: CliProxyControlReconciliationSummary[];
      try {
        observations = await CliProxyControlClient.fromEnv(process.env, cpaInstanceId).reconcileMany(group.map((item) => item.provider.id));
      } catch (error) {
        for (const item of group) resultById.set(item.provider.id, {
          providerId: item.provider.id, result: "transient", syncStatus: item.binding.syncStatus, errorCode: errorCode(error),
        });
        return;
      }
      const observationById = new Map(observations.map((observation) => [observation.providerId, observation]));
      await Promise.all(group.map(async (item) => {
        const observation = observationById.get(item.provider.id)!;
        resultById.set(item.provider.id, await this.persistBindingObservation(item.provider, item.binding, observation));
      }));
    });
    const items = normalized.map((input) => resultById.get(input.providerId)!);
    await auditSuccessAsync(this.audit, {
      ...modelAccessAudit(context),
      action: "provider_binding.reconcile_batch",
      resource: { resourceType: "provider", resourceId: "visible" },
      metadata: {
        count: items.length,
        ready: items.filter((item) => item.result === "ready").length,
        error: items.filter((item) => item.result === "error").length,
        transient: items.filter((item) => item.result === "transient").length,
        conflict: items.filter((item) => item.result === "conflict").length,
        skipped: items.filter((item) => item.result === "skipped").length,
      },
    });
    return { items };
  }

  async startOAuth(providerId: string, context: AsyncProviderManagementContext) {
    const provider = await this.requiredOAuthProvider(providerId, context);
    const binding = await this.requiredBinding(providerId, "oauth");
    const pending = await this.commands.beginProviderBindingTransition(providerId, bindingTransitionOptions(provider, binding));
    try {
      const result = await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).startOAuth({ providerId, kind: provider.kind as Parameters<CliProxyControlClient["startOAuth"]>[0]["kind"], actorId: context.actor.actorId });
      await auditSuccessAsync(this.audit, { ...modelAccessAudit(context), action: "provider_oauth.start", resource: { resourceType: "provider", resourceId: providerId }, metadata: { kind: provider.kind, authMethod: "oauth", result: "pending" } });
      return { ...result, bindingRevision: pending.revision };
    } catch (error) {
      await this.completeBindingError(providerId, pending.revision, error);
      throw error;
    }
  }

  async submitOAuthCallback(providerId: string, body: Record<string, unknown>, context: AsyncProviderManagementContext) {
    const provider = await this.requiredOAuthProvider(providerId, context);
    const result = await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).submitOAuthCallback({ providerId, actorId: context.actor.actorId, sessionId: requiredString(body.sessionId, "sessionId"), callbackUrl: requiredString(body.callbackUrl, "callbackUrl") });
    await auditSuccessAsync(this.audit, { ...modelAccessAudit(context), action: "provider_oauth.callback", resource: { resourceType: "provider", resourceId: providerId }, metadata: { kind: provider.kind, authMethod: "oauth", result: result.status } });
    return result;
  }

  async oauthStatus(providerId: string, sessionId: string, bindingRevision: number, context: AsyncProviderManagementContext) {
    const provider = await this.requiredOAuthProvider(providerId, context);
    let result: Record<string, unknown>;
    let binding: ProviderBinding | undefined;
    try {
      result = await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).oauthStatus({ providerId, actorId: context.actor.actorId, sessionId });
      if (result.status !== "pending" && result.status !== "ready") {
        throw new RelayError("cliproxy_oauth_invalid_response", "CLIProxyAPI OAuth response is invalid", 503);
      }
      binding = await this.applicationQueries.getProviderBinding(providerId);
      if (result.status === "ready") {
        const credential = asRecord(result.credential);
        if (!credential || typeof credential.credentialRef !== "string" || typeof credential.preview !== "string" || !binding) {
          throw new RelayError("cliproxy_oauth_invalid_response", "CLIProxyAPI OAuth response is invalid", 503);
        }
        binding = await this.commands.completeProviderBindingTransition(providerId, bindingRevision, {
          credentialRefsJson: JSON.stringify([credential.credentialRef]),
          credentialPreview: credential.preview,
          syncStatus: "ready",
          errorCode: null,
        });
      }
    } catch (error) {
      if (!isTransientProviderBindingError(error)) await this.completeBindingError(providerId, bindingRevision, error);
      throw error;
    }
    await auditSuccessAsync(this.audit, { ...modelAccessAudit(context), action: "provider_oauth.status", resource: { resourceType: "provider", resourceId: providerId }, metadata: { kind: provider.kind, authMethod: "oauth", result: result.status } });
    return { ...result, binding: safeProviderBinding(binding) };
  }

  private async persistBindingObservation(
    provider: Provider,
    binding: ProviderBinding,
    observation: CliProxyControlReconciliationSummary,
  ): Promise<ProviderBindingRefreshResult> {
    const confirmedFailure = observation.credentialStatus === "unready" && isConfirmedCliProxyCredentialFailureCode(observation.credentialErrorCode);
    if (observation.catalogStatus === "unknown" && !confirmedFailure) {
      return { providerId: provider.id, result: "transient", syncStatus: binding.syncStatus, errorCode: observation.catalogErrorCode };
    }
    const syncStatus = confirmedFailure ? "error" : "ready";
    const code = confirmedFailure ? observation.credentialErrorCode : null;
    try {
      const saved = await this.applicationCommands.updateProviderBindingStatusIfCurrent({
        providerId: provider.id,
        expectedCpaInstanceId: provider.cpaInstanceId,
        expectedRevision: binding.revision,
        syncStatus,
        errorCode: code,
        ...(isMissingCredentialErrorCode(observation.credentialErrorCode) ? { clearCredentialSummary: true } : {}),
      });
      return saved
        ? { providerId: provider.id, result: confirmedFailure ? "error" : "ready", syncStatus: saved.syncStatus, errorCode: code }
        : { providerId: provider.id, result: "conflict", syncStatus: null, errorCode: null };
    } catch (writeError) {
      return { providerId: provider.id, result: "transient", syncStatus: binding.syncStatus, errorCode: errorCode(writeError) };
    }
  }

  private async requiredProvider(providerId: string, context: AsyncProviderManagementContext): Promise<ProviderManagementView> {
    const provider = await this.queries.getProvider(providerId);
    if (!provider) throw new RelayError("provider_not_found", `Provider ${providerId} not found`, 404);
    if (context.fixedScopeRef && provider.scopeRef !== context.fixedScopeRef) throw new RelayError("provider_scope_forbidden", "Provider is not managed by this Team", 403);
    return provider;
  }

  private async requiredOAuthProvider(providerId: string, context: AsyncProviderManagementContext): Promise<ProviderManagementView> {
    const provider = await this.requiredProvider(providerId, context);
    const binding = await this.requiredBinding(providerId, "oauth");
    assertCliProxyKindAuthMethod(provider.kind, binding.authMethod);
    return provider;
  }

  private async requiredBinding(providerId: string, expected?: CliProxyAuthMethod): Promise<ProviderBinding> {
    const binding = await this.applicationQueries.getProviderBinding(providerId);
    if (!binding) throw new RelayError("cliproxy_binding_not_found", "CLIProxyAPI Provider binding is missing", 409);
    if (expected && binding.authMethod !== expected) throw new RelayError("cliproxy_oauth_not_configured", "Provider is not configured for the requested CLIProxyAPI Auth Method", 409);
    return binding;
  }

  private completeReadyBinding(binding: ProviderBindingTransitionView, result: CliProxyControlCredentialSummary) {
    return this.commands.completeProviderBindingTransition(binding.providerId, binding.revision, {
      credentialRefsJson: JSON.stringify([result.credentialRef]),
      credentialPreview: result.preview,
      syncStatus: "ready",
      errorCode: null,
    });
  }

  private async completeBindingError(providerId: string, revision: number, error: unknown): Promise<void> {
    try {
      await this.commands.completeProviderBindingTransition(providerId, revision, {
        syncStatus: "error",
        errorCode: errorCode(error),
      });
    } catch (completionError) {
      if (completionError instanceof RelayError && completionError.code === "provider_binding_revision_conflict") return;
      throw completionError;
    }
  }
}

function isExactE2eBaseUrl(value: string, allowedOrigin?: string): boolean {
  if (!allowedOrigin) return false;
  const normalizedAllowedOrigin = allowedOrigin.replace(/\/+$/u, "");
  const origin = normalizedAllowedOrigin.endsWith("/v1")
    ? normalizedAllowedOrigin.slice(0, -3)
    : normalizedAllowedOrigin;
  return value === origin || value === `${origin}/v1`;
}

function isMissingCredentialErrorCode(code: string | null | undefined): boolean {
  return code === "cliproxy_credential_not_found" || code === "cliproxy_provider_credentials_not_found";
}

function bindingTransitionOptions(
  provider: ProviderManagementView,
  binding: ProviderBinding,
  options: { disableProvider?: boolean; audit?: ReturnType<typeof modelAccessAudit>; allowStaleRecovery?: boolean } = {},
) {
  return {
    expectedRevision: binding.revision,
    expectedAuthMethod: binding.authMethod,
    expectedSyncStatus: binding.syncStatus,
    expectedErrorCode: binding.errorCode,
    expectedBindingUpdatedAt: binding.updatedAt,
    expectedProviderUpdatedAt: provider.updatedAt,
    ...options,
  };
}

function modelAccessAudit(context: AsyncProviderManagementContext) {
  return {
    actor: context.actor,
    source: context.source,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
  };
}

function providerConfigInput(value: unknown): Record<string, unknown> {
  try {
    return assertSafeProviderConfigInput(value);
  } catch (error) {
    if (error instanceof RelayError && error.code === "provider_config_credential_not_allowed") throw new RelayError("provider_config_api_key_not_allowed", "Provider credentials are not allowed in provider config", 400);
    throw error;
  }
}

function parseExistingConfig(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parsePublicConfig(value: string): { baseUrl?: string; models: CliProxyControlModelMapping[] } {
  const parsed = parseExistingConfig(value);
  const baseUrl = typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : undefined;
  const models = Array.isArray(parsed.models) ? parsed.models.filter((item): item is CliProxyControlModelMapping => Boolean(item && typeof item === "object" && typeof (item as Record<string, unknown>).name === "string" && typeof (item as Record<string, unknown>).alias === "string")) : [];
  return { ...(baseUrl ? { baseUrl } : {}), models };
}

function parseApiKeyPayload(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("provider_credential_invalid", "API key payload is invalid", 400);
  const apiKey = (value as Record<string, unknown>).apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length < 1 || apiKey.length > 4096) throw new RelayError("provider_credential_invalid", "API key payload is invalid", 400);
  return apiKey;
}

function requiredString(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new RelayError("invalid_provider_oauth", `${field} is required`, 400);
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isTransientProviderBindingError(error: unknown): boolean {
  return new Set([
    "cliproxy_control_rejected",
    "cliproxy_control_unavailable",
    "cliproxy_oauth_status_unavailable",
  ]).has(errorCode(error));
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code: string }).code)
    : "cliproxy_binding_error";
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, action: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await action(items[index]!);
    }
  }));
  return results;
}
