import { cliProxyConfigurationError } from "./errors.js";

export const DEFAULT_CLIPROXY_BASE_URL = "http://cli-proxy-api:8317";
export const DEFAULT_CLIPROXY_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_CLIPROXY_PRODUCTION_HOST_ALLOWLIST = ["cli-proxy-api:8317"] as const;
export const CLIPROXY_REDACTED = "[REDACTED]";

export interface CliProxyConfig {
  baseUrl: string;
  apiKey: string | null;
  managementApiKey: string | null;
  timeoutMs: number;
}

export interface LoadCliProxyConfigOptions {
  production?: boolean;
  productionHostAllowlist?: readonly string[];
  timeoutMs?: number;
}

export function loadCliProxyConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: LoadCliProxyConfigOptions = {}
): CliProxyConfig {
  const baseUrl = validateCliProxyBaseUrl(env.CLIPROXY_BASE_URL ?? DEFAULT_CLIPROXY_BASE_URL, {
    production: options.production ?? env.NODE_ENV === "production",
    ...(options.productionHostAllowlist ? { productionHostAllowlist: options.productionHostAllowlist } : {})
  });
  const production = options.production ?? env.NODE_ENV === "production";
  const apiKey = secretOrNull(env.CLIPROXY_API_KEY, production, "CLIPROXY_API_KEY");
  const managementApiKey = secretOrNull(env.CLIPROXY_MANAGEMENT_API_KEY, production, "CLIPROXY_MANAGEMENT_API_KEY");
  if (apiKey && managementApiKey && apiKey === managementApiKey) {
    throw cliProxyConfigurationError("CLIProxyAPI inference and management credentials must be different");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLIPROXY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60_000) {
    throw cliProxyConfigurationError("CLIProxyAPI timeout is invalid");
  }
  return { baseUrl, apiKey, managementApiKey, timeoutMs };
}

export function validateCliProxyBaseUrl(
  value: string,
  options: Pick<LoadCliProxyConfigOptions, "production" | "productionHostAllowlist"> = {}
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw cliProxyConfigurationError("CLIProxyAPI base URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw cliProxyConfigurationError("CLIProxyAPI base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw cliProxyConfigurationError("CLIProxyAPI base URL cannot include userinfo, query, or fragment components");
  }
  if (!url.hostname) throw cliProxyConfigurationError("CLIProxyAPI base URL host is required");
  if (options.production) {
    const allowlist = options.productionHostAllowlist ?? DEFAULT_CLIPROXY_PRODUCTION_HOST_ALLOWLIST;
    if (!allowlist.includes(url.host)) {
      throw cliProxyConfigurationError("CLIProxyAPI production host is not allowed");
    }
  }
  return url.toString().replace(/\/$/, "");
}

export function assertCliProxyInferenceConfig(config: CliProxyConfig): asserts config is CliProxyConfig & { apiKey: string } {
  if (!config.apiKey) throw cliProxyConfigurationError("CLIProxyAPI inference credential is not configured");
}

export function assertCliProxyManagementConfig(config: CliProxyConfig): asserts config is CliProxyConfig & { managementApiKey: string } {
  if (!config.managementApiKey) throw cliProxyConfigurationError("CLIProxyAPI management credential is not configured");
}

export function redactCliProxySecret(value: string | null | undefined): string | null {
  return value ? CLIPROXY_REDACTED : null;
}

export function redactCliProxyUrl(value: string | null | undefined): string | null {
  return value ? CLIPROXY_REDACTED : null;
}

export function safeCliProxyConfig(config: CliProxyConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    baseUrl: redactCliProxyUrl(config.baseUrl),
    apiKey: redactCliProxySecret(config.apiKey),
    managementApiKey: redactCliProxySecret(config.managementApiKey),
    timeoutMs: config.timeoutMs
  });
}

function secretOrNull(value: string | undefined, production: boolean, name: string): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (production && (normalized.length < 32 || looksLikePlaceholder(normalized))) {
    throw cliProxyConfigurationError(`${name} must be a non-placeholder secret of at least 32 characters in production`);
  }
  return normalized;
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[\s_-]+/gu, "");
  return normalized.includes("placeholder")
    || normalized.includes("changeme")
    || normalized.includes("deploymentsecret")
    || normalized.includes("example")
    || /^<.*>$/u.test(value);
}
