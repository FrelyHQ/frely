import type { AccessPointSummary } from "../../../features/access-points/types";
import { toJsonObject } from "../page-data";

interface AccessPointBoundarySource {
  id: string;
  ownerId: string;
  scopeRef: string;
  name: string;
  description: string | null;
  apiFamily: string;
  exposedModel: string;
  targetModel: string;
  targetType: string;
  targetId: string | null;
  targetProviderId: string | null;
  targetProviderModelName: string | null;
  priority: number;
  weight: number;
  fallbackOrder: number;
  status: string;
  routing: {
    selector: {
      id: string;
      behaviorVersion: number;
      config: unknown;
    };
    requestOverrides: unknown;
    targets: Array<{
      id: string;
      targetType: string;
      targetAccessPointId: string | null;
      targetProviderId: string | null;
      targetProviderModelName: string | null;
      position: number;
      status: string;
    }>;
    routingRevision: number;
  };
}

type AccessPointImpact = NonNullable<AccessPointSummary["impact"]>;

export function accessPointBoundaryData(
  source: AccessPointBoundarySource,
  impact: AccessPointImpact,
): AccessPointSummary {
  const selectorId = accessPointSelectorId(source.routing.selector.id);
  if (source.routing.selector.behaviorVersion !== 1) {
    throw new Error("access_point_selector_behavior_version_invalid");
  }
  if (!Number.isSafeInteger(source.routing.routingRevision) || source.routing.routingRevision < 1) {
    throw new Error("access_point_routing_revision_invalid");
  }

  return {
    id: source.id,
    ownerId: source.ownerId,
    scopeRef: source.scopeRef,
    name: source.name,
    description: source.description,
    apiFamily: source.apiFamily,
    exposedModel: source.exposedModel,
    targetModel: source.targetModel,
    targetType: accessPointTargetType(source.targetType),
    targetId: source.targetId,
    targetProviderId: source.targetProviderId,
    targetProviderModelName: source.targetProviderModelName,
    priority: source.priority,
    weight: source.weight,
    fallbackOrder: source.fallbackOrder,
    status: source.status,
    routing: {
      selector: {
        id: selectorId,
        behaviorVersion: 1,
        config: accessPointSelectorConfig(source.routing.selector.config),
      },
      requestOverrides: toJsonObject(source.routing.requestOverrides),
      targets: source.routing.targets.map((target) => {
        if (!Number.isSafeInteger(target.position) || target.position < 0) {
          throw new Error("access_point_target_position_invalid");
        }
        return {
          id: target.id,
          targetType: accessPointTargetType(target.targetType),
          targetAccessPointId: target.targetAccessPointId,
          targetProviderId: target.targetProviderId,
          targetProviderModelName: target.targetProviderModelName,
          position: target.position,
          status: accessPointTargetStatus(target.status),
        };
      }),
      routingRevision: source.routing.routingRevision,
    },
    impact: {
      plans: impact.plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        version: plan.version,
      })),
      activeOrFutureSubscriptionCount: impact.activeOrFutureSubscriptionCount,
      exposedModels: [...impact.exposedModels],
    },
  };
}

function accessPointSelectorId(value: string): "direct" | "ordered-fallback" {
  if (value === "direct" || value === "ordered-fallback") return value;
  throw new Error("access_point_selector_id_invalid");
}

function accessPointTargetType(value: string): "provider-model" | "access-point" {
  if (value === "provider-model" || value === "access-point") return value;
  throw new Error("access_point_target_type_invalid");
}

function accessPointTargetStatus(value: string): "enabled" | "disabled" {
  if (value === "enabled" || value === "disabled") return value;
  throw new Error("access_point_target_status_invalid");
}

function accessPointSelectorConfig(value: unknown): {
  maxAttempts?: number;
  retryOn?: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const config: { maxAttempts?: number; retryOn?: string[] } = {};
  if (raw.maxAttempts !== undefined) {
    if (!Number.isSafeInteger(raw.maxAttempts) || Number(raw.maxAttempts) < 1) {
      throw new Error("access_point_selector_max_attempts_invalid");
    }
    config.maxAttempts = Number(raw.maxAttempts);
  }
  if (raw.retryOn !== undefined) {
    if (!Array.isArray(raw.retryOn) || raw.retryOn.some((item) => typeof item !== "string")) {
      throw new Error("access_point_selector_retry_on_invalid");
    }
    config.retryOn = [...raw.retryOn] as string[];
  }
  return config;
}
