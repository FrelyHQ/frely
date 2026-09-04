import { cliProxyProtocolError } from "./errors.js";
import { validateProviderId } from "./provider-id.js";

export interface CliProxyCatalogModel {
  id: string;
  [key: string]: unknown;
}

export function filterCliProxyCatalogForProvider(
  catalog: unknown,
  providerId: string,
  allowlist?: readonly string[]
): CliProxyCatalogModel[] {
  assertProviderPrefix(providerId);
  const root = recordFromUnknown(catalog);
  if (!root || !Array.isArray(root.data)) throw cliProxyProtocolError("CLIProxyAPI model catalog schema is invalid");
  const prefix = `${providerId}/`;
  const allowed = allowlist ? new Set(allowlist) : null;
  const seen = new Set<string>();
  const models: CliProxyCatalogModel[] = [];
  for (const item of root.data) {
    const record = recordFromUnknown(item);
    if (!record || typeof record.id !== "string" || !record.id.startsWith(prefix)) continue;
    const id = record.id.slice(prefix.length);
    if (!id || id.startsWith("/") || allowed && !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ ...record, id });
  }
  return models;
}

export function cliProxyCatalogModelNames(catalog: unknown, providerId: string, allowlist?: readonly string[]): string[] {
  return filterCliProxyCatalogForProvider(catalog, providerId, allowlist).map((model) => model.id);
}

export function assertProviderPrefix(providerId: string): void {
  try {
    validateProviderId(providerId);
  } catch {
    throw cliProxyProtocolError("CLIProxyAPI Provider ID cannot be used as a model prefix");
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
