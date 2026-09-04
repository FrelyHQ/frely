import type { FrozenPriceUnits, InvocationUsageUnits } from "./invocation-domain.js";

export type BillableInvocationRef = string;
export type UsageReservationId = string;

export interface InvocationBillingAdmissionFundingInput {
  userId: string;
  usageChargeAccountId: string | null;
}

export interface InvocationBillingOccupationInput {
  billableInvocationRef: BillableInvocationRef;
  requestId: string;
  planId: string;
  planSubscriptionId: string;
  apiKeyId: string;
  userId: string;
  maximumTokens: bigint;
  maximumChargeUnits: bigint;
  usageChargeAccountId: string | null;
  inputTokens: bigint;
  maxOutputTokens: bigint;
  tokenizerId: string;
  tokenizerVersion: number;
  preparationEvidenceId: string;
  preparationEvidenceVersion: number;
  preparedPayloadId: string;
  serviceTier: string;
  billablePriceSource: string;
  billablePriceId: string;
  billablePriceTierKey: string;
  priceSnapshotJson: string;
  createdAt: string;
}

export interface InvocationBillingBudgetInput {
  planId: string;
  planSubscriptionId: string;
  apiKeyId: string;
  userId: string;
  subscriptionEffectiveStart: string;
  subscriptionEffectiveEnd: string | null;
  maximumTokens: bigint;
  maximumChargeUnits: bigint;
  occurredAt: string;
}

export interface InvocationBillingOccupationSnapshot {
  claim: null | {
    requestId: string;
    planId: string;
    planSubscriptionId: string;
    apiKeyId: string;
    userId: string;
    maximumTokens: bigint;
    maximumChargeUnits: bigint;
  };
  reservation: null | {
    id: UsageReservationId;
    creditAccountId: string;
    planSubscriptionId: string;
    userId: string;
    inputTokens: bigint;
    maxOutputTokens: bigint;
    tokenizerId: string;
    tokenizerVersion: number;
    preparationEvidenceId: string;
    preparationEvidenceVersion: number;
    preparedPayloadId: string;
    billablePriceSource: string;
    billablePriceId: string;
    reservationUnits: bigint;
  };
}

export interface InvocationBillingFinancialTermsInput {
  planId: string;
  providerId: string;
  providerModelName: string;
  providerModelCostId: string;
  billablePriceSource: "access_point" | "plan_access_point";
  billablePriceId: string;
  inputTokens: bigint;
  serviceTier: string;
  providerOwnerScopeRef: string;
  accessPointPriceContexts: Array<{
    accessPointId: string;
    targetAccessPointId: string | null;
    buyerScopeRef: string;
    sellerScopeRef: string;
    priceId: string;
  }>;
}

export interface FrozenAccessPointPriceEvidence {
  accessPointId: string;
  targetAccessPointId: string | null;
  buyerScopeRef: string;
  sellerScopeRef: string;
  priceId: string;
  tierKey: string;
  snapshotJson: string;
}

export interface InvocationBillingFinancialTerms {
  price: { units: FrozenPriceUnits; serviceTier: string; tierKey: string; snapshotJson: string };
  providerOwnerScopeRef: string;
  providerCost: { tierKey: string; snapshotJson: string };
  accessPointPrices: FrozenAccessPointPriceEvidence[];
}

export interface ClaimlessInvocationBillingFinancialTermsInput {
  planId: string;
  providerId: string;
  providerModelName: string;
  providerModelCostId: string;
  billablePriceSource: "access_point" | "plan_access_point";
  billablePriceId: string;
  providerOwnerScopeRef: string;
  accessPointPriceContexts: InvocationBillingFinancialTermsInput["accessPointPriceContexts"];
}

export interface FrozenAccessPointPriceProfile {
  accessPointId: string;
  targetAccessPointId: string | null;
  buyerScopeRef: string;
  sellerScopeRef: string;
  priceId: string;
  profileJson: string;
}

export interface ClaimlessInvocationBillingFinancialTerms {
  billablePriceProfileJson: string;
  providerCostProfileJson: string;
  accessPointPriceProfilesJson: string;
}

interface InvocationBillingAttemptBase {
  billableInvocationRef: BillableInvocationRef;
  requestId: string;
  startedAt: string;
  billingScopeRef: string;
  planSellerScopeRef: string;
  planBillingMode: string;
  subscriptionEffectiveStart: string;
  providerOwnerScopeRef: string;
  providerId: string;
  providerModelName: string;
  providerModelCostId: string;
  billablePriceId: string;
  billablePriceSource: string;
}

export interface ProtectedInvocationBillingAttemptSnapshot extends InvocationBillingAttemptBase {
  invocationContract: "protected@1";
  preparationEvidenceId: string | null;
  preparationEvidenceVersion: number | null;
  preparedPayloadId: string | null;
  providerCostTierKey: string;
  providerCostSnapshotJson: string;
  billablePriceTierKey: string;
  billablePriceSnapshotJson: string;
  accessPointPriceSnapshotsJson: string;
}

export interface ClaimlessInvocationBillingAttemptSnapshot extends InvocationBillingAttemptBase {
  invocationContract: "cpa-basic@1";
  planSubscriptionId: string;
  apiKeyId: string;
  userId: string;
  usageChargeAccountId: string | null;
  requestedServiceTier: string;
  requireServiceTier: boolean;
  billablePriceProfileJson: string;
  providerCostProfileJson: string;
  accessPointPriceProfilesJson: string;
}

export type InvocationBillingAttemptSnapshot =
  | ProtectedInvocationBillingAttemptSnapshot
  | ClaimlessInvocationBillingAttemptSnapshot;

export interface SettleInvocationBillingCommand {
  billableInvocationRef: BillableInvocationRef;
  usage: InvocationUsageUnits;
  zeroReservationOutcome?: "settled" | "released";
  attempt: InvocationBillingAttemptSnapshot;
  settledAt: string;
}

export interface InvocationBillingSettlementResult {
  actualChargeUnits: bigint;
  postingLedgerEventId: string | null;
  billingEventId: string;
  replayed: boolean;
}

export interface TransitionInvocationReconciliationInput {
  billableInvocationRef: BillableInvocationRef;
  costExposure: "accruing" | "stopped";
  transitionedAt: string;
}

export interface UsageReconciliationProjection {
  billableInvocationRef: BillableInvocationRef;
  usageReservationId: UsageReservationId | null;
  reservationStatus: "active" | "reconciling" | null;
  heldUnits: bigint | null;
  reservationUnits: bigint | null;
  maximumTokens: bigint;
  maximumChargeUnits: bigint;
  createdAt: string;
}
