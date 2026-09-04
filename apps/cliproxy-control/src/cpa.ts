import type { ProviderCredentialFailureReason } from "@frely/core";
import { CLIPROXY_CONTROL_PAYLOAD_MAX_BYTES, CLI_PROXY_KIND_DEFINITIONS, type CliProxyCredentialFailureCode, type CliProxyProviderKind } from "@frely/providers";
import { basename } from "node:path";
import type { StoredCredential, StoredModelMapping } from "./store.js";

type JsonRecord = Record<string, unknown>;

export interface CpaAuthFileSummary {
  id: string;
  name: string;
  ref: string;
  prefix: string;
  provider: string;
  status: string;
  disabled: boolean;
  unavailable: boolean;
  failureReason: ProviderCredentialFailureReason | null;
  updatedAt: string;
}

export interface CpaCredentialHealth {
  credentialRef: string;
  status: "ready" | "unready";
  failureReason: ProviderCredentialFailureReason | null;
  errorCode: CliProxyCredentialFailureCode | null;
}

export interface CpaCredentialProbe extends CpaCredentialHealth {
  model: string;
  semanticStatus: "ready" | "unready";
}

export interface CpaRuntimeIdentity {
  version: string;
  commit: string;
  buildDate: string;
  evidenceContract: "cpa-basic@1";
  adaptation: "friday-evidence-v1";
}

const API_KEY_KINDS = ["codex", "gemini", "claude", "xai", "openai-compatible", "vertex"] as const satisfies readonly CliProxyProviderKind[];

export class CpaManagementClient {
  readonly #baseUrl: URL;
  readonly #managementKey: string;
  readonly #inferenceKey: string;
  readonly #timeoutMs: number;
  readonly #readinessProbeTimeoutMs: number;
  readonly #readinessProbeIntervalMs: number;
  #runtimeIdentity: CpaRuntimeIdentity | null = null;

