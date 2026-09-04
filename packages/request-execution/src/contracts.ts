import type { ProviderCredentialFailureReason, ProviderFailureClass } from "@frely/core";

export type RequestId = string;
export type ProviderAttemptRef = string;
export type AdmissionSourceRef = string;
export type RequestExecutionStatus = "running" | "succeeded" | "failed" | "aborted";
export type ProviderAttemptOutcome = "succeeded" | "failed" | "aborted";
export type ProviderCostExposure = "not_started" | "accruing" | "stopped";
export type ProviderFinalUsageEvidence = "absent" | "pending" | "final";

export interface ProviderAttemptFailureArbitrationInput {
  readonly costExposure: ProviderCostExposure;
  readonly finalUsageEvidence: ProviderFinalUsageEvidence;
  readonly hasTrustedFinalUsage: boolean;
  readonly outputCommitted: boolean;
  readonly requestCancelled: boolean;
}

export interface ProviderAttemptFailureArbitration {
  readonly settlement: "release_not_started" | "settle_final_usage" | "reconcile";
  readonly fallbackPermitted: boolean;
  readonly stopReason: "request_cancelled" | "output_committed" | "evidence_pending" | null;
}

export interface RequestExecutionLeaseSnapshot {
  requestId: RequestId;
  ownerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  leaseUntil: string;
}

export interface AcquireRequestExecutionLeaseCommand {
  requestId: RequestId;
  ownerId: string;
  leaseTtlSeconds: number;
}

export interface RenewRequestExecutionLeaseCommand extends AcquireRequestExecutionLeaseCommand {}

export interface ReleaseRequestExecutionLeaseCommand {
  requestId: RequestId;
  ownerId: string;
}

export interface RequestExecutionLeasePort {
  acquire(command: AcquireRequestExecutionLeaseCommand): Promise<RequestExecutionLeaseSnapshot>;
  renew(command: RenewRequestExecutionLeaseCommand): Promise<RequestExecutionLeaseSnapshot>;
  release(command: ReleaseRequestExecutionLeaseCommand): Promise<boolean>;
}

export interface RoutingRevisionExpectation {
  accessPointId: string;
  routingRevision: number;
}

export interface FrozenProviderCandidate {
  candidateId: string;
  providerModelId: string;
  providerId: string;
  providerModelName: string;
}

export interface FrozenProviderRouting {
  selectorAccessPointId: string;
  selectorId: string;
  selectorBehaviorVersion: number;
  routingRevision: number;
  routingRevisions: RoutingRevisionExpectation[];
  selectorTargetEdgeId: string;
  pathTargetEdgeIds: string[];
  accessPointChainIds: string[];
}

export interface ProviderAttemptAdmissionIdentity {
  requestId: RequestId;
  executionOwnerId: string;
  attemptIndex: number;
  candidate: FrozenProviderCandidate;
  routing: FrozenProviderRouting;
}

export interface AdmitFirstProviderInvocationCommand extends ProviderAttemptAdmissionIdentity {
  attemptIndex: 0;
  selectedSourceRef: AdmissionSourceRef;
}

export interface AdmitFallbackProviderInvocationCommand extends ProviderAttemptAdmissionIdentity {
  attemptIndex: number;
}

export interface ProviderAttemptIdentitySnapshot extends ProviderAttemptAdmissionIdentity {
  providerAttemptRef: ProviderAttemptRef;
  startedAt: string;
}

export type ProviderInvocationAdmissionDecision =
  | { kind: "replay"; attempt: ProviderAttemptIdentitySnapshot; selectedSourceRef: AdmissionSourceRef }
  | { kind: "first"; leaseUntil: string; selectedSourceRef: AdmissionSourceRef }
  | { kind: "fallback"; leaseUntil: string; selectedSourceRef: AdmissionSourceRef };

export interface FinalizeProviderInvocationCommand {
  providerAttemptRef: ProviderAttemptRef;
  outcome: ProviderAttemptOutcome;
  failureClass?: ProviderFailureClass | null;
  failureReason?: ProviderCredentialFailureReason | null;
  outputCommitted?: boolean;
  trustedUsageSource: "provider" | "response";
  requestTerminalStatus?: Exclude<RequestExecutionStatus, "running">;
  requestTerminalErrorCode?: string | null;
}

export interface CompleteRequestExecutionCommand {
  requestId: RequestId;
  executionOwnerId: string;
  status: Exclude<RequestExecutionStatus, "running">;
  terminalErrorCode: string | null;
  outputCommitted: boolean;
  completedAt: string;
}

export interface ProviderInvocationFinalizationDecision {
  providerAttemptRef: ProviderAttemptRef;
  requestId: RequestId;
  invocationContract: "protected@1" | "cpa-basic@1";
  startedAt: string;
  expectedFailureClass: ProviderFailureClass | null;
  expectedFailureReason: ProviderCredentialFailureReason | null;
  expectedOutputCommitted: boolean;
  alreadyFinalized: boolean;
}

export interface ReconcileProviderInvocationCommand {
  providerAttemptRef: ProviderAttemptRef;
  outcome: ProviderAttemptOutcome;
  failureClass?: ProviderFailureClass | null;
  failureReason?: ProviderCredentialFailureReason | null;
  outputCommitted?: boolean;
  costExposure: Exclude<ProviderCostExposure, "not_started">;
  reason: string;
}

export interface ProviderInvocationDispatchDecision {
  owned: boolean;
  transitionToReconciliation: boolean;
  transitionedAt: string;
}

export interface ProviderInvocationReconciliationDecision {
  transitionToReconciliation: boolean;
  transitionedAt: string;
}

export interface RequestExecutionAttemptDetail {
  providerAttemptRef: ProviderAttemptRef;
  attemptIndex: number;
  invocationContract: "protected@1" | "cpa-basic@1";
  providerModelId: string;
  providerId: string;
  providerModelName: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string;
  failureClass: string | null;
  failureReason: string | null;
  outputCommitted: boolean;
  costExposure: string;
  finalUsageEvidence: string;
  usageSettled: boolean;
  reconciliationReason: string | null;
}

export interface RequestExecutionDetail {
  requestId: RequestId;
  status: RequestExecutionStatus;
  ownerId: string;
  selectedSourceRef: AdmissionSourceRef;
  attemptCount: number;
  outputCommitted: boolean;
  terminalErrorCode: string | null;
  startedAt: string;
  endedAt: string | null;
  attempts: RequestExecutionAttemptDetail[];
}

export interface UnresolvedProviderAttempt {
  providerAttemptRef: ProviderAttemptRef;
  requestId: RequestId;
  invocationContract: "protected@1" | "cpa-basic@1";
  providerModelId: string;
  providerId: string;
  providerModelName: string;
  startedAt: string;
  outcome: string;
  failureClass: string | null;
  failureReason: string | null;
  costExposure: string;
  reconciliationReason: string;
}
