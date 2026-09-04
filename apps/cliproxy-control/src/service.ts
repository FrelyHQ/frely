import { assertProviderBaseUrl, RelayError } from "@frely/core";
import { randomBytes } from "node:crypto";
import { assertCliProxyKindAuthMethod, validateProviderId, type CliProxyProviderKind } from "@frely/providers";
import { CpaManagementClient, type CpaAuthFileSummary, type CpaCredentialHealth, type CpaRuntimeIdentity } from "./cpa.js";
import { CredentialStore, type StoredCredential, type StoredCredentialPublicConfig, type StoredModelMapping } from "./store.js";

type CpaControl = Pick<CpaManagementClient,
  | "reconcile"
  | "assertCredentialReady"
  | "credentialHealth"
  | "semanticProbe"
  | "assertOAuthCredentialIdentity"
  | "assertInferenceCatalogReady"
  | "deleteOAuthCredential"
  | "catalog"
  | "startOAuth"
  | "postOAuthCallback"
  | "oauthStatus"
  | "listAuthFiles"
  | "bindOAuthCredential"
  | "importVertexCredential"
  | "runtimeIdentity"
>;

const DEFAULT_OAUTH_SESSION_TTL_MS = 10 * 60_000;
const MAX_OAUTH_SESSION_TTL_MS = 15 * 60_000;

export interface CredentialSummary {
  credentialRef: string;
  providerId: string;
  kind: CliProxyProviderKind;
  authMethod: "api-key" | "oauth" | "credential-import";
  preview: string;
  status: "ready" | "unready";
  failureReason: CpaCredentialHealth["failureReason"];
  errorCode: CpaCredentialHealth["errorCode"];
  updatedAt: string;
  models: string[];
}

export interface CredentialSemanticProbeEvidence {
  providerId: string;
  model: string;
  status: "ready" | "unready";
  failureReason: CpaCredentialHealth["failureReason"];
  errorCode: CpaCredentialHealth["errorCode"];
  probedAt: string;
}

export interface CredentialSemanticReadinessReport {
  schema: "friday-relay.cpa-credential-semantic-readiness.v1";
  cpaInstanceId: string;
  status: "ready" | "unready";
  probes: CredentialSemanticProbeEvidence[];
}

export interface ProviderCatalogObservation {
  providerId: string;
  credentialRef: string | null;
  credentialStatus: "ready" | "unready";
  credentialFailureReason: CpaCredentialHealth["failureReason"];
  credentialErrorCode: CpaCredentialHealth["errorCode"];
  configuredModels: string[];
  catalogStatus: "full" | "partial" | "empty" | "unknown";
  catalogPresentModels: string[];
  catalogMissingModels: string[];
  catalogAttemptedAt: string;
  catalogCheckedAt: string | null;
  lastSuccessfulCatalogCheckedAt: string | null;
  catalogErrorCode: string | null;
  stale: boolean;
}

export class CliProxyControlService {
  readonly #store: CredentialStore;
  readonly #cpa: CpaControl;
  #tail: Promise<void> = Promise.resolve();
  #ready = false;
  readonly #oauthSessions = new Map<string, OAuthSession>();
  readonly #activeOAuthProviders = new Map<string, string>();
  readonly #oauthProviderTails = new Map<string, Promise<void>>();
  readonly #lastSuccessfulCatalogCheckedAt = new Map<string, string>();
  readonly #oauthSessionTtlMs: number;
  readonly #now: () => number;
  readonly #privateProviderOrigin: string | undefined;
  readonly #cpaInstanceId: string;