  constructor(input: {
    baseUrl: string;
    managementKey: string;
    inferenceKey: string;
    timeoutMs?: number;
    readinessProbeTimeoutMs?: number;
    readinessProbeIntervalMs?: number;
  }) {
    this.#baseUrl = new URL(input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`);
    this.#managementKey = requireSecret(input.managementKey, "cliproxy_management_key_required");
    this.#inferenceKey = requireSecret(input.inferenceKey, "cliproxy_inference_key_required");
    if (this.#managementKey === this.#inferenceKey) throw new Error("cliproxy_control_keys_not_separated");
    this.#timeoutMs = input.timeoutMs ?? 10_000;
    this.#readinessProbeTimeoutMs = input.readinessProbeTimeoutMs ?? 5_000;
    this.#readinessProbeIntervalMs = input.readinessProbeIntervalMs ?? 100;
  }

  async reconcile(
    credentials: readonly StoredCredential[],
    options: { forceReloadProviderIds?: readonly string[]; removeProviderIds?: readonly string[] } = {}
  ): Promise<void> {
    await this.assertForceModelPrefix();
    const apiCredentials = credentials.filter((entry) => entry.authMethod === "api-key");
    const providerIds = new Set(apiCredentials.map((entry) => entry.providerId));
    const forceReloadProviderIds = new Set(options.forceReloadProviderIds ?? []);
    const removeProviderIds = new Set(options.removeProviderIds ?? []);
    for (const kind of API_KEY_KINDS) {
      const path = CLI_PROXY_KIND_DEFINITIONS[kind].apiKeyManagementPath!;
      const current = await this.#readCollection(path);
      for (const item of current) {
        const prefix = typeof item.prefix === "string" ? item.prefix : "";
        const name = typeof item.name === "string" ? item.name : "";
        const owner = kind === "openai-compatible" ? name || prefix : prefix;
        if (!owner || (!providerIds.has(owner) && !removeProviderIds.has(owner))) throw new Error("cliproxy_unmanaged_api_key_state_present");
      }
      const desired = apiCredentials.filter((entry) => entry.kind === kind).map(toWireEntry);
      const forcedForKind = apiCredentials
        .filter((entry) => entry.kind === kind && forceReloadProviderIds.has(entry.providerId))
        .map((entry) => entry.providerId);
      if (forcedForKind.length > 0) {
        // A Management API write is persisted before CPA's debounced config
        // watcher rebuilds inference clients. Removing the affected prefix and
        // waiting for it to disappear makes an API-key replacement observable;
        // otherwise /v1/models can still be served by the old in-memory client
        // and a save may return before the new key is active.
        const forced = new Set(forcedForKind);
        const intermediate = apiCredentials
          .filter((entry) => entry.kind === kind && !forced.has(entry.providerId))
          .map(toWireEntry);
        await this.#request(`v0/management/${path}`, { method: "PUT", body: intermediate });
        for (const providerId of forcedForKind) await this.#assertCatalogAbsent(providerId);
      }
      await this.#request(`v0/management/${path}`, { method: "PUT", body: desired });
    }
  }

  async credentialHealth(credential: StoredCredential): Promise<CpaCredentialHealth> {
    const files = await this.listAuthFiles();
    const matches = credential.authMethod === "api-key"
      ? files.filter((file) => file.prefix === credential.providerId)
      : files.filter((file) => file.ref === credential.ref && (file.name === credential.authFileName || file.id === credential.authFileName));
    if (matches.length > 0) {
      if (matches.length !== 1) return credentialHealth(credential.ref, "auth_unavailable");
      const match = matches[0]!;
      const failureReason = match.failureReason
        ?? (match.disabled || match.unavailable || match.status !== "active" ? "auth_unavailable" : null);
      return credentialHealth(match.ref, failureReason);
    }
    if (credential.authMethod !== "api-key") return credentialHealth(credential.ref, "auth_not_found");

    // CLIProxyAPI keeps API-key providers in kind-specific management
    // collections; /auth-files only enumerates file-backed credentials. Keep
    // the auth-file path for patched CPA implementations that project API-key
    // records there, then fall back to the authoritative API-key collection.
    const managementPath = CLI_PROXY_KIND_DEFINITIONS[credential.kind].apiKeyManagementPath;
    if (!managementPath) return credentialHealth(credential.ref, "auth_not_found");
    const collection = await this.#readCollection(managementPath);
    const collectionMatches = collection.filter((item) => apiKeyOwner(item, credential.kind) === credential.providerId);
    if (collectionMatches.length === 0) return credentialHealth(credential.ref, "auth_not_found");
    if (collectionMatches.length !== 1) return credentialHealth(credential.ref, "auth_unavailable");
    return credentialHealth(credential.ref, null);
  }

  async semanticProbe(credential: StoredCredential, model: string): Promise<CpaCredentialProbe> {
    const health = await this.credentialHealth(credential);
    if (health.status !== "ready") return { ...health, model, semanticStatus: "unready" };
    let response: Response;
    try {
      response = await fetch(new URL("v1/chat/completions", this.#baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#inferenceKey}`,
          accept: "application/json",
          "content-type": "application/json",
          "x-friday-cpa-probe-auth-id": health.credentialRef,
          "x-friday-cpa-probe-key": this.#managementKey,
        },
        body: JSON.stringify({
          model: `${credential.providerId}/${model}`,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1,
          stream: false,
          store: false,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new Error("cliproxy_credential_probe_unavailable");
    }
    const text = await readTextBounded(response, CLIPROXY_CONTROL_PAYLOAD_MAX_BYTES);
    let body: unknown = {};
    try { body = text ? JSON.parse(text) as unknown : {}; } catch { throw new Error("cliproxy_credential_probe_invalid_response"); }
    if (!response.ok) {
      const reason = probeFailureReason(body);
      if (reason) return { ...credentialHealth(health.credentialRef, reason), model, semanticStatus: "unready" };
      throw new Error("cliproxy_credential_probe_failed");
    }
    const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
    const message = isRecord(choice) ? choice.message : undefined;
    if (!isRecord(message) || typeof message.content !== "string") throw new Error("cliproxy_credential_probe_invalid_response");
    return { ...health, model, semanticStatus: "ready" };
  }

  async assertCredentialReady(credential: StoredCredential): Promise<void> {
    const deadline = Date.now() + this.#readinessProbeTimeoutMs;
    let lastErrorCode = "cliproxy_provider_credentials_not_found";
    do {
      try {
        const health = await this.credentialHealth(credential);
        lastErrorCode = health.errorCode ?? lastErrorCode;
        if (health.failureReason === "auth_unauthorized") throw new Error(health.errorCode!);
        if (health.status === "ready") {
          lastErrorCode = "cliproxy_credential_catalog_probe_failed";
          const models = await this.catalog(credential.providerId);
          if (models.length > 0) return;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "cliproxy_provider_credentials_unauthorized") throw error;
        // CPA persists Management API writes before its debounced config watcher
        // refreshes inference clients. Both the exact credential health and its
        // Provider prefix must be observed from the same target instance.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(this.#readinessProbeIntervalMs, remaining));
    } while (true);
    throw new Error(lastErrorCode);
  }

  async #assertCatalogAbsent(providerId: string): Promise<void> {
    const deadline = Date.now() + this.#readinessProbeTimeoutMs;
    do {
      try {
        if ((await this.catalog(providerId)).length === 0) return;
      } catch {
        // Treat transient inference unavailability as not-yet-observed. The
        // prefix must be read successfully as absent before the replacement is
        // written, so a stale client cannot satisfy readiness.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(this.#readinessProbeIntervalMs, remaining));
    } while (true);
    throw new Error("cliproxy_credential_unload_probe_failed");
  }

  async startOAuth(kind: CliProxyProviderKind): Promise<{ authorizationUrl: string; state: string; before: CpaAuthFileSummary[] }> {
    const definition = CLI_PROXY_KIND_DEFINITIONS[kind];
    if (!definition.oauthManagementPath) throw new Error("cliproxy_oauth_unsupported");
    const before = await this.listAuthFiles();
    const body = await this.#request(`v0/management/${definition.oauthManagementPath}`, { method: "GET" });
    if (!isRecord(body) || body.status !== "ok" || typeof body.url !== "string" || typeof body.state !== "string") throw new Error("cliproxy_oauth_invalid_response");
    const authorizationUrl = new URL(body.url);
    if (authorizationUrl.protocol !== "https:") throw new Error("cliproxy_oauth_invalid_response");
    return { authorizationUrl: authorizationUrl.toString(), state: body.state, before };
  }

  async postOAuthCallback(input: { kind: CliProxyProviderKind; state: string; callbackUrl: string }): Promise<void> {
    const provider = cpaOAuthProvider(input.kind);
    await this.#request("v0/management/oauth-callback", {
      method: "POST",
      body: { provider, redirect_url: input.callbackUrl, state: input.state }
    });
  }

  async oauthStatus(state: string): Promise<"wait" | "ok" | "error"> {
    const body = await this.#request(`v0/management/get-auth-status?state=${encodeURIComponent(state)}`, { method: "GET" });
    if (!isRecord(body) || (body.status !== "wait" && body.status !== "ok" && body.status !== "error")) throw new Error("cliproxy_oauth_invalid_response");
    return body.status;
  }

  async listAuthFiles(): Promise<CpaAuthFileSummary[]> {
    const body = await this.#request("v0/management/auth-files", { method: "GET" });
    if (!isRecord(body) || !Array.isArray(body.files)) throw new Error("cliproxy_management_invalid_response");
    return body.files.map((item) => {
      if (!isRecord(item)) throw new Error("cliproxy_management_invalid_response");
      const id = typeof item.id === "string" ? item.id : "";
      const name = typeof item.name === "string" ? item.name : "";
      const ref = typeof item.auth_index === "string" ? item.auth_index : id;
      const provider = typeof item.provider === "string" ? item.provider : typeof item.type === "string" ? item.type : "";
      if (!id || !name || !/^[A-Za-z0-9._:-]{1,256}$/.test(ref) || !provider) throw new Error("cliproxy_management_invalid_response");
      return {
        id,
        name,
        ref,
        prefix: typeof item.prefix === "string" ? item.prefix : "",
        provider,
        status: typeof item.status === "string" ? item.status : "",
        disabled: item.disabled === true,
        unavailable: item.unavailable === true,
        failureReason: managementCredentialFailureReason(item.failure_reason),
        updatedAt: typeof item.updated_at === "string" ? item.updated_at : typeof item.modtime === "string" ? item.modtime : ""
      };
    });
  }

  async bindOAuthCredential(providerId: string, kind: CliProxyProviderKind, candidate: CpaAuthFileSummary): Promise<StoredModelMapping[]> {
    if (candidate.provider.toLowerCase() !== cpaOAuthProvider(kind)) throw new Error("cliproxy_oauth_credential_kind_mismatch");
    await this.#request("v0/management/auth-files/fields", { method: "PATCH", body: { name: candidate.id, prefix: providerId } });
    const models = await this.authFileModels(candidate.id);
    if (models.length === 0) throw new Error("cliproxy_oauth_catalog_empty");
    const normalized = new Set(models.map((model) => unprefixedOAuthModel(providerId, model)));
    return [...normalized].sort().map((model) => ({ name: model, alias: model }));
  }

  async importVertexCredential(providerId: string, serviceAccountJson: string, location: string): Promise<{ candidate: CpaAuthFileSummary; models: StoredModelMapping[] }> {
    const projectId = vertexProjectId(serviceAccountJson);
    const expectedName = `vertex-${sanitizeVertexFilePart(projectId)}.json`;
    const before = await this.listAuthFiles();
    if (before.some((entry) => entry.name === expectedName || entry.id === expectedName)) throw new Error("cliproxy_vertex_credential_conflict");
    const formData = new FormData();
    formData.set("file", new Blob([serviceAccountJson], { type: "application/json" }), "service-account.json");
    formData.set("location", location);
    const body = await this.#request("v0/management/vertex/import", { method: "POST", formData });
    if (!isRecord(body) || body.status !== "ok" || typeof body["auth-file"] !== "string") throw new Error("cliproxy_vertex_import_invalid_response");
    const importedName = basename(body["auth-file"]);
    if (importedName !== expectedName) throw new Error("cliproxy_vertex_import_invalid_response");
    const files = await this.listAuthFiles();
    const matches = files.filter((entry) => (entry.name === importedName || entry.id === importedName) && entry.provider.toLowerCase() === "vertex");
    if (matches.length !== 1) throw new Error("cliproxy_vertex_import_invalid_response");
    const candidate = matches[0]!;
    try {
      const models = await this.bindOAuthCredential(providerId, "vertex", candidate);
      return { candidate, models };
    } catch (error) {
      await this.deleteOAuthCredential(candidate.name).catch(() => undefined);
      throw error;
    }
  }

  async deleteOAuthCredential(authFileName: string): Promise<void> {
    await this.#request(`v0/management/auth-files?name=${encodeURIComponent(authFileName)}`, { method: "DELETE" });
  }

  async authFileModels(name: string): Promise<string[]> {
    const body = await this.#request(`v0/management/auth-files/models?name=${encodeURIComponent(name)}`, { method: "GET" });
    if (!isRecord(body) || !Array.isArray(body.models)) throw new Error("cliproxy_management_invalid_response");
    const models = new Set<string>();
    for (const item of body.models) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id) throw new Error("cliproxy_management_invalid_response");
      models.add(item.id);
    }
    return [...models].sort();
  }

  async catalog(providerId: string): Promise<string[]> {
    const catalog = await this.#inferenceCatalog();
    const prefix = `${providerId}/`;
    return catalog.filter((model) => model.startsWith(prefix) && model.length > prefix.length).map((model) => model.slice(prefix.length));
  }

  async assertInferenceCatalogReady(): Promise<void> {
    await this.#inferenceCatalog();
  }

  async #inferenceCatalog(): Promise<string[]> {
    const body = await this.#request("v1/models", { method: "GET", channel: "inference" });
    if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("cliproxy_inference_invalid_response");
    const models = new Set<string>();
    for (const item of body.data) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id) throw new Error("cliproxy_inference_invalid_response");
      models.add(item.id);
    }
    return [...models].sort();
  }

  async assertForceModelPrefix(): Promise<void> {
    const body = await this.#request("v0/management/force-model-prefix", { method: "GET" });
    if (!isRecord(body) || body["force-model-prefix"] !== true) throw new Error("cliproxy_force_model_prefix_disabled");
  }

  runtimeIdentity(): CpaRuntimeIdentity {
    if (!this.#runtimeIdentity) throw new Error("cliproxy_runtime_identity_unavailable");
    return { ...this.#runtimeIdentity };
  }

  async assertOAuthCredentialReady(credential: StoredCredential): Promise<void> {
    await this.assertOAuthCredentialIdentity(credential);
    await this.assertCredentialReady(credential);
  }

  async assertOAuthCredentialIdentity(credential: StoredCredential): Promise<void> {
    if ((credential.authMethod !== "oauth" && credential.authMethod !== "credential-import") || !credential.authFileName) throw new Error("cliproxy_oauth_binding_invalid");
    const files = await this.listAuthFiles();
    const match = files.find((file) => file.name === credential.authFileName || file.id === credential.authFileName);
    if (!match || match.ref !== credential.ref || match.provider.toLowerCase() !== cpaOAuthProvider(credential.kind)) {
      throw new Error("cliproxy_provider_credentials_not_found");
    }
    const health = credentialHealth(match.ref, match.failureReason ?? (match.disabled || match.unavailable || match.status !== "active" ? "auth_unavailable" : null));
    if (health.status !== "ready") throw new Error(health.errorCode!);
  }

  async #readCollection(path: string): Promise<JsonRecord[]> {
    const body = await this.#request(`v0/management/${path}`, { method: "GET" });
    if (!isRecord(body) || !Array.isArray(body[path]) || !body[path].every(isRecord)) throw new Error("cliproxy_management_invalid_response");
    return body[path] as JsonRecord[];
  }

  async #request(path: string, input: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; formData?: FormData; channel?: "management" | "inference" }): Promise<unknown> {
    const channel = input.channel ?? "management";
    let response: Response;
    try {
      response = await fetch(new URL(path, this.#baseUrl), {
        method: input.method,
        headers: {
          authorization: `Bearer ${channel === "management" ? this.#managementKey : this.#inferenceKey}`,
          accept: "application/json",
          ...(input.body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(input.formData ? { body: input.formData } : input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error"
      });
    } catch {
      throw new Error(channel === "management" ? "cliproxy_management_unavailable" : "cliproxy_inference_unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(channel === "management" ? "cliproxy_management_rejected" : "cliproxy_inference_rejected");
    }
    if (channel === "management") {
      const runtimeIdentity = parseRuntimeIdentityHeaders(response.headers);
      if (runtimeIdentity) this.#runtimeIdentity = runtimeIdentity;
    }
    const text = await readTextBounded(response, CLIPROXY_CONTROL_PAYLOAD_MAX_BYTES);
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(channel === "management" ? "cliproxy_management_invalid_response" : "cliproxy_inference_invalid_response");
    }
  }
}

function parseRuntimeIdentityHeaders(headers: Headers): CpaRuntimeIdentity | null {
  const version = headers.get("x-cpa-version")?.trim() ?? "";
  const commit = headers.get("x-cpa-commit")?.trim() ?? "";
  const buildDate = headers.get("x-cpa-build-date")?.trim() ?? "";
  const evidenceContract = headers.get("x-friday-cpa-evidence-contract")?.trim() ?? "";
  const adaptation = headers.get("x-friday-cpa-adaptation")?.trim() ?? "";
  if (!version && !commit && !buildDate && !evidenceContract && !adaptation) return null;
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    || !/^[a-f0-9]{7,40}$/i.test(commit)
    || !Number.isFinite(Date.parse(buildDate))
    || evidenceContract !== "cpa-basic@1"
    || adaptation !== "friday-evidence-v1") {
    throw new Error("cliproxy_runtime_identity_invalid");
  }
  return {
    version,
    commit: commit.toLowerCase(),
    buildDate: new Date(buildDate).toISOString(),
    evidenceContract,
    adaptation,
  };
}

function toWireEntry(value: StoredCredential): JsonRecord {
  if (value.authMethod !== "api-key" || !value.apiKey) throw new Error("cliproxy_registry_key_invalid");
  const common = {
    "api-key": value.apiKey,
    prefix: value.providerId,
    ...(value.config.baseUrl ? { "base-url": value.config.baseUrl } : {}),
    models: value.config.models.map((model) => ({ name: model.name, alias: model.alias }))
  };
  if (value.kind === "openai-compatible") {
    return {
      name: value.providerId,
      prefix: value.providerId,
      disabled: false,
      "base-url": value.config.baseUrl,
      "api-key-entries": [{ "api-key": value.apiKey }],
      models: value.config.models.map((model) => ({ name: model.name, alias: model.alias }))
    };
  }
  return common;
}

function apiKeyOwner(item: JsonRecord, kind: CliProxyProviderKind): string {
  const prefix = typeof item.prefix === "string" ? item.prefix : "";
  const name = typeof item.name === "string" ? item.name : "";
  return kind === "openai-compatible" ? name || prefix : prefix;
}

function probeFailureReason(value: unknown): ProviderCredentialFailureReason | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  return providerCredentialFailureReason(value.error.code);
}

