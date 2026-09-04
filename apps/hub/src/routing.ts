import { RelayError } from "@frely/core";
import { defaultTargetModelForUpstream, defaultTargetProtocolForUpstream, type HubConfig, type HubProtocol, type HubRoute, type HubUpstream } from "./config.js";

export interface ResolvedHubRoute {
  route: HubRoute;
  upstream: HubUpstream;
  targetProtocol: HubProtocol;
  targetModel: string;
}

export function resolveHubRoute(config: HubConfig, sourceProtocol: HubProtocol, model: string): ResolvedHubRoute {
  const route = config.routes
    .filter((candidate) => (candidate.sourceProtocol === "any" || candidate.sourceProtocol === sourceProtocol) && candidate.model === model)
    .sort((left, right) => right.priority - left.priority || left.upstream.localeCompare(right.upstream))[0];
  if (!route) throw new RelayError("route_not_found", `No friday-hub route found for model ${model}`, 404);
  return resolveRouteTarget(config, route, route.upstream, model);
}

export function fallbackCandidates(config: HubConfig, resolved: ResolvedHubRoute, sourceProtocol: HubProtocol, model: string): ResolvedHubRoute[] {
  return (resolved.route.fallback ?? []).map((upstreamId) => {
    const explicit = config.routes
      .filter((route) => (route.sourceProtocol === "any" || route.sourceProtocol === sourceProtocol) && route.model === model && route.upstream === upstreamId)
      .sort((left, right) => right.priority - left.priority)[0];
    const fallbackRoute = explicit ?? { ...resolved.route, targetProtocol: undefined, targetModel: undefined };
    return resolveRouteTarget(config, fallbackRoute, upstreamId, model);
  });
}

export function routeModels(config: HubConfig, sourceProtocol?: HubProtocol): string[] {
  const models = new Set<string>();
  for (const route of config.routes) {
    if (!sourceProtocol || route.sourceProtocol === "any" || route.sourceProtocol === sourceProtocol) {
      models.add(route.model);
    }
  }
  return [...models].sort();
}

function resolveRouteTarget(config: HubConfig, route: HubRoute, upstreamId: string, fallbackModel: string): ResolvedHubRoute {
  const upstream = config.upstreams.find((candidate) => candidate.id === upstreamId);
  if (!upstream) throw new RelayError("invalid_hub_config", `Unknown upstream ${upstreamId}`, 500);
  return {
    route,
    upstream,
    targetProtocol: route.targetProtocol ?? defaultTargetProtocolForUpstream(upstream.kind),
    targetModel: route.targetModel ?? defaultTargetModelForUpstream(upstream.kind) ?? fallbackModel
  };
}
