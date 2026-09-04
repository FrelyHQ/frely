import {
  applyAccessPointRequestOverrides,
  parseAccessPointRequestOverridesJson,
  RelayError,
} from "@frely/core";
import type { AccessPoint } from "@frely/application/runtime";
import { normalizeRuntimePriceServiceTier } from "@frely/pricing";

export interface AccessPointRequestContext {
  effectivePayload: Record<string, unknown>;
  billingServiceTier: string;
  requireProviderServiceTier: boolean;
}

export function accessPointRequestContext(
  payload: Readonly<Record<string, unknown>>,
  accessPoint: AccessPoint,
): AccessPointRequestContext {
  let overrides;
  try {
    overrides = parseAccessPointRequestOverridesJson(accessPoint.requestOverridesJson ?? "{}");
  } catch (error) {
    throw new RelayError(
      "access_point_request_overrides_invalid",
      error instanceof Error ? error.message : "Stored AccessPoint request overrides are invalid",
      500,
    );
  }
  const effectivePayload = applyAccessPointRequestOverrides(payload, overrides);
  const requestedServiceTier = typeof effectivePayload.service_tier === "string"
    ? effectivePayload.service_tier
    : undefined;
  const forcedServiceTier = typeof overrides.service_tier === "string"
    ? overrides.service_tier.toLowerCase()
    : undefined;
  return {
    effectivePayload,
    billingServiceTier: normalizeRuntimePriceServiceTier(requestedServiceTier),
    requireProviderServiceTier: forcedServiceTier === "fast" || forcedServiceTier === "priority",
  };
}