function providerCredentialFailureReason(value: unknown): ProviderCredentialFailureReason | null {
  return value === "auth_unauthorized" || value === "auth_unavailable" || value === "auth_not_found" || value === "model_cooldown" ? value : null;
}

function managementCredentialFailureReason(value: unknown): ProviderCredentialFailureReason | null {
  if (value === undefined || value === null || value === "") return null;
  const reason = providerCredentialFailureReason(value);
  if (!reason) throw new Error("cliproxy_management_invalid_response");
  return reason;
}

function credentialHealth(credentialRef: string, failureReason: ProviderCredentialFailureReason | null): CpaCredentialHealth {
  const errorCode = failureReason === "auth_unauthorized" ? "cliproxy_provider_credentials_unauthorized"
    : failureReason === "auth_unavailable" ? "cliproxy_provider_credentials_unavailable"
      : failureReason === "auth_not_found" ? "cliproxy_provider_credentials_not_found"
        : failureReason === "model_cooldown" ? "cliproxy_provider_credentials_cooldown"
          : null;
  return Object.freeze({
    credentialRef,
    status: failureReason ? "unready" : "ready",
    failureReason,
    errorCode,
  });
}

function cpaOAuthProvider(kind: CliProxyProviderKind): string {
  return kind === "claude" ? "anthropic" : kind;
}

function vertexProjectId(serviceAccountJson: string): string {
  let value: unknown;
  try { value = JSON.parse(serviceAccountJson) as unknown; } catch { throw new Error("cliproxy_vertex_credential_invalid"); }
  if (!isRecord(value) || typeof value.project_id !== "string" || !value.project_id.trim()) throw new Error("cliproxy_vertex_credential_invalid");
  return value.project_id.trim();
}

function sanitizeVertexFilePart(value: string): string {
  const sanitized = value.trim().replace(/[\\/:]/g, "_").replace(/ /g, "-");
  return sanitized || "vertex";
}

function unprefixedOAuthModel(providerId: string, model: string): string {
  const prefix = `${providerId}/`;
  const value = model.startsWith(prefix) ? model.slice(prefix.length) : model;
  if (!value || value.includes("/")) throw new Error("cliproxy_oauth_catalog_prefix_mismatch");
  return value;
}

function requireSecret(value: string, code: string): string {
  if (value.length < 32) throw new Error(code);
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("cliproxy_control_response_too_large");
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
