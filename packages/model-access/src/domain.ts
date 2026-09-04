import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import {
  normalizeAccessPointRequestOverrides,
  normalizeAccessPointSelectorConfig,
  RelayError,
  type AccessPointRequestOverrides,
  type AccessPointSelectorId,
  type AccessPointTargetType,
} from "@frely/core";

export interface RoutingTargetInput {
  id?: string;
  type: AccessPointTargetType;
  targetAccessPointId?: string | null;
  targetProviderId?: string | null;
  targetProviderModelName?: string | null;
  position: number;
  status?: "enabled" | "disabled";
}

export interface RoutingDefinitionInput {
  selector: {
    id: AccessPointSelectorId;
    behaviorVersion: 1;
    config?: unknown;
  };
  requestOverrides?: unknown;
  targets: RoutingTargetInput[];
  expectedRoutingRevision?: number;
}

export interface NormalizedRoutingTarget {
  id?: string;
  type: AccessPointTargetType;
  targetAccessPointId: string | null;
  targetProviderId: string | null;
  targetProviderModelName: string | null;
  position: number;
  status: "enabled" | "disabled";
}

export interface NormalizedRoutingDefinition {
  ruleId: AccessPointSelectorId;
  behaviorVersion: 1;
  config: Readonly<Record<string, unknown>>;
  configJson: string;
  requestOverrides: AccessPointRequestOverrides;
  requestOverridesJson: string;
  targets: NormalizedRoutingTarget[];
}

export function normalizeRoutingDefinition(
  input: RoutingDefinitionInput,
  targetModel: string,
): NormalizedRoutingDefinition {
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new RelayError("invalid_access_point_routing", "AccessPoint requires at least one target", 400);
  }
  const ids = new Set<string>();
  const positions = new Set<number>();
  const targets = input.targets.map((candidate, index): NormalizedRoutingTarget => {
    const position = candidate.position;
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new RelayError("invalid_access_point_routing", `routing.targets[${index}].position must be a non-negative integer`, 400);
    }
    if (positions.has(position)) {
      throw new RelayError("invalid_access_point_routing", `Routing target position ${position} is duplicated`, 400);
    }
    positions.add(position);
    if (candidate.id) {
      if (ids.has(candidate.id)) throw new RelayError("invalid_access_point_routing", `Routing target id ${candidate.id} is duplicated`, 400);
      ids.add(candidate.id);
    }
    if (candidate.type === "access-point") {
      const targetAccessPointId = requiredTrimmed(candidate.targetAccessPointId, `routing.targets[${index}].targetAccessPointId`);
      if (candidate.targetProviderId || candidate.targetProviderModelName) {
        throw new RelayError("invalid_access_point_routing", "AccessPoint target cannot contain Provider identity", 400);
      }
      return {
        ...(candidate.id ? { id: candidate.id } : {}),
        type: candidate.type,
        targetAccessPointId,
        targetProviderId: null,
        targetProviderModelName: null,
        position,
        status: candidate.status ?? "enabled",
      };
    }
    if (candidate.type !== "provider-model") {
      throw new RelayError("invalid_access_point_target", "Routing target type must be provider-model or access-point", 400);
    }
    const targetProviderId = requiredTrimmed(candidate.targetProviderId, `routing.targets[${index}].targetProviderId`);
    const targetProviderModelName = requiredTrimmed(candidate.targetProviderModelName ?? targetModel, `routing.targets[${index}].targetProviderModelName`);
    if (targetProviderModelName !== targetModel) {
      throw new RelayError("access_point_target_model_mismatch", "targetProviderModelName must equal targetModel", 400);
    }
    if (candidate.targetAccessPointId) {
      throw new RelayError("invalid_access_point_routing", "Provider target cannot contain AccessPoint identity", 400);
    }
    return {
      ...(candidate.id ? { id: candidate.id } : {}),
      type: candidate.type,
      targetAccessPointId: null,
      targetProviderId,
      targetProviderModelName,
      position,
      status: candidate.status ?? "enabled",
    };
  }).sort((left, right) => left.position - right.position || String(left.id ?? "").localeCompare(String(right.id ?? "")));

  const enabledTargetCount = targets.filter((target) => target.status === "enabled").length;
  let config: Readonly<Record<string, unknown>>;
  try {
    config = normalizeAccessPointSelectorConfig(
      input.selector.id,
      input.selector.behaviorVersion,
      input.selector.config ?? {},
      enabledTargetCount,
    ) as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new RelayError(
      "invalid_access_point_routing_rule",
      error instanceof Error ? error.message : "AccessPoint routing rule is invalid",
      400,
    );
  }
  const configJson = canonicalize(config);
  if (configJson === undefined) throw new RelayError("invalid_access_point_routing_rule", "AccessPoint routing config is not canonical JSON", 400);
  let requestOverrides: AccessPointRequestOverrides;
  try {
    requestOverrides = normalizeAccessPointRequestOverrides(input.requestOverrides ?? {});
  } catch (error) {
    throw new RelayError(
      "invalid_access_point_request_overrides",
      error instanceof Error ? error.message : "AccessPoint request overrides are invalid",
      400,
    );
  }
  const requestOverridesJson = canonicalize(requestOverrides);
  if (requestOverridesJson === undefined) throw new RelayError("invalid_access_point_request_overrides", "AccessPoint request overrides are not canonical JSON", 400);
  return {
    ruleId: input.selector.id,
    behaviorVersion: input.selector.behaviorVersion,
    config,
    configJson,
    requestOverrides,
    requestOverridesJson,
    targets,
  };
}

