import { parseJsonText, RelayError } from "@frely/core";
export { ACCESS_POINT_DESCRIPTION_MAX_LENGTH, normalizeAccessPointDescription } from "@frely/model-access/server";
import type {
  BillingEvent,
  BillingHistoryRef,
  CardActivationBatch,
  CardActivationBatchView,
  CardActivationCode,
  CardActivationCodeSafeView,
  CardActivationCodeView,
  OrderedPlanSource,
  TeamDeleteBlocker,
  TeamMembership,
  TeamMembershipRole,
} from "./application-operation-port.js";

export const DEFAULT_CPA_INSTANCE_ID = "cpa_default";
export const TEAM_DELETION_RETENTION_DAYS = 180;
export const CREDIT_UNITS_PER_USD = 1_000_000;
export const TEAM_DELETION_ARCHIVE_DOMAINS = [
  "team", "membership", "permission", "request", "capture", "usage", "billing", "audit",
] as const;

export function assertCpaInstanceId(value: string): void {
  if (!/^cpa_[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) {
    throw new RelayError("cpa_instance_id_invalid", "CPA Instance ID is invalid", 400);
  }
}

export function billingHistoryReference(event: BillingEvent): BillingHistoryRef {
  return {
    billingEventId: event.id,
    requestId: event.requestId,
    billingSubscriptionId: event.billingSubscriptionId,
    billingScopeRef: event.billingScopeRef,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
    billableAmount: event.billableAmount,
    providerCostAmount: event.providerCostAmount,
    grossMarginAmount: event.grossMarginAmount,
    providerModelCostId: event.providerModelCostId,
    usageSource: event.usageSource,
    occurredAt: event.createdAt,
    archiveMonth: null,
    objectSha256: null,
    rowKey: null,
    archivedAt: null,
  };
}

export function usdToCreditUnits(amount: number): number {
  if (!Number.isFinite(amount)) throw new RelayError("invalid_credit_amount", "Credit amount must be finite", 400);
  const units = Math.round(amount * CREDIT_UNITS_PER_USD);
  if (!Number.isSafeInteger(units)) throw new RelayError("invalid_credit_amount", "Credit amount is outside supported precision", 400);
  return units;
}

export function creditUnitsToUsd(units: number): number {
  if (!Number.isSafeInteger(units)) throw new RelayError("invalid_credit_units", "Credit units must be a safe integer", 400);
  return units / CREDIT_UNITS_PER_USD;
}

export function isPlanRuntimeEnabled(status: string): status is "enabled" | "closed" {
  return status === "enabled" || status === "closed";
}

export function assertOrderedPlanSourceConfiguration(source: OrderedPlanSource): void {
  if (source.configurationError === "overlapping_active_subscriptions") {
    throw new RelayError("plan_subscription_overlap", "Multiple active Subscriptions exist for an ordered Plan source", 500);
  }
  if (source.configurationError === "multiple_entry_access_points") {
    throw new RelayError("plan_model_access_point_not_unique", "An ordered Plan source has multiple enabled entry AccessPoints for this model", 500);
  }
  if (source.configurationError === "entry_access_point_missing") {
    throw new RelayError("plan_entry_access_point_missing", "An active ordered Plan source has no enabled entry AccessPoint for this model", 500);
  }
}

const teamMembershipRoleOrder: TeamMembershipRole[] = ["viewer", "billing", "manager"];

export function teamMembershipRoles(membership: Pick<TeamMembership, "rolesJson"> | null | undefined): TeamMembershipRole[] {
  return normalizeTeamMembershipRoles(parseJsonText<unknown>(membership?.rolesJson, ["viewer"]));
}

export function normalizeTeamMembershipRoles(value: unknown): TeamMembershipRole[] {
  const values = Array.isArray(value) ? value : ["viewer"];
  const roles = new Set<TeamMembershipRole>();
  for (const item of values) {
    if (item === "viewer" || item === "billing" || item === "manager") roles.add(item);
  }
  if (roles.size === 0) roles.add("viewer");
  return teamMembershipRoleOrder.filter((role) => roles.has(role));
}

export function teamNotEmptyError(blockers: TeamDeleteBlocker[]): RelayError {
  const summary = blockers.map((blocker) => `${blocker.code}: ${blocker.count}`).join(", ");
  return new RelayError(
    "team_not_empty",
    `Team cannot be deleted while it has related membership, usage, billing, history, or scoped configuration. Blocked by ${summary}.`,
    409,
    { blockers },
  );
}

export function cardActivationBatchView(batch: CardActivationBatch): CardActivationBatchView {
  const { exportSeedCiphertext: _seed, exportKeyVersion: _keyVersion, idempotencyKeyHash: _idempotency, requestHash: _requestHash, createdByUserId: _createdBy, ...safe } = batch;
  return safe;
}

export function cardActivationCodeSafeView(code: CardActivationCode | CardActivationCodeView): CardActivationCodeSafeView {
  if ("codeHash" in code) {
    const { codeHash: _codeHash, ...safe } = code;
    return safe;
  }
  return code;
}