  constructor(store: CredentialStore, cpa: CpaControl, options: { oauthSessionTtlMs?: number; now?: () => number; privateProviderOrigin?: string; cpaInstanceId?: string } = {}) {
    this.#store = store;
    this.#cpa = cpa;
    this.#oauthSessionTtlMs = validateOAuthSessionTtlMs(options.oauthSessionTtlMs ?? DEFAULT_OAUTH_SESSION_TTL_MS);
    this.#now = options.now ?? Date.now;
    this.#privateProviderOrigin = options.privateProviderOrigin;
    const cpaInstanceId = options.cpaInstanceId ?? "cpa_default";
    if (!/^cpa_[a-z0-9][a-z0-9_-]{0,62}$/.test(cpaInstanceId)) throw new Error("cliproxy_cpa_instance_id_invalid");
    this.#cpaInstanceId = cpaInstanceId;
  }

  async initialize(): Promise<void> {
    await this.#store.load();
    await this.#store.repairOAuthModelPrefixes();
    await this.reconcile().catch(() => undefined);
  }

  async #repairRotatedOAuthBinding(): Promise<void> {
    const oauthCredentials = this.#store.list().filter((credential) => credential.authMethod === "oauth");
    if (oauthCredentials.length !== 1) return;
    const credential = oauthCredentials[0]!;
    const files = await this.#cpa.listAuthFiles();
    const exactMatches = files.filter((file) => file.ref === credential.ref
      && (file.name === credential.authFileName || file.id === credential.authFileName));
    if (exactMatches.length !== 0) return;
    const credentialUpdatedAt = Date.parse(credential.updatedAt);
    const candidates = files.filter((file) => file.status === "active"
      && !file.disabled
      && !file.unavailable
      && file.failureReason === null
      && (file.prefix === "" || file.prefix === credential.providerId)
      && Number.isFinite(Date.parse(file.updatedAt))
      && Date.parse(file.updatedAt) > credentialUpdatedAt);
    if (!Number.isFinite(credentialUpdatedAt) || candidates.length !== 1) return;
    const candidate = candidates[0]!;
    await this.#cpa.bindOAuthCredential(credential.providerId, credential.kind, candidate);
    await this.#store.upsert({
      ref: candidate.ref,
      providerId: credential.providerId,
      kind: credential.kind,
      authMethod: "oauth",
      authFileName: candidate.name,
      config: credential.config,
    });
  }

  isReady(): boolean {
    return this.#ready;
  }

  runtimeIdentity(): CpaRuntimeIdentity {
    return this.#cpa.runtimeIdentity();
  }

  async semanticReadiness(): Promise<CredentialSemanticReadinessReport> {
    return this.#mutate(async () => {
      const credentials = this.#store.list();
      if (credentials.length === 0) throw new Error("cliproxy_credential_probe_target_missing");
      await this.#cpa.reconcile(credentials);
      const probes: CredentialSemanticProbeEvidence[] = [];
      for (const credential of credentials) {
        const model = credential.config.models[0]?.alias;
        if (!model) throw new Error("cliproxy_credential_probe_model_missing");
        const probe = await this.#cpa.semanticProbe(credential, model);
        probes.push({
          providerId: credential.providerId,
          model: probe.model,
          status: probe.semanticStatus,
          failureReason: probe.failureReason,
          errorCode: probe.errorCode,
          probedAt: new Date(this.#now()).toISOString(),
        });
      }
      const status = probes.every((probe) => probe.status === "ready") ? "ready" : "unready";
      this.#ready = status === "ready";
      return {
        schema: "friday-relay.cpa-credential-semantic-readiness.v1",
        cpaInstanceId: this.#cpaInstanceId,
        status,
        probes,
      };
    });
  }

  async putCredential(providerIdValue: unknown, body: unknown): Promise<CredentialSummary> {
    const providerId = validateProviderId(providerIdValue);
    const input = await parseCredentialInput(body, this.#privateProviderOrigin);
    assertCliProxyKindAuthMethod(input.kind, "api-key");
    return this.#mutate(async () => {
      const previous = this.#store.get(providerId);
      const value = await this.#store.upsert({ providerId, kind: input.kind, authMethod: "api-key", apiKey: input.apiKey, config: input.config });
      try {
        const health = await this.#reconcileAndProbe(value, { forceReloadProviderIds: [providerId] });
        return summary(value, health);
      } catch (error) {
        if (previous) await this.#store.restore(previous);
        else await this.#store.delete(providerId);
        try {
          await this.#cpa.reconcile(this.#store.list(), { forceReloadProviderIds: previous ? [providerId] : [] });
          if (previous) await this.#cpa.assertCredentialReady(previous);
        } catch {
          // Preserve the original failure. The service remains not-ready and
          // periodic reconciliation will retry the rolled-back store state.
        }
        this.#ready = false;
        throw error;
      }
    });
  }

  async getCredential(providerIdValue: unknown): Promise<CredentialSummary | undefined> {
    const providerId = validateProviderId(providerIdValue);
    const value = this.#store.get(providerId);
    if (!value) return undefined;
    return summary(value, await this.#cpa.credentialHealth(value));
  }

  async importCredential(providerIdValue: unknown, body: unknown): Promise<CredentialSummary> {
    const providerId = validateProviderId(providerIdValue);
    const input = parseCredentialImportInput(body);
    assertCliProxyKindAuthMethod("vertex", "credential-import");
    return this.#mutate(async () => {
      if (this.#store.get(providerId)) throw new Error("cliproxy_vertex_credential_conflict");
      const imported = await this.#cpa.importVertexCredential(providerId, input.serviceAccountJson, input.location);
      try {
        const value = await this.#store.upsert({
          ref: imported.candidate.ref,
          providerId,
          kind: "vertex",
          authMethod: "credential-import",
          authFileName: imported.candidate.name,
          config: { models: imported.models }
        });
        const health = await this.#reconcileAndProbe(value);
        return summary(value, health);
      } catch (error) {
        await this.#store.delete(providerId).catch(() => undefined);
        await this.#cpa.deleteOAuthCredential(imported.candidate.name).catch(() => undefined);
        this.#ready = false;
        throw error;
      }
    });
  }

  async deleteCredential(providerIdValue: unknown): Promise<boolean> {
    const providerId = validateProviderId(providerIdValue);
    return this.#mutate(async () => {
      const current = this.#store.get(providerId);
      if ((current?.authMethod === "oauth" || current?.authMethod === "credential-import") && current.authFileName) await this.#cpa.deleteOAuthCredential(current.authFileName);
      const previous = await this.#store.delete(providerId);
      if (!previous) return false;
      try {
        await this.#cpa.reconcile(this.#store.list(), { removeProviderIds: [providerId] });
        this.#ready = true;
      } catch (error) {
        await this.#store.restore(previous);
        this.#ready = false;
        throw error;
      }
      return true;
    });
  }

  async catalog(providerIdValue: unknown): Promise<string[]> {
    const providerId = validateProviderId(providerIdValue);
    const credential = this.#store.get(providerId);
    if (!credential) throw new Error("cliproxy_credential_not_found");
    const observation = await this.reconcileProvider(providerIdValue);
    if (observation.catalogStatus === "unknown") throw new Error(observation.catalogErrorCode ?? "cliproxy_inference_unavailable");
    return credential.config.models.map((model) => model.alias);
  }

  async reconcile(): Promise<void> {
    await this.#mutate(async () => {
      try {
        await this.#repairRotatedOAuthBinding();
        const credentials = this.#store.list();
        await this.#cpa.reconcile(credentials);
        for (const credential of credentials) {
          const health = await this.#cpa.credentialHealth(credential);
          if (health.status !== "ready") throw new Error(health.errorCode ?? "cliproxy_provider_credentials_unavailable");
        }
        await this.#cpa.assertInferenceCatalogReady();
        this.#ready = true;
      } catch (error) {
        this.#ready = false;
        throw error;
      }
    });
  }

  async reconcileProvider(providerIdValue: unknown): Promise<ProviderCatalogObservation> {
    const providerId = validateProviderId(providerIdValue);
    const credential = this.#store.get(providerId);
    return this.#mutate(async () => {
      try {
        await this.#cpa.reconcile(this.#store.list());
      } catch (error) {
        this.#ready = false;
        throw error;
      }
      if (!credential) {
        this.#ready = false;
        return this.#missingObservation(providerId);
      }
      const health = await this.#cpa.credentialHealth(credential);
      const observation = health.status === "ready" ? await this.#observeCatalog(credential, health) : this.#unreadyObservation(credential, health);
      this.#ready = observation.credentialStatus === "ready" && observation.catalogStatus !== "unknown";
      return observation;
    });
  }

  async reconcileProviders(providerIdsValue: unknown): Promise<ProviderCatalogObservation[]> {
    if (!Array.isArray(providerIdsValue) || providerIdsValue.length < 1 || providerIdsValue.length > 50) throw new Error("cliproxy_reconcile_batch_invalid");
    const providerIds = providerIdsValue.map((value) => validateProviderId(value));
    if (new Set(providerIds).size !== providerIds.length) throw new Error("cliproxy_reconcile_batch_invalid");
    const credentials = providerIds.map((providerId) => ({ providerId, credential: this.#store.get(providerId) }));
    return this.#mutate(async () => {
      try {
        await this.#cpa.reconcile(this.#store.list());
      } catch (error) {
        this.#ready = false;
        throw error;
      }
      const observations: ProviderCatalogObservation[] = [];
      for (const entry of credentials) {
        const credential = entry.credential;
        if (!credential) {
          observations.push(this.#missingObservation(entry.providerId));
          continue;
        }
        const health = await this.#cpa.credentialHealth(credential);
        observations.push(health.status === "ready" ? await this.#observeCatalog(credential, health) : this.#unreadyObservation(credential, health));
      }
      this.#ready = observations.every((observation) => observation.credentialStatus === "ready" && observation.catalogStatus !== "unknown");
      return observations;
    });
  }

  async startOAuth(providerIdValue: unknown, body: unknown): Promise<{ sessionId: string; authorizationUrl: string; expiresAt: string }> {
    const providerId = validateProviderId(providerIdValue);
    const input = parseOAuthActorInput(body);
    const { kind } = assertCliProxyKindAuthMethod(input.kind, "oauth");
    return this.#withOAuthProvider(providerId, async () => {
      this.#releaseExpiredOAuthProvider(providerId);
      if (this.#activeOAuthProviders.has(providerId)) throw new Error("cliproxy_oauth_in_progress");
      const sessionId = `cpa_oauth_${randomBytes(18).toString("base64url")}`;
      this.#activeOAuthProviders.set(providerId, sessionId);
      try {
        const started = await this.#cpa.startOAuth(kind);
        const expiresAt = new Date(this.#now() + this.#oauthSessionTtlMs).toISOString();
        this.#oauthSessions.set(sessionId, {
          sessionId,
          providerId,
          kind,
          actorId: input.actorId,
          state: started.state,
          before: started.before,
          expiresAt,
          phase: "awaiting_callback"
        });
        return { sessionId, authorizationUrl: started.authorizationUrl, expiresAt };
      } catch (error) {
        this.#activeOAuthProviders.delete(providerId);
        throw error;
      }
    });
  }

  async submitOAuthCallback(providerIdValue: unknown, body: unknown): Promise<{ status: "accepted" }> {
    const providerId = validateProviderId(providerIdValue);
    const input = parseOAuthCallbackInput(body);
    return this.#withOAuthProvider(providerId, async () => {
      const session = this.#requiredOAuthSession(input.sessionId, input.actorId, providerId);
      if (session.phase !== "awaiting_callback") throw new Error("cliproxy_oauth_session_consumed");
      const callbackUrl = validatedOAuthCallbackUrl(input.callbackUrl, session);
      try {
        await this.#cpa.postOAuthCallback({ kind: session.kind, state: session.state, callbackUrl });
        session.phase = "callback_accepted";
        return { status: "accepted" };
      } catch (error) {
        this.#failOAuthSession(session, safeOAuthErrorCode(error));
        throw error;
      }
    });
  }

  async oauthStatus(providerIdValue: unknown, sessionId: string, actorId: string): Promise<Record<string, unknown>> {
    const providerId = validateProviderId(providerIdValue);
    return this.#withOAuthProvider(providerId, async () => {
      const session = this.#requiredOAuthSession(sessionId, actorId, providerId);
      if (session.phase === "ready" && session.result) return session.result;
      if (session.phase === "failed") throw new Error(session.errorCode ?? "cliproxy_oauth_failed");
      try {
        const status = await this.#cpa.oauthStatus(session.state);
        if (status === "wait") return { status: "pending", sessionId };
        if (status === "error") throw new Error("cliproxy_oauth_failed");
        const files = await this.#cpa.listAuthFiles();
        const before = new Map(session.before.map((entry) => [entry.ref, entry.updatedAt]));
        const provider = oauthProviderForKind(session.kind);
        const candidates = files.filter((entry) => entry.provider.toLowerCase() === provider && (!before.has(entry.ref) || before.get(entry.ref) !== entry.updatedAt));
        if (candidates.length !== 1) throw new Error(candidates.length === 0 ? "cliproxy_oauth_credential_not_found" : "cliproxy_oauth_credential_ambiguous");
        const candidate = candidates[0]!;
        const models = await this.#cpa.bindOAuthCredential(providerId, session.kind, candidate);
        const value = await this.#store.upsert({
          ref: candidate.ref,
          providerId,
          kind: session.kind,
          authMethod: "oauth",
          authFileName: candidate.name,
          config: { models }
        });
        const health = await this.#reconcileAndProbe(value);
        const result = { status: "ready", sessionId, credential: summary(value, health) } as const;
        session.phase = "ready";
        session.result = result;
        this.#activeOAuthProviders.delete(providerId);
        return result;
      } catch (error) {
        this.#failOAuthSession(session, safeOAuthErrorCode(error));
        throw error;
      }
    });
  }

  async #reconcileAndProbe(
    value: StoredCredential,
    options: { forceReloadProviderIds?: readonly string[]; removeProviderIds?: readonly string[] } = {}
  ): Promise<CpaCredentialHealth> {
    try {
      await this.#cpa.reconcile(this.#store.list(), options);
      await this.#cpa.assertCredentialReady(value);
      const health = await this.#cpa.credentialHealth(value);
      this.#ready = health.status === "ready";
      return health;
    } catch (error) {
      this.#ready = false;
      throw error;
    }
  }

  async #observeCatalog(credential: StoredCredential, health: CpaCredentialHealth): Promise<ProviderCatalogObservation> {
    const configuredModels = credential.config.models.map((model) => model.alias);
    try {
      const liveModels = new Set(await this.#cpa.catalog(credential.providerId));
      const catalogPresentModels = configuredModels.filter((model) => liveModels.has(model));
      const catalogMissingModels = configuredModels.filter((model) => !liveModels.has(model));
      const catalogCheckedAt = new Date(this.#now()).toISOString();
      this.#lastSuccessfulCatalogCheckedAt.set(credential.providerId, catalogCheckedAt);
      return {
        providerId: credential.providerId,
        credentialRef: health.credentialRef,
        credentialStatus: health.status,
        credentialFailureReason: health.failureReason,
        credentialErrorCode: health.errorCode,
        configuredModels,
        catalogStatus: catalogPresentModels.length === 0 ? "empty" : catalogMissingModels.length === 0 ? "full" : "partial",
        catalogPresentModels,
        catalogMissingModels,
        catalogAttemptedAt: catalogCheckedAt,
        catalogCheckedAt,
        lastSuccessfulCatalogCheckedAt: catalogCheckedAt,
        catalogErrorCode: null,
        stale: false
      };
    } catch (error) {
      const catalogAttemptedAt = new Date(this.#now()).toISOString();
      const lastSuccessfulCatalogCheckedAt = this.#lastSuccessfulCatalogCheckedAt.get(credential.providerId) ?? null;
      return {
        providerId: credential.providerId,
        credentialRef: health.credentialRef,
        credentialStatus: health.status,
        credentialFailureReason: health.failureReason,
        credentialErrorCode: health.errorCode,
        configuredModels,
        catalogStatus: "unknown",
        catalogPresentModels: [],
        catalogMissingModels: [],
        catalogAttemptedAt,
        catalogCheckedAt: null,
        lastSuccessfulCatalogCheckedAt,
        catalogErrorCode: safeCatalogErrorCode(error),
        stale: lastSuccessfulCatalogCheckedAt !== null
      };
    }
  }

  #unreadyObservation(credential: StoredCredential, health: CpaCredentialHealth): ProviderCatalogObservation {
    const catalogAttemptedAt = new Date(this.#now()).toISOString();
    return {
      providerId: credential.providerId,
      credentialRef: health.credentialRef,
      credentialStatus: health.status,
      credentialFailureReason: health.failureReason,
      credentialErrorCode: health.errorCode,
      configuredModels: credential.config.models.map((model) => model.alias),
      catalogStatus: "unknown",
      catalogPresentModels: [],
      catalogMissingModels: [],
      catalogAttemptedAt,
      catalogCheckedAt: null,
      lastSuccessfulCatalogCheckedAt: this.#lastSuccessfulCatalogCheckedAt.get(credential.providerId) ?? null,
      catalogErrorCode: health.errorCode,
      stale: this.#lastSuccessfulCatalogCheckedAt.has(credential.providerId),
    };
  }

  #missingObservation(providerId: string): ProviderCatalogObservation {
    const catalogAttemptedAt = new Date(this.#now()).toISOString();
    return {
      providerId,
      credentialRef: null,
      credentialStatus: "unready",
      credentialFailureReason: "auth_not_found",
      credentialErrorCode: "cliproxy_provider_credentials_not_found",
      configuredModels: [],
      catalogStatus: "unknown",
      catalogPresentModels: [],
      catalogMissingModels: [],
      catalogAttemptedAt,
      catalogCheckedAt: null,
      lastSuccessfulCatalogCheckedAt: this.#lastSuccessfulCatalogCheckedAt.get(providerId) ?? null,
      catalogErrorCode: "cliproxy_provider_credentials_not_found",
      stale: this.#lastSuccessfulCatalogCheckedAt.has(providerId),
    };
  }

  async #mutate<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  #requiredOAuthSession(sessionId: string, actorId: string, providerId: string): OAuthSession {
    const session = this.#oauthSessions.get(sessionId);
    if (!session || session.providerId !== providerId || session.actorId !== actorId) throw new Error("cliproxy_oauth_session_not_found");
    if (Date.parse(session.expiresAt) <= this.#now()) {
      this.#oauthSessions.delete(sessionId);
      if (this.#activeOAuthProviders.get(providerId) === sessionId) this.#activeOAuthProviders.delete(providerId);
      throw new Error("cliproxy_oauth_session_expired");
    }
    return session;
  }

  #releaseExpiredOAuthProvider(providerId: string): void {
    const sessionId = this.#activeOAuthProviders.get(providerId);
    if (!sessionId) return;
    const session = this.#oauthSessions.get(sessionId);
    if (!session || Date.parse(session.expiresAt) <= this.#now()) {
      this.#activeOAuthProviders.delete(providerId);
      if (session) this.#oauthSessions.delete(sessionId);
    }
  }

  #failOAuthSession(session: OAuthSession, errorCode: string): void {
    session.phase = "failed";
    session.errorCode = errorCode;
    if (this.#activeOAuthProviders.get(session.providerId) === session.sessionId) this.#activeOAuthProviders.delete(session.providerId);
  }

  async #withOAuthProvider<T>(providerId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#oauthProviderTails.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#oauthProviderTails.set(providerId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#oauthProviderTails.get(providerId) === tail) this.#oauthProviderTails.delete(providerId);
    }
  }
}

