import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { RelayError } from "@frely/core";
import { CliProxyClient, type CliProxyClientOptions } from "./client.js";
import { DEFAULT_CLIPROXY_TIMEOUT_MS } from "./config.js";

export const CPA_CONNECTION_REGISTRY_ENV = "FRIDAY_RELAY_CPA_CONNECTION_REGISTRY_FILE";
export const DEFAULT_CPA_INSTANCE_ID = "cpa_default";

export interface CpaConnectionRegistryEntry {
  inferenceOrigin: string;
  controlOrigin: string;
  inferenceKeyFile: string;
  controlKeyFile: string;
}

export interface CpaConnectionRegistry {
  schemaVersion: 1;
  instances: Readonly<Record<string, CpaConnectionRegistryEntry>>;
}

interface RegistryFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  statSync(path: string): { mode: number };
}

const defaultFileSystem: RegistryFileSystem = { readFileSync, statSync };

export function loadCpaConnectionRegistry(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fileSystem: RegistryFileSystem = defaultFileSystem,
): CpaConnectionRegistry | null {
  const path = environment[CPA_CONNECTION_REGISTRY_ENV]?.trim();
  if (!path) return null;
  if (!isAbsolute(path)) throw registryError("CPA connection registry path must be absolute");
  let raw: unknown;
  try {
    raw = JSON.parse(fileSystem.readFileSync(path, "utf8"));
  } catch {
    throw registryError("CPA connection registry is unavailable or invalid");
  }
  const registry = parseRegistry(raw, environment.NODE_ENV === "production");
  return deepFreeze(registry);
}

export function cpaConnectionEntry(registry: CpaConnectionRegistry, instanceId: string): CpaConnectionRegistryEntry {
  assertCpaInstanceId(instanceId);
  const entry = registry.instances[instanceId];
  if (!entry) throw new RelayError("cpa_instance_connection_missing", "CPA Instance connection is not configured", 503);
  return entry;
}

export function readCpaSecret(
  filePath: string,
  purpose: "inference" | "control",
  fileSystem: RegistryFileSystem = defaultFileSystem,
): string {
  if (!isAbsolute(filePath)) throw registryError("CPA secret path must be absolute");
  let secret: string;
  try {
    assertSecretFileMode(filePath, fileSystem);
    secret = fileSystem.readFileSync(filePath, "utf8").trim();
  } catch {
    throw new RelayError("cpa_instance_credential_missing", `CPA ${purpose} credential is not configured`, 503);
  }
  if (secret.length < 32 || looksLikePlaceholder(secret)) {
    throw new RelayError("cpa_instance_credential_missing", `CPA ${purpose} credential is not configured`, 503);
  }
  return secret;
}

export function createCpaInferenceClient(
  registry: CpaConnectionRegistry,
  instanceId: string,
  options: { clientOptions?: CliProxyClientOptions; timeoutMs?: number } = {},
  fileSystem: RegistryFileSystem = defaultFileSystem,
): CliProxyClient {
  const entry = cpaConnectionEntry(registry, instanceId);
  return new CliProxyClient({
    baseUrl: entry.inferenceOrigin,
    apiKey: readCpaSecret(entry.inferenceKeyFile, "inference", fileSystem),
    managementApiKey: null,
    timeoutMs: options.timeoutMs ?? DEFAULT_CLIPROXY_TIMEOUT_MS,
  }, options.clientOptions);
}

export function assertCpaInstanceId(value: string): void {
  if (!/^cpa_[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) throw registryError("CPA Instance ID is invalid");
}

function parseRegistry(value: unknown, production: boolean): CpaConnectionRegistry {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.instances) || Object.keys(value).some((key) => key !== "schemaVersion" && key !== "instances")) {
    throw registryError("CPA connection registry schema is invalid");
  }
  const instances: Record<string, CpaConnectionRegistryEntry> = {};
  for (const [instanceId, rawEntry] of Object.entries(value.instances)) {
    assertCpaInstanceId(instanceId);
    if (!isRecord(rawEntry) || Object.keys(rawEntry).some((key) => !["inferenceOrigin", "controlOrigin", "inferenceKeyFile", "controlKeyFile"].includes(key))) {
      throw registryError("CPA connection registry entry is invalid");
    }
    const entry = {
      inferenceOrigin: parseOrigin(rawEntry.inferenceOrigin, production, instanceId, "inference"),
      controlOrigin: parseOrigin(rawEntry.controlOrigin, production, instanceId, "control"),
      inferenceKeyFile: parseSecretPath(rawEntry.inferenceKeyFile),
      controlKeyFile: parseSecretPath(rawEntry.controlKeyFile),
    };
    instances[instanceId] = entry;
  }
  if (!instances[DEFAULT_CPA_INSTANCE_ID]) throw registryError("CPA connection registry must define cpa_default");
  return { schemaVersion: 1, instances };
}

function parseOrigin(value: unknown, production: boolean, instanceId: string, kind: "inference" | "control"): string {
  if (typeof value !== "string" || !value.trim()) throw registryError("CPA connection origin is invalid");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw registryError("CPA connection origin is invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw registryError("CPA connection origin is invalid");
  }
  if (production && url.protocol !== "https:" && !isDefaultInternalOrigin(url, instanceId, kind)) {
    throw registryError("Remote CPA connection origin must use HTTPS");
  }
  return url.toString().replace(/\/$/u, "");
}

function isDefaultInternalOrigin(url: URL, instanceId: string, kind: "inference" | "control"): boolean {
  return instanceId === DEFAULT_CPA_INSTANCE_ID
    && ((kind === "inference" && url.hostname === "cli-proxy-api" && url.port === "8317")
      || (kind === "control" && url.hostname === "cliproxy-control" && url.port === "8319"));
}

function parseSecretPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value.trim())) throw registryError("CPA secret path is invalid");
  return value.trim();
}

function assertSecretFileMode(path: string, fileSystem: RegistryFileSystem): void {
  try {
    const mode = fileSystem.statSync(path).mode;
    if ((mode & 0o077) !== 0) throw registryError("CPA secret file permissions are too broad");
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError("cpa_instance_credential_missing", "CPA secret file is unavailable", 503);
  }
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[\s_-]+/gu, "");
  return normalized.includes("placeholder") || normalized.includes("changeme") || normalized.includes("example") || /^<.*>$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function registryError(message: string): RelayError {
  return new RelayError("cpa_registry_invalid", message, 503);
}
