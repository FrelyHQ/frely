import { RelayError, type ScopeRef } from "@frely/core";

export const PERSONAL_PROVIDER_RETENTION_DAYS = 180;
export const SECONDS_PER_DAY = 86_400;
export const PERSONAL_PROVIDER_AP_LIMIT = 100;

export type PersonalProviderSlotLifecycle = "active" | "expired_hot" | "retention_expired";

export interface PersonalProviderEntitlementPeriodSnapshot {
  readonly id: string;
  readonly providerSlotId: string;
  readonly userId: string;
  readonly sourceAuthorityPurchaseId: string;
  readonly sourceAuthorityProductId: string;
  readonly sourceProductCodeSnapshot: string;
  readonly sourceProductVersionSnapshot: number;
  readonly sourceProductDisplayNameSnapshot: string;
  readonly purchaseAmountUnitsSnapshot: bigint;
  readonly durationDaysSnapshot: number;
  readonly renewalAdmittedAt: string;
  readonly fulfillmentSucceededAt: string;
  readonly effectiveStart: string;
  readonly effectiveEnd: string;
  readonly planSubscriptionId: string;
  readonly lifecycle: "active";
  readonly createdAt: string;
}

export interface PersonalProviderSlotSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly scopeRef: ScopeRef;
  readonly managedPlanId: string;
  readonly providerId: string | null;
  readonly createdByAuthorityPurchaseId: string;
  readonly retentionExpiredAt: string | null;
  readonly cleanupStatus: "not_due" | "pending" | "blocked" | "complete";
  readonly cleanupErrorCode: string | null;
  readonly cleanupUpdatedAt: string | null;
  readonly createdAt: string;
  readonly latestEffectiveEnd: string;
  readonly renewalCutoff: string;
  readonly lifecycle: PersonalProviderSlotLifecycle;
  readonly usedAccessPoints: number;
  readonly maxAccessPoints: 100;
}

export type PersonalProviderSlotAccessDecision =
  | Readonly<{ kind: "allowed"; state: "active"; slotId: string; effectiveEnd: string }>
  | Readonly<{ kind: "denied"; state: "expired_hot" | "retention_expired" | "not_found"; slotId: string | null; latestEffectiveEnd: string | null; renewalCutoff: string | null }>;

export function personalProviderSlotLifecycle(input: {
  at: string;
  latestEffectiveEnd: string;
  retentionExpiredAt: string | null;
}): Readonly<{ lifecycle: PersonalProviderSlotLifecycle; renewalCutoff: string }> {
  const at = timestamp(input.at, "at");
  const end = timestamp(input.latestEffectiveEnd, "latestEffectiveEnd");
  const renewalCutoffMs = end + PERSONAL_PROVIDER_RETENTION_DAYS * SECONDS_PER_DAY * 1_000;
  const renewalCutoff = new Date(renewalCutoffMs).toISOString();
  if (input.retentionExpiredAt !== null || at >= renewalCutoffMs) return Object.freeze({ lifecycle: "retention_expired", renewalCutoff });
  if (at < end) return Object.freeze({ lifecycle: "active", renewalCutoff });
  return Object.freeze({ lifecycle: "expired_hot", renewalCutoff });
}

export function personalProviderRenewalWindow(input: {
  latestEffectiveEnd: string;
  fulfillmentSucceededAt: string;
  renewalAdmittedAt: string;
  durationDays: number;
}): Readonly<{ effectiveStart: string; effectiveEnd: string; durationDays: number }> {
  const latestEnd = timestamp(input.latestEffectiveEnd, "latestEffectiveEnd");
  const fulfillment = timestamp(input.fulfillmentSucceededAt, "fulfillmentSucceededAt");
  const admitted = timestamp(input.renewalAdmittedAt, "renewalAdmittedAt");
  const durationDays = positiveDurationDays(input.durationDays);
  const cutoff = latestEnd + PERSONAL_PROVIDER_RETENTION_DAYS * SECONDS_PER_DAY * 1_000;
  if (admitted >= cutoff) throw new RelayError("provider_slot_renewal_window_expired", "The Provider slot renewal window has expired", 409);
  const effectiveStartMs = Math.max(latestEnd, fulfillment);
  return Object.freeze({
    effectiveStart: new Date(effectiveStartMs).toISOString(),
    effectiveEnd: new Date(effectiveStartMs + durationDays * SECONDS_PER_DAY * 1_000).toISOString(),
    durationDays,
  });
}

export function positiveDurationDays(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_650) {
    throw new RelayError("authority_product_duration_days_invalid", "Personal Provider product duration must be a positive integer number of days", 400);
  }
  return value;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RelayError("provider_slot_time_invalid", `${field} must be an ISO timestamp`, 400);
  return parsed;
}