interface OAuthSession {
  sessionId: string;
  providerId: string;
  kind: CliProxyProviderKind;
  actorId: string;
  state: string;
  before: CpaAuthFileSummary[];
  expiresAt: string;
  phase: "awaiting_callback" | "callback_accepted" | "ready" | "failed";
  errorCode?: string;
  result?: Record<string, unknown>;
}

async function parseCredentialInput(value: unknown, privateProviderOrigin?: string): Promise<{ kind: CliProxyProviderKind; apiKey: string; config: StoredCredentialPublicConfig }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cliproxy_credential_input_invalid");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["kind", "apiKey", "baseUrl", "models"].includes(key))) throw new Error("cliproxy_credential_input_invalid");
  const kind = body.kind;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (typeof kind !== "string" || apiKey.length < 8) throw new Error("cliproxy_credential_input_invalid");
  const definition = assertCliProxyKindAuthMethod(kind, "api-key");
  if (!definition.definition.apiKeyManagementPath) throw new Error("cliproxy_credential_input_invalid");
  const models = parseModels(body.models);
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  if (definition.flow.baseUrlInput === "required" && !baseUrl) throw new Error("cliproxy_base_url_required");
  if (definition.flow.baseUrlInput === "hidden" && baseUrl) throw new Error("cliproxy_base_url_unsupported");
  if (baseUrl && !isExactE2eBaseUrl(baseUrl)) {
    try {
      await assertProviderBaseUrl(baseUrl, { privateOrigin: privateProviderOrigin });
    } catch (error) {
      if (error instanceof RelayError && error.code === "invalid_provider_url") throw new Error("cliproxy_base_url_invalid");
      if (error instanceof RelayError && error.code === "provider_url_not_allowed") throw new Error("cliproxy_base_url_not_allowed");
      throw error;
    }
  }
  return { kind: definition.kind, apiKey, config: { ...(baseUrl ? { baseUrl } : {}), models } };
}

