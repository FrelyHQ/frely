import { RelayError } from "@frely/core";
import { defaultTargetModelForUpstream, type HubConfig, type HubProtocol, type HubRoute, type HubUpstream } from "./config.js";
import { mockOpenAiModels } from "./mock-openai.js";
import { joinUpstreamUrl, requestUpstream, resolveProxyConfig } from "./transport.js";

interface ModelCacheEntry {
  expiresAt: number;
  models: Map<string, UpstreamModelInfo>;
}

interface UpstreamModelInfo {
  id: string;
  context_window?: number;
  supported_parameters?: string[];
  unsupported_parameters?: string[];
}

type HubModelInfo = {
  id: string;
  object: "model";
  created: number;
  owned_by: "friday-hub";
} & Omit<UpstreamModelInfo, "id">;

export class HubModelDiscovery {
  private readonly cache = new Map<string, ModelCacheEntry>();

  constructor(private readonly config: HubConfig) {}

  async listModels(protocol?: HubProtocol): Promise<{ object: "list"; data: HubModelInfo[] }> {
    const routes = this.config.routes.filter((route) => !protocol || route.sourceProtocol === "any" || route.sourceProtocol === protocol);
    const upstreams = new Set<string>();
    for (const route of routes) {
      upstreams.add(route.upstream);
      for (const fallback of route.fallback ?? []) upstreams.add(fallback);
    }
    const modelLists = new Map<string, Map<string, UpstreamModelInfo>>();
    await Promise.all([...upstreams].map(async (upstreamId) => {
      try {
        modelLists.set(upstreamId, await this.refreshUpstreamModels(upstreamId));
      } catch {
        // A single upstream discovery failure must not leak details or hide other upstreams.
      }
    }));
    const visibleModels = new Map<string, HubModelInfo>();
    for (const route of routes.sort((left, right) => right.priority - left.priority || left.upstream.localeCompare(right.upstream))) {
      if (visibleModels.has(route.model)) continue;
      const target = this.availableTargetForRoute(route, modelLists, protocol);
      if (target) visibleModels.set(route.model, hubModelInfo(route.model, target));
    }
    return {
      object: "list",
      data: [...visibleModels.values()].sort((left, right) => left.id.localeCompare(right.id))
    };
  }

  async refreshUpstream(upstreamId: string): Promise<Set<string>> {
    return new Set((await this.refreshUpstreamModels(upstreamId)).keys());
  }

  private async refreshUpstreamModels(upstreamId: string): Promise<Map<string, UpstreamModelInfo>> {
    const upstream = this.config.upstreams.find((candidate) => candidate.id === upstreamId);
    if (!upstream) throw new RelayError("invalid_hub_config", `Unknown upstream ${upstreamId}`, 500);
    const cached = this.cache.get(upstreamId);
    if (cached && cached.expiresAt > Date.now()) return cached.models;
    const models = await this.fetchWithRetry(upstream);
    this.cache.set(upstreamId, {
      expiresAt: Date.now() + this.config.modelDiscovery.cacheTtlSeconds * 1000,
      models
    });
    return models;
  }

  clear(): void {
    this.cache.clear();
  }

  private async fetchWithRetry(upstream: HubUpstream): Promise<Map<string, UpstreamModelInfo>> {
    try {
      return await this.fetchModels(upstream);
    } catch {
      return this.fetchModels(upstream);
    }
  }

  private async fetchModels(upstream: HubUpstream): Promise<Map<string, UpstreamModelInfo>> {
    if (upstream.kind === "mock-openai") return mockOpenAiModels(upstream);
    const response = await requestUpstream(this.config, {
      method: "GET",
      url: joinUpstreamUrl(upstream.baseUrl, modelsEndpointForUpstream(upstream)),
      headers: upstream.apiKeyEnv && process.env[upstream.apiKeyEnv] ? { authorization: `Bearer ${process.env[upstream.apiKeyEnv]}` } : {},
      upstream,
      proxy: resolveProxyConfig(this.config, upstream)
    });
    if (response.status >= 400) throw new RelayError("model_discovery_failed", "Upstream model discovery failed", 502);
    const body = await response.json().catch(() => ({})) as { data?: unknown[] };
    return new Map((Array.isArray(body.data) ? body.data : [])
      .map(upstreamModelInfoFromUnknown)
      .filter((model): model is UpstreamModelInfo => model !== null)
      .map((model) => [model.id, model]));
  }

  private availableTargetForRoute(route: HubRoute, modelLists: Map<string, Map<string, UpstreamModelInfo>>, protocol?: HubProtocol): UpstreamModelInfo | null {
    const primary = this.targetInfo(route.upstream, this.targetModelFor(route.upstream, route.targetModel, route.model), modelLists);
    if (primary) return primary;
    for (const fallbackUpstreamId of route.fallback ?? []) {
      const fallbackRoute = this.config.routes
        .filter((candidate) => candidate.model === route.model && candidate.upstream === fallbackUpstreamId)
        .filter((candidate) => !protocol || candidate.sourceProtocol === "any" || candidate.sourceProtocol === protocol)
        .sort((left, right) => right.priority - left.priority)[0];
      const fallbackModel = this.targetModelFor(fallbackUpstreamId, fallbackRoute?.targetModel, route.model);
      const fallback = this.targetInfo(fallbackUpstreamId, fallbackModel, modelLists);
      if (fallback) return fallback;
    }
    return null;
  }

  private targetInfo(upstreamId: string, model: string, modelLists: Map<string, Map<string, UpstreamModelInfo>>): UpstreamModelInfo | null {
    return modelLists.get(upstreamId)?.get(model) ?? null;
  }

  private targetModelFor(upstreamId: string, explicitModel: string | undefined, fallbackModel: string): string {
    if (explicitModel) return explicitModel;
    const upstream = this.config.upstreams.find((candidate) => candidate.id === upstreamId);
    return upstream ? defaultTargetModelForUpstream(upstream.kind) ?? fallbackModel : fallbackModel;
  }
}

function modelsEndpointForUpstream(upstream: HubUpstream): string {
  return upstream.kind === "local-claude" ? "/v1/models" : "/models";
}

function upstreamModelInfoFromUnknown(value: unknown): UpstreamModelInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  return {
    id: record.id,
    ...(typeof record.context_window === "number" ? { context_window: record.context_window } : {}),
    ...(isStringArray(record.supported_parameters) ? { supported_parameters: record.supported_parameters } : {}),
    ...(isStringArray(record.unsupported_parameters) ? { unsupported_parameters: record.unsupported_parameters } : {})
  };
}

function hubModelInfo(id: string, target: UpstreamModelInfo): HubModelInfo {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "friday-hub",
    ...(typeof target.context_window === "number" ? { context_window: target.context_window } : {}),
    ...(target.supported_parameters ? { supported_parameters: target.supported_parameters } : {}),
    ...(target.unsupported_parameters ? { unsupported_parameters: target.unsupported_parameters } : {})
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
