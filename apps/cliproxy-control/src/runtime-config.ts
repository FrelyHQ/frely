import { validateOAuthSessionTtlMs } from "./service.js";
import { parseStoreKey } from "./store.js";
import { parseConfiguredPrivateProviderOrigin } from "@frely/core";

export interface CliProxyControlRuntimeConfig {
  port: number;
  controlKey: string;
  storePath: string;
  storeKey: Buffer;
  baseUrl: string;
  managementKey: string;
  inferenceKey: string;
  cpaInstanceId: string;
  oauthSessionTtlMs: number;
  privateProviderOrigin?: string;
}

export function loadCliProxyControlRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): CliProxyControlRuntimeConfig {
  const baseUrl = parseBaseUrl(environment.CLIPROXY_BASE_URL ?? "http://cli-proxy-api:8317");
  const managementKey = requireSecret(environment.CLIPROXY_MANAGEMENT_API_KEY, "cliproxy_management_key_required");
  const inferenceKey = requireSecret(environment.CLIPROXY_API_KEY, "cliproxy_inference_key_required");
  const privateProviderOrigin = parseTailscalePrivateOrigin(environment.CLIPROXY_CONTROL_PRIVATE_PROVIDER_ORIGIN);
  if (managementKey === inferenceKey) throw new Error("cliproxy_control_keys_not_separated");
  return {
    port: parsePort(environment.PORT ?? "8319"),
    controlKey: requireSecret(environment.CLIPROXY_CONTROL_API_KEY, "cliproxy_control_api_key_required"),
    storePath: environment.CLIPROXY_CREDENTIAL_STORE_PATH ?? "/var/lib/cliproxy-control/credentials.v1.enc",
    storeKey: parseStoreKey(environment.CLIPROXY_CREDENTIAL_STORE_KEY),
    baseUrl,
    managementKey,
    inferenceKey,
    cpaInstanceId: parseCpaInstanceId(environment.CLIPROXY_CPA_INSTANCE_ID ?? "cpa_default"),
    oauthSessionTtlMs: validateOAuthSessionTtlMs(Number(environment.CLIPROXY_OAUTH_SESSION_TTL_MS ?? 600_000)),
    ...(privateProviderOrigin ? { privateProviderOrigin } : {})
  };
}

function parseCpaInstanceId(value: string): string {
  const normalized = value.trim();
  if (!/^cpa_[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) throw new Error("cliproxy_cpa_instance_id_invalid");
  return normalized;
}

function parseBaseUrl(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("cliproxy_base_url_invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function requireSecret(value: string | undefined, code: string): string {
  if (!value || value.length < 32) throw new Error(code);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("cliproxy_control_port_invalid");
  return port;
}

function parseTailscalePrivateOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return parseConfiguredPrivateProviderOrigin(value).origin;
  } catch {
    throw new Error("cliproxy_private_provider_origin_invalid");
  }
}