function parseModels(value: unknown): StoredModelMapping[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8192) throw new Error("cliproxy_models_invalid");
  const aliases = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("cliproxy_models_invalid");
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "name" && key !== "alias")) throw new Error("cliproxy_models_invalid");
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const alias = typeof record.alias === "string" ? record.alias.trim() : "";
    if (!name || !alias || name.includes("/") || alias.includes("/") || aliases.has(alias)) throw new Error("cliproxy_models_invalid");
    aliases.add(alias);
    return { name, alias };
  });
}

function summary(value: StoredCredential, health: CpaCredentialHealth): CredentialSummary {
  return {
    credentialRef: value.ref,
    providerId: value.providerId,
    kind: value.kind,
    authMethod: value.authMethod,
    preview: value.authMethod === "api-key" ? preview(value.apiKey ?? "") : value.authMethod === "oauth" ? `OAuth ${value.kind}` : "Vertex service account",
    status: health.status,
    failureReason: health.failureReason,
    errorCode: health.errorCode,
    updatedAt: value.updatedAt,
    models: value.config.models.map((model) => model.alias)
  };
}

function safeCatalogErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return new Set([
    "cliproxy_inference_unavailable",
    "cliproxy_inference_rejected",
    "cliproxy_inference_invalid_response"
  ]).has(code) ? code : "cliproxy_inference_unavailable";
}

