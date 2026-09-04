import { RelayError, type ProviderFailureClass } from "@frely/core";
import type {
  ProviderAttemptAdmissionIdentity,
  ProviderAttemptFailureArbitration,
  ProviderAttemptFailureArbitrationInput,
  ProviderAttemptOutcome,
} from "./contracts.js";

export function arbitrateProviderAttemptFailure(
  input: ProviderAttemptFailureArbitrationInput,
): ProviderAttemptFailureArbitration {
  const releaseNotStarted = input.costExposure === "not_started"
    && input.finalUsageEvidence === "absent"
    && !input.hasTrustedFinalUsage;
  const settleFinalUsage = input.costExposure === "stopped"
    && input.finalUsageEvidence === "final"
    && input.hasTrustedFinalUsage;
  const settlement = releaseNotStarted
    ? "release_not_started" as const
    : settleFinalUsage
      ? "settle_final_usage" as const
      : "reconcile" as const;
  const stopReason = input.requestCancelled
    ? "request_cancelled" as const
    : input.outputCommitted
      ? "output_committed" as const
      : settlement === "reconcile"
        ? "evidence_pending" as const
        : null;
  return Object.freeze({ settlement, fallbackPermitted: stopReason === null, stopReason });
}

export function assertRequestExecutionLeaseFreshForDispatch(leaseUntil: string, checkedAtMillis = Date.now()): void {
  const leaseUntilMillis = Date.parse(leaseUntil);
  if (!Number.isFinite(leaseUntilMillis) || !Number.isFinite(checkedAtMillis) || leaseUntilMillis <= checkedAtMillis) {
    throw new RelayError("request_execution_lease_lost", "Request execution lease expired before Provider dispatch", 409);
  }
}

export function assertProviderAttemptAdmissionIdentity(input: ProviderAttemptAdmissionIdentity): void {
  if (!Number.isSafeInteger(input.attemptIndex) || input.attemptIndex < 0) throw new RelayError("invalid_provider_attempt", "ProviderAttempt index is invalid", 400);
  if (!Number.isSafeInteger(input.routing.selectorBehaviorVersion) || !Number.isSafeInteger(input.routing.routingRevision)) {
    throw new RelayError("invalid_provider_attempt", "ProviderAttempt revisions are invalid", 400);
  }
}

export function providerAttemptFailureClass(
  outcome: ProviderAttemptOutcome,
  failureClass: ProviderFailureClass | null | undefined,
): ProviderFailureClass | null {
  return outcome === "failed" ? failureClass ?? "non_retryable" : null;
}

export function assertReconciliationReason(reason: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/u.test(reason)) {
    throw new RelayError("invalid_provider_reconciliation_reason", "Reconciliation reason must be a bounded non-secret code", 400);
  }
}