export function routingSemanticFingerprint(input: {
  exposedModel: string;
  targetModel: string;
  ruleId: string;
  behaviorVersion: number;
  configJson: string;
  requestOverridesJson: string;
  targets: ReadonlyArray<{
    id: string;
    type: string;
    targetAccessPointId: string | null;
    targetProviderId: string | null;
    targetProviderModelName: string | null;
    targetProviderModelId: string | null;
    position: number;
    status: string;
    removedAt?: string | null;
  }>;
}): string {
  const enabledTargets = input.targets
    .filter((target) => target.status === "enabled" && !target.removedAt)
    .map((target) => ({
      id: target.id,
      type: target.type,
      targetAccessPointId: target.targetAccessPointId,
      targetProviderId: target.targetProviderId,
      targetProviderModelName: target.targetProviderModelName,
      targetProviderModelId: target.targetProviderModelId,
      position: target.position,
    }))
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  const value = canonicalize({
    exposedModel: input.exposedModel,
    targetModel: input.targetModel,
    ruleId: input.ruleId,
    behaviorVersion: input.behaviorVersion,
    config: JSON.parse(input.configJson) as unknown,
    requestOverrides: JSON.parse(input.requestOverridesJson) as unknown,
    enabledTargets,
  });
  if (value === undefined) throw new Error("access_point_routing_fingerprint_failed");
  return value;
}

export function targetIdentityEquals(
  current: {
    targetType: string;
    targetAccessPointId: string | null;
    targetProviderId: string | null;
    targetProviderModelName: string | null;
  },
  next: NormalizedRoutingTarget,
): boolean {
  return current.targetType === next.type
    && current.targetAccessPointId === next.targetAccessPointId
    && current.targetProviderId === next.targetProviderId
    && current.targetProviderModelName === next.targetProviderModelName;
}

export function canonicalModelAccessHash(value: unknown, errorCode: string): string {
  const json = canonicalize(value);
  if (json === undefined) throw new RelayError(errorCode, "Command input is not canonical JSON", 400);
  return createHash("sha256").update(json).digest("hex");
}

function requiredTrimmed(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RelayError("invalid_access_point_routing", `${name} is required`, 400);
  return value.trim();
}