function parseOAuthActorInput(value: unknown): { actorId: string; kind: CliProxyProviderKind } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cliproxy_oauth_input_invalid");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "actorId" && key !== "kind")) throw new Error("cliproxy_oauth_input_invalid");
  const actorId = typeof body.actorId === "string" ? body.actorId.trim() : "";
  if (!actorId || typeof body.kind !== "string") throw new Error("cliproxy_oauth_input_invalid");
  return { actorId, kind: assertCliProxyKindAuthMethod(body.kind, "oauth").kind };
}

function parseCredentialImportInput(value: unknown): { serviceAccountJson: string; location: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cliproxy_vertex_credential_invalid");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "serviceAccountJson" && key !== "location")) throw new Error("cliproxy_vertex_credential_invalid");
  const serviceAccountJson = typeof body.serviceAccountJson === "string" ? body.serviceAccountJson : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  if (!serviceAccountJson || Buffer.byteLength(serviceAccountJson) > 1024 * 1024 || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(location)) throw new Error("cliproxy_vertex_credential_invalid");
  return { serviceAccountJson, location };
}

function parseOAuthCallbackInput(value: unknown): { actorId: string; sessionId: string; callbackUrl: URL } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cliproxy_oauth_input_invalid");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "actorId" && key !== "sessionId" && key !== "callbackUrl")) throw new Error("cliproxy_oauth_input_invalid");
  const actorId = typeof body.actorId === "string" ? body.actorId.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl.trim() : "";
  let parsed: URL;
  try { parsed = new URL(callbackUrl); } catch { throw new Error("cliproxy_oauth_input_invalid"); }
  if (!actorId || !sessionId || parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) throw new Error("cliproxy_oauth_input_invalid");
  return { actorId, sessionId, callbackUrl: parsed };
}

