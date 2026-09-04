import { createRequire } from "node:module";
import { isProviderCredentialFailureReason, RelayError, type ProviderCredentialFailureReason } from "@frely/core";
import { CLI_PROXY_PROVIDER_KINDS, type CliProxyProviderKind } from "./provider-kinds.js";
import { cpaConnectionEntry, loadCpaConnectionRegistry, readCpaSecret, DEFAULT_CPA_INSTANCE_ID } from "./connection-registry.js";

export const CLIPROXY_CONTROL_PAYLOAD_MAX_BYTES = 4 * 1024 * 1024;

const require = createRequire(import.meta.url);
const Agent = require("undici/lib/dispatcher/agent.js") as typeof import("undici").Agent;
const undiciFetch = require("undici/lib/web/fetch/index.js").fetch as typeof import("undici").fetch;
const initialGlobalFetch = globalThis.fetch;

async function fetchControl(url: URL, init: Record<string, unknown>): Promise<Response> {
  const implementation = (globalThis.fetch === initialGlobalFetch ? undiciFetch : globalThis.fetch) as unknown as ((url: URL, init: Record<string, unknown>) => Promise<unknown>);
  return await implementation(url, init) as Response;
}

export type CliProxyCredentialFailureCode =
  | "cliproxy_provider_credentials_unauthorized"
  | "cliproxy_provider_credentials_unavailable"
  | "cliproxy_provider_credentials_not_found"
  | "cliproxy_provider_credentials_cooldown";

export interface CliProxyControlCredentialSummary {
  credentialRef: string;
  providerId: string;
  kind: CliProxyProviderKind;
  authMethod: "api-key" | "oauth" | "credential-import";
  preview: string;
  status: "ready" | "unready";
  failureReason: ProviderCredentialFailureReason | null;
  errorCode: CliProxyCredentialFailureCode | null;
  updatedAt: string;
  models: string[];
}

