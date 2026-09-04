import type { AuditActor } from "@frely/audit";
import type { InvocationUsageUnits } from "@frely/billing";
import type { ProviderCredentialFailureReason, ProviderFailureClass } from "@frely/core";
import type { RequestExecutionDetail, RoutingRevisionExpectation } from "@frely/request-execution";

export interface ProviderInvocationAdmissionIdentity {
  requestId: string;
  executionOwnerId: string;
  attemptIndex: number;
  selectorAccessPointId: string;
  selectorId: string;
  selectorBehaviorVersion: number;
  routingRevision: number;
  routingRevisions: RoutingRevisionExpectation[];
  candidateId: string;
  selectorTargetEdgeId: string;
  pathTargetEdgeIds: string[];
  accessPointChainIds: string[];
  providerModelId: string;
  providerId: string;
  providerModelName: string;
  planId: string;
  planSubscriptionId: string;
  apiKeyId: string;
  userId: string;
  billablePriceSource: "access_point" | "plan_access_point";
  billablePriceId: string;
  providerModelCostId: string;
  accessPointPriceIds: string[];
  usageChargeAccountId: string | null;
}

export interface AdmitProviderInvocationCommand extends ProviderInvocationAdmissionIdentity {
  inputTokens: bigint;
  maxOutputTokens: bigint;
  tokenizerId: string;
  tokenizerVersion: number;
  preparationEvidenceId: string;
  preparationEvidenceVersion: number;
  preparedPayloadId: string;
  serviceTier: string;
}

export interface ProviderInvocationAdmission {
  providerAttemptId: string;
  budgetClaimMaxTokens: bigint;
  budgetClaimMaxChargeUnits: bigint;
  usageReservationId: string | null;
  reservationUnits: bigint | null;
  startedAt: string;
}

export interface AdmitCpaBasicProviderInvocationCommand extends ProviderInvocationAdmissionIdentity {
  providerAttemptId?: string;
  requestedServiceTier: string;
  requireServiceTier: boolean;
}

export interface CpaBasicProviderInvocationAdmission {
  providerAttemptId: string;
  startedAt: string;
  replayed: boolean;
}

export interface SettleProviderInvocationCommand {
  providerAttemptId: string;
  outcome: "succeeded" | "failed" | "aborted";
  failureClass?: ProviderFailureClass | null;
  failureReason?: ProviderCredentialFailureReason | null;
  outputCommitted?: boolean;
  usage: InvocationUsageUnits;
  requestTerminalStatus?: "succeeded" | "failed" | "aborted";
  requestTerminalErrorCode?: string | null;
}

export interface ReconcileProviderInvocationCommand {
  providerAttemptId: string;
  outcome: "succeeded" | "failed" | "aborted";
  failureClass?: ProviderFailureClass | null;
  failureReason?: ProviderCredentialFailureReason | null;
  outputCommitted?: boolean;
  costExposure: "accruing" | "stopped";
  finalUsageEvidence: "pending";
  reason: string;
}

export interface ReconcileFinalProviderInvocationCommand extends SettleProviderInvocationCommand {
  evidenceKind: "provider_operation_query" | "provider_billing_record" | "provider_response";
  evidenceRef: string;
  audit: {
    actor: AuditActor;
    requestId: string;
  };
}

export interface UnresolvedProviderInvocation {
  providerAttemptId: string;
  requestId: string;
  invocationContract: "protected@1" | "cpa-basic@1";
  providerId: string;
  providerModelName: string;
  startedAt: string;
  outcome: string;
  failureClass: string | null;
  failureReason: string | null;
  costExposure: string;
  reconciliationReason: string | null;
  maxTotalTokens: bigint | null;
  maxChargeUnits: bigint | null;
  reservationStatus: string | null;
  heldUnits: bigint | null;
}

export interface RequestExecutionQueries {
  getRequestExecutionDetail(requestId: string, attemptLimit?: number): Promise<RequestExecutionDetail | null>;
  listUnresolved(limit?: number): Promise<UnresolvedProviderInvocation[]>;
}

export interface RequestExecutionReconciliationReadWorkflow {
  execute(input: {
    actor: AuditActor;
    requestId: string;
    limit: number;
  }): Promise<UnresolvedProviderInvocation[]>;
}

export interface RequestExecutionCommands {
  admit(command: AdmitProviderInvocationCommand): Promise<ProviderInvocationAdmission>;
  admitCpaBasic(command: AdmitCpaBasicProviderInvocationCommand): Promise<CpaBasicProviderInvocationAdmission>;
  assertDispatchOwnership(providerAttemptId: string, requestId: string, executionOwnerId: string): Promise<void>;
  settleFinalUsage(command: SettleProviderInvocationCommand): Promise<{ actualChargeUnits: bigint; postingLedgerEventId: string | null; billingEventId: string }>;
  settleCpaBasicLive(command: SettleProviderInvocationCommand): Promise<{ actualChargeUnits: bigint; postingLedgerEventId: string | null; billingEventId: string }>;
  reconcileFinalUsage(command: ReconcileFinalProviderInvocationCommand): Promise<{ actualChargeUnits: bigint; postingLedgerEventId: string | null; billingEventId: string }>;
  releaseNotStarted(command: Omit<SettleProviderInvocationCommand, "usage">): Promise<{ actualChargeUnits: 0n; postingLedgerEventId: null; billingEventId: string }>;
  enterReconciliation(command: ReconcileProviderInvocationCommand): Promise<void>;
  failRequestExecution(requestId: string, executionOwnerId: string, errorCode: string): Promise<void>;
}

type AssertRequestExecutionCapabilitiesDisjoint<Value extends never> = Value;
type _RequestExecutionCapabilitiesDisjoint = AssertRequestExecutionCapabilitiesDisjoint<Extract<keyof RequestExecutionQueries, keyof RequestExecutionCommands>>;