function validatedOAuthCallbackUrl(callbackUrl: URL, session: OAuthSession): string {
  const state = callbackUrl.searchParams.get("state") ?? "";
  if (!state || state !== session.state) throw new Error("cliproxy_oauth_state_mismatch");
  const provider = callbackUrl.searchParams.get("provider");
  if (provider && normalizeOAuthProvider(provider) !== oauthProviderForKind(session.kind)) throw new Error("cliproxy_oauth_provider_mismatch");
  const code = callbackUrl.searchParams.get("code");
  const error = callbackUrl.searchParams.get("error");
  if ((!code && !error) || (code && error)) throw new Error("cliproxy_oauth_callback_fields_invalid");
  const sanitized = new URL(callbackUrl.origin + callbackUrl.pathname);
  for (const key of ["provider", "state", "code", "error"] as const) {
    const value = callbackUrl.searchParams.get(key);
    if (value !== null) sanitized.searchParams.set(key, value);
  }
  return sanitized.toString();
}

function oauthProviderForKind(kind: CliProxyProviderKind): string {
  return kind === "claude" ? "anthropic" : kind;
}

function normalizeOAuthProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === "claude" ? "anthropic" : normalized;
}

function safeOAuthErrorCode(error: unknown): string {
  return error instanceof Error && /^cliproxy_[a-z0-9_]+$/.test(error.message) ? error.message : "cliproxy_oauth_failed";
}

export function validateOAuthSessionTtlMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 60_000 || value > MAX_OAUTH_SESSION_TTL_MS) throw new Error("cliproxy_oauth_session_ttl_invalid");
  return value;
}

function preview(value: string): string {
  const prefix = value.slice(0, Math.min(3, value.length));
  const suffix = value.slice(-4);
  return `${prefix}...${suffix}`;
}

function isExactE2eBaseUrl(value: string): boolean {
  const allowedOrigin = process.env.CLIPROXY_CONTROL_E2E_ALLOWED_BASE_URL;
  return process.env.NODE_ENV === "test"
    && Boolean(allowedOrigin)
    && (value === allowedOrigin || value === `${allowedOrigin}/v1`);
}
