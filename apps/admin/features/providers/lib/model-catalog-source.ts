import type { Provider, ProviderModel } from "@frely/ui-application/contracts";

type ProviderCatalogSourceInput = Pick<Provider, "id" | "baseUrlResolver" | "modelsResolver">;
type ProviderModelCatalogInput = Pick<ProviderModel, "providerId" | "providerModelName">;

export interface UniqueProviderModelCatalogEntry {
  key: string;
  catalogSource: string;
  providerModelName: string;
  providerModels: ProviderModelCatalogInput[];
}

export function countUniqueProviderModels(providers: ProviderCatalogSourceInput[], providerModels: ProviderModelCatalogInput[]): number {
  return listUniqueProviderModelCatalogEntries(providers, providerModels).length;
}

export function listUniqueProviderModelCatalogEntries(providers: ProviderCatalogSourceInput[], providerModels: ProviderModelCatalogInput[]): UniqueProviderModelCatalogEntry[] {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const entriesByKey = new Map<string, UniqueProviderModelCatalogEntry>();

  for (const model of providerModels) {
    const provider = providersById.get(model.providerId);
    const source = provider ? modelCatalogSource(provider) : `provider:${model.providerId}`;
    const key = `${source}\0${model.providerModelName}`;
    const existing = entriesByKey.get(key);
    if (existing) {
      existing.providerModels.push(model);
    } else {
      entriesByKey.set(key, { key, catalogSource: source, providerModelName: model.providerModelName, providerModels: [model] });
    }
  }

  return Array.from(entriesByKey.values());
}

export function countModelCatalogSources(providers: ProviderCatalogSourceInput[]): number {
  return new Set(providers.map(modelCatalogSource)).size;
}

function modelCatalogSource(provider: ProviderCatalogSourceInput): string {
  const modelsResolver = resolverParts(provider.modelsResolver);
  const baseUrl = literalResolverValue(provider.baseUrlResolver);

  if (modelsResolver?.fnName === "provider" && modelsResolver.fnArg.startsWith("path:") && baseUrl) {
    return `url:${normalizeJoinedUrl(baseUrl, modelsResolver.fnArg.slice("path:".length))}`;
  }

  if (modelsResolver?.fnName === "url") return `url:${normalizeUrl(modelsResolver.fnArg)}`;
  if (baseUrl) return `base:${normalizeUrl(baseUrl)}`;
  return `provider:${provider.id}`;
}

function resolverParts(resolver: string): { fnName: string; fnArg: string } | undefined {
  const separator = resolver.indexOf(":");
  if (separator <= 0) return undefined;
  return { fnName: resolver.slice(0, separator), fnArg: resolver.slice(separator + 1) };
}

function literalResolverValue(resolver: string): string | undefined {
  const parts = resolverParts(resolver);
  if (parts?.fnName !== "literal") return undefined;
  return parts.fnArg || undefined;
}

function normalizeJoinedUrl(baseUrl: string, path: string): string {
  return normalizeUrl(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}