export interface CliProxyControlReconciliationSummary {
  providerId: string;
  credentialRef: string | null;
  credentialStatus: "ready" | "unready";
  credentialFailureReason: ProviderCredentialFailureReason | null;
  credentialErrorCode: CliProxyCredentialFailureCode | null;
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

export interface CliProxyCredentialProbeEvidence {
  providerId: string;
  model: string;
  status: "ready" | "unready";
  failureReason: ProviderCredentialFailureReason | null;
  errorCode: CliProxyCredentialFailureCode | null;
  probedAt: string;
}

export interface CliProxyCredentialSemanticReadiness {
  schema: "friday-relay.cpa-credential-semantic-readiness.v1";
  cpaInstanceId: string;
  status: "ready" | "unready";
  probes: CliProxyCredentialProbeEvidence[];
}

export interface CliProxyControlModelMapping {
  name: string;
  alias: string;
}

export interface CliProxyControlRuntimeIdentity {
  version: string;
  commit: string;
  buildDate: string;
  evidenceContract: "cpa-basic@1";
  adaptation: "friday-evidence-v1";
}

export class CliProxyControlClient {
  readonly #baseUrl: URL;
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(input: { baseUrl: string; apiKey: string; timeoutMs?: number }) {
    const baseUrl = new URL(input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`);
    if (!/^https?:$/.test(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new RelayError("cliproxy_control_config_invalid", "CLIProxyAPI control URL is invalid", 503);
    }
    if (input.apiKey.length < 32) throw new RelayError("cliproxy_control_credential_missing", "CLIProxyAPI control credential is not configured", 503);
    this.#baseUrl = baseUrl;
    this.#apiKey = input.apiKey;
    this.#timeoutMs = input.timeoutMs ?? 10_000;
  }

  static fromEnv(environment: NodeJS.ProcessEnv = process.env, cpaInstanceId = environment.FRIDAY_RELAY_DEFAULT_CPA_INSTANCE_ID ?? DEFAULT_CPA_INSTANCE_ID): CliProxyControlClient {
    const registry = loadCpaConnectionRegistry(environment);
    if (registry) {
      const entry = cpaConnectionEntry(registry, cpaInstanceId);
      return new CliProxyControlClient({
        baseUrl: entry.controlOrigin,
        apiKey: readCpaSecret(entry.controlKeyFile, "control")
      });
    }
    return new CliProxyControlClient({
      baseUrl: environment.CLIPROXY_CONTROL_BASE_URL ?? "http://cliproxy-control:8319",
      apiKey: environment.CLIPROXY_CONTROL_API_KEY ?? ""
    });
  }

  async putApiKey(input: {
    providerId: string;
    kind: CliProxyProviderKind;
    apiKey: string;
    baseUrl?: string;
    models: readonly CliProxyControlModelMapping[];
    signal?: AbortSignal;
  }): Promise<CliProxyControlCredentialSummary> {
    const result = await this.#request(`v1/providers/${encodeURIComponent(input.providerId)}/credential`, {
      method: "PUT",
      body: {
        kind: input.kind,
        apiKey: input.apiKey,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        models: input.models
      },
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (!isCredentialSummary(result) || result.providerId !== input.providerId || result.kind !== input.kind || result.authMethod !== "api-key") throw invalidControlResponse();
    return result;
  }

  async importCredential(input: { providerId: string; serviceAccountJson: string; location: string; signal?: AbortSignal }): Promise<CliProxyControlCredentialSummary> {
    const result = await this.#request(`v1/providers/${encodeURIComponent(input.providerId)}/credential-import`, {
      method: "POST",
      body: { serviceAccountJson: input.serviceAccountJson, location: input.location },
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (!isCredentialSummary(result) || result.providerId !== input.providerId || result.kind !== "vertex" || result.authMethod !== "credential-import") throw invalidControlResponse();
    return result;
  }

  async getCredential(providerId: string, signal?: AbortSignal): Promise<CliProxyControlCredentialSummary> {
    const result = await this.#request(`v1/providers/${encodeURIComponent(providerId)}/credential`, { method: "GET", ...(signal ? { signal } : {}) });
    if (!isCredentialSummary(result) || result.providerId !== providerId) throw invalidControlResponse();
    return result;
  }

  async deleteCredential(providerId: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.#request(`v1/providers/${encodeURIComponent(providerId)}/credential`, { method: "DELETE", ...(signal ? { signal } : {}) });
    return isRecord(result) && result.deleted === true;
  }

  async catalog(providerId: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.#request(`v1/providers/${encodeURIComponent(providerId)}/catalog`, { method: "GET", ...(signal ? { signal } : {}) });
    if (!isRecord(result) || !Array.isArray(result.models) || !result.models.every((model) => typeof model === "string")) {
      throw new RelayError("cliproxy_control_invalid_response", "CLIProxyAPI control response is invalid", 503);
    }
    return result.models;
  }

  async reconcile(providerId: string, signal?: AbortSignal): Promise<CliProxyControlReconciliationSummary> {
    const result = await this.#request(`v1/providers/${encodeURIComponent(providerId)}/reconcile`, { method: "POST", ...(signal ? { signal } : {}) });
    if (!isReconciliationSummary(result) || result.providerId !== providerId) throw new RelayError("cliproxy_control_invalid_response", "CLIProxyAPI control response is invalid", 503);
    return result;
  }

  async reconcileMany(providerIds: string[], signal?: AbortSignal): Promise<CliProxyControlReconciliationSummary[]> {
    if (!Array.isArray(providerIds) || providerIds.length < 1 || providerIds.length > 50 || new Set(providerIds).size !== providerIds.length) {
      throw new RelayError("cliproxy_reconcile_batch_invalid", "CLIProxyAPI reconcile batch is invalid", 400);
    }
    const result = await this.#request("v1/providers/reconcile", {
      method: "POST",
      body: { providerIds },
      ...(signal ? { signal } : {}),
    });
    if (!isRecord(result) || Object.keys(result).length !== 1 || !Array.isArray(result.items)
      || result.items.length !== providerIds.length || !result.items.every(isReconciliationSummary)) {
      throw new RelayError("cliproxy_control_invalid_response", "CLIProxyAPI control response is invalid", 503);
    }
    const observations = result.items as CliProxyControlReconciliationSummary[];
    const observedIds = observations.map((observation) => observation.providerId);
    if (new Set(observedIds).size !== observedIds.length || providerIds.some((providerId) => !observedIds.includes(providerId))) {
      throw new RelayError("cliproxy_control_invalid_response", "CLIProxyAPI control response is invalid", 503);
    }
    return observations;
  }

  async semanticCredentialReadiness(signal?: AbortSignal): Promise<CliProxyCredentialSemanticReadiness> {
    const result = await this.#request("v1/readiness/credential-probes", { method: "POST", ...(signal ? { signal } : {}) });
    if (!isCredentialSemanticReadiness(result)) throw new RelayError("cliproxy_control_invalid_response", "CLIProxyAPI credential readiness response is invalid", 503);
    return result;
  }

  async runtimeIdentity(signal?: AbortSignal): Promise<CliProxyControlRuntimeIdentity> {
    const result = await this.#request("v1/runtime", { method: "GET", ...(signal ? { signal } : {}) });
    if (!isRuntimeIdentity(result)) throw new RelayError("cliproxy_control_invalid_response", "CLIProxyAPI control response is invalid", 503);
    return result;
  }

  startOAuth(input: { providerId: string; kind: CliProxyProviderKind; actorId: string; signal?: AbortSignal }): Promise<{ sessionId: string; authorizationUrl: string; expiresAt: string }> {
    return this.#request(`v1/providers/${encodeURIComponent(input.providerId)}/oauth/start`, {
      method: "POST",
      body: { kind: input.kind, actorId: input.actorId },
      ...(input.signal ? { signal: input.signal } : {})
    }) as Promise<{ sessionId: string; authorizationUrl: string; expiresAt: string }>;
  }

  submitOAuthCallback(input: { providerId: string; actorId: string; sessionId: string; callbackUrl: string; signal?: AbortSignal }): Promise<{ status: "accepted" }> {
    return this.#request(`v1/providers/${encodeURIComponent(input.providerId)}/oauth/callback`, {
      method: "POST",
      body: { actorId: input.actorId, sessionId: input.sessionId, callbackUrl: input.callbackUrl },
      ...(input.signal ? { signal: input.signal } : {})
    }) as Promise<{ status: "accepted" }>;
  }

  async oauthStatus(input: { providerId: string; actorId: string; sessionId: string; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ actorId: input.actorId, sessionId: input.sessionId });
    const result = await this.#request(`v1/providers/${encodeURIComponent(input.providerId)}/oauth/status?${query}`, {
      method: "GET",
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (!isRecord(result) || result.sessionId !== input.sessionId) throw invalidControlResponse();
    if (result.status === "pending" && Object.keys(result).length === 2) return result;
    if (result.status === "ready" && Object.keys(result).length === 3 && isCredentialSummary(result.credential)
      && result.credential.providerId === input.providerId && result.credential.authMethod === "oauth") return result;
    throw invalidControlResponse();
  }

  async #request(path: string, input: { method: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; signal?: AbortSignal }): Promise<unknown> {
    const retryOnTransportFailure = input.method === "GET" || input.method === "PUT";
    const maxAttempts = retryOnTransportFailure ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
      let response: Response;
      try {
        response = await fetchControl(new URL(path, this.#baseUrl), {
          method: input.method,
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            accept: "application/json",
            ...(input.body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(this.#timeoutMs)]) : AbortSignal.timeout(this.#timeoutMs),
          redirect: "error",
          dispatcher
        } as Record<string, unknown>);
      } catch {
        await dispatcher.destroy().catch(() => undefined);
        if (attempt === maxAttempts || input.signal?.aborted) {
          throw new RelayError("cliproxy_control_unavailable", "CLIProxyAPI control service is unavailable", 503);
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        continue;
      }
      try {
        const result = await readJsonBounded(response, CLIPROXY_CONTROL_PAYLOAD_MAX_BYTES);
        if (!response.ok) {
          const code = isRecord(result) && isRecord(result.error) && typeof result.error.code === "string"
            ? result.error.code
            : "cliproxy_control_rejected";
          throw new RelayError(/^cliproxy_[a-z0-9_]{1,96}$/.test(code) ? code : "cliproxy_control_rejected", "CLIProxyAPI control operation failed", response.status >= 400 && response.status < 500 ? response.status : 503);
        }
        return result;
      } finally {
        await dispatcher.close().catch(() => undefined);
      }
    }
    throw new RelayError("cliproxy_control_unavailable", "CLIProxyAPI control service is unavailable", 503);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const CREDENTIAL_SUMMARY_FIELDS = new Set([
  "credentialRef", "providerId", "kind", "authMethod", "preview", "status", "failureReason", "errorCode", "updatedAt", "models",
]);

function isCredentialSummary(value: unknown): value is CliProxyControlCredentialSummary {
  return isRecord(value)
    && Object.keys(value).length === CREDENTIAL_SUMMARY_FIELDS.size
    && Object.keys(value).every((key) => CREDENTIAL_SUMMARY_FIELDS.has(key))
    && isProviderId(value.providerId)
    && isCredentialRef(value.credentialRef)
    && CLI_PROXY_PROVIDER_KINDS.includes(value.kind as CliProxyProviderKind)
    && (value.authMethod === "api-key" || value.authMethod === "oauth" || value.authMethod === "credential-import")
    && typeof value.preview === "string" && value.preview.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value.preview)
    && credentialHealthFieldsValid(value.status, value.failureReason, value.errorCode)
    && isIsoTimestamp(value.updatedAt)
    && isModelList(value.models);
}

function isCredentialSemanticReadiness(value: unknown): value is CliProxyCredentialSemanticReadiness {
  if (!isRecord(value)
    || Object.keys(value).length !== 4
    || value.schema !== "friday-relay.cpa-credential-semantic-readiness.v1"
    || !/^cpa_[a-z0-9][a-z0-9_-]{0,62}$/.test(String(value.cpaInstanceId))
    || (value.status !== "ready" && value.status !== "unready")
    || !Array.isArray(value.probes)
    || value.probes.length < 1) return false;
  const probesValid = value.probes.every((probe) => isRecord(probe)
    && Object.keys(probe).length === 6
    && isProviderId(probe.providerId)
    && isModelName(probe.model)
    && credentialHealthFieldsValid(probe.status, probe.failureReason, probe.errorCode)
    && isIsoTimestamp(probe.probedAt));
  return probesValid && (value.status === "ready"
    ? value.probes.every((probe) => isRecord(probe) && probe.status === "ready")
    : value.probes.some((probe) => isRecord(probe) && probe.status === "unready"));
}

function credentialHealthFieldsValid(status: unknown, failureReason: unknown, errorCode: unknown): boolean {
  if (status === "ready") return failureReason === null && errorCode === null;
  return status === "unready"
    && isProviderCredentialFailureReason(failureReason)
    && errorCode === credentialFailureCode(failureReason);
}

function credentialFailureCode(reason: ProviderCredentialFailureReason): CliProxyCredentialFailureCode {
  if (reason === "auth_unauthorized") return "cliproxy_provider_credentials_unauthorized";
  if (reason === "auth_unavailable") return "cliproxy_provider_credentials_unavailable";
  if (reason === "auth_not_found") return "cliproxy_provider_credentials_not_found";
  return "cliproxy_provider_credentials_cooldown";
}

function isProviderId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value);
}

function isCredentialRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function isModelName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isModelList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isModelName) && new Set(value).size === value.length;
}

function invalidControlResponse(): RelayError {
  return new RelayError("cliproxy_control_invalid_response", "CLIProxyAPI control response is invalid", 503);
}

function isRuntimeIdentity(value: unknown): value is CliProxyControlRuntimeIdentity {
  return isRecord(value)
    && Object.keys(value).length === 5
    && /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value.version))
    && /^[a-f0-9]{7,40}$/i.test(String(value.commit))
    && typeof value.buildDate === "string"
    && Number.isFinite(Date.parse(value.buildDate))
    && value.evidenceContract === "cpa-basic@1"
    && value.adaptation === "friday-evidence-v1";
}

const RECONCILIATION_SUMMARY_FIELDS = new Set([
  "providerId",
  "credentialRef",
  "credentialStatus",
  "credentialFailureReason",
  "credentialErrorCode",
  "configuredModels",
  "catalogStatus",
  "catalogPresentModels",
  "catalogMissingModels",
  "catalogAttemptedAt",
  "catalogCheckedAt",
  "lastSuccessfulCatalogCheckedAt",
  "catalogErrorCode",
  "stale"
]);

function isReconciliationSummary(value: unknown): value is CliProxyControlReconciliationSummary {
  return isRecord(value)
    && Object.keys(value).every((key) => RECONCILIATION_SUMMARY_FIELDS.has(key))
    && Object.keys(value).length === RECONCILIATION_SUMMARY_FIELDS.size
    && isProviderId(value.providerId)
    && (value.credentialRef === null || isCredentialRef(value.credentialRef))
    && credentialHealthFieldsValid(value.credentialStatus, value.credentialFailureReason, value.credentialErrorCode)
    && (value.credentialStatus !== "ready" || value.credentialRef !== null)
    && isModelList(value.configuredModels)
    && ["full", "partial", "empty", "unknown"].includes(String(value.catalogStatus))
    && isModelList(value.catalogPresentModels)
    && isModelList(value.catalogMissingModels)
    && isIsoTimestamp(value.catalogAttemptedAt)
    && (value.catalogCheckedAt === null || isIsoTimestamp(value.catalogCheckedAt))
    && (value.lastSuccessfulCatalogCheckedAt === null || isIsoTimestamp(value.lastSuccessfulCatalogCheckedAt))
    && (value.catalogErrorCode === null || /^cliproxy_[a-z0-9_]{1,96}$/.test(String(value.catalogErrorCode)))
    && typeof value.stale === "boolean"
    && (value.catalogStatus === "unknown"
      ? value.catalogCheckedAt === null
        && value.catalogErrorCode !== null
        && value.catalogPresentModels.length === 0
        && value.catalogMissingModels.length === 0
        && value.stale === (value.lastSuccessfulCatalogCheckedAt !== null)
      : value.catalogCheckedAt !== null
        && value.lastSuccessfulCatalogCheckedAt === value.catalogCheckedAt
        && value.catalogErrorCode === null
        && value.stale === false);
}

const CONFIRMED_CREDENTIAL_FAILURES = new Set([
  "cliproxy_provider_credentials_unauthorized",
  "cliproxy_provider_credentials_unavailable",
  "cliproxy_provider_credentials_not_found",
  "cliproxy_provider_credentials_cooldown",
]);

export function isConfirmedCliProxyCredentialFailureCode(code: string | null | undefined): boolean {
  return typeof code === "string" && CONFIRMED_CREDENTIAL_FAILURES.has(code);
}

export function isConfirmedCliProxyCredentialFailure(error: unknown): boolean {
  return error instanceof RelayError && isConfirmedCliProxyCredentialFailureCode(error.code);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new RelayError("cliproxy_control_invalid_response", "CLIProxyAPI control response is too large", 503);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const encoded = Buffer.concat(chunks).toString("utf8");
  if (!encoded) return {};
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new RelayError("cliproxy_control_invalid_response", "CLIProxyAPI control response is invalid", 503);
  }
}
