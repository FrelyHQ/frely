import { createId, isProviderCredentialFailureReason, nowIso, RelayError, type ProviderCredentialFailureReason } from "@frely/core";
import { Prisma, type PrismaTransactionOwner } from "@frely/postgres/server";
import {
  assertProviderAttemptAdmissionIdentity,
  assertReconciliationReason,
  providerAttemptFailureClass,
} from "./domain.js";
import type {
  AdmitFallbackProviderInvocationCommand,
  AdmitFirstProviderInvocationCommand,
  AcquireRequestExecutionLeaseCommand,
  CompleteRequestExecutionCommand,
  FinalizeProviderInvocationCommand,
  ProviderAttemptAdmissionIdentity,
  ProviderAttemptIdentitySnapshot,
  ProviderInvocationAdmissionDecision,
  ProviderInvocationDispatchDecision,
  ProviderInvocationFinalizationDecision,
  ProviderInvocationReconciliationDecision,
  ReconcileProviderInvocationCommand,
  ReleaseRequestExecutionLeaseCommand,
  RenewRequestExecutionLeaseCommand,
  RequestExecutionLeasePort,
  RequestExecutionDetail,
  RequestExecutionLeaseSnapshot,
  RequestExecutionStatus,
  UnresolvedProviderAttempt,
} from "./contracts.js";

export type * from "./contracts.js";

export interface ProviderAttemptPersistenceMaterial {
  readonly providerAttemptRef?: string;
  readonly invocationContract: "protected@1" | "cpa-basic@1";
  readonly planSubscriptionId: string | null;
  readonly apiKeyId: string | null;
  readonly userId: string | null;
  readonly usageChargeAccountId: string | null;
  readonly requireServiceTier: boolean;
  readonly billablePriceProfileJson: string | null;
  readonly providerCostProfileJson: string | null;
  readonly accessPointPriceProfilesJson: string | null;
  readonly billablePriceSource: "access_point" | "plan_access_point";
  readonly billablePriceId: string;
  readonly billablePriceTierKey: string | null;
  readonly billablePriceSnapshotJson: string | null;
  readonly inputTokens: bigint | null;
  readonly maxOutputTokens: bigint | null;
  readonly tokenizerId: string | null;
  readonly tokenizerVersion: number | null;
  readonly preparationEvidenceId: string | null;
  readonly preparationEvidenceVersion: number | null;
  readonly preparedPayloadId: string | null;
  readonly requestedServiceTier: string;
  readonly billingScopeRef: string;
  readonly planSellerScopeRef: string;
  readonly planBillingMode: string;
  readonly subscriptionEffectiveStart: string;
  readonly providerOwnerScopeRef: string;
  readonly providerModelCostId: string;
  readonly providerCostTierKey: string | null;
  readonly providerCostSnapshotJson: string | null;
  readonly accessPointPriceSnapshotsJson: string | null;
}

export type RequestExecutionClock = () => string;

export class AcquireRequestExecutionLease {
  constructor(private readonly clock: RequestExecutionClock = nowIso) {}

  async execute(
    transaction: Prisma.TransactionClient,
    command: AcquireRequestExecutionLeaseCommand,
  ): Promise<RequestExecutionLeaseSnapshot> {
    const now = this.clock();
    const leaseUntil = requestExecutionLeaseUntil(now, command.leaseTtlSeconds);
    const rows = await transaction.$queryRaw<RequestExecutionLeaseSnapshot[]>(Prisma.sql`
      INSERT INTO "request_execution_leases" ("request_id", "owner_id", "acquired_at", "heartbeat_at", "lease_until")
      VALUES (${command.requestId}, ${command.ownerId}, ${now}, ${now}, ${leaseUntil})
      ON CONFLICT ("request_id") DO UPDATE SET
        "owner_id" = EXCLUDED."owner_id",
        "acquired_at" = EXCLUDED."acquired_at",
        "heartbeat_at" = EXCLUDED."heartbeat_at",
        "lease_until" = EXCLUDED."lease_until"
      WHERE "request_execution_leases"."owner_id" = EXCLUDED."owner_id"
         OR "request_execution_leases"."lease_until" <= ${now}
      RETURNING "request_id" AS "requestId", "owner_id" AS "ownerId",
                "acquired_at" AS "acquiredAt", "heartbeat_at" AS "heartbeatAt",
                "lease_until" AS "leaseUntil"
    `);
    const lease = rows[0];
    if (!lease) throw new RelayError("request_execution_lease_conflict", "Request execution is already owned", 409);
    return lease;
  }
}

export class RenewRequestExecutionLease {
  constructor(private readonly clock: RequestExecutionClock = nowIso) {}

  async execute(
    transaction: Prisma.TransactionClient,
    command: RenewRequestExecutionLeaseCommand,
  ): Promise<RequestExecutionLeaseSnapshot> {
    const now = this.clock();
    const leaseUntil = requestExecutionLeaseUntil(now, command.leaseTtlSeconds);
    const rows = await transaction.$queryRaw<RequestExecutionLeaseSnapshot[]>(Prisma.sql`
      UPDATE "request_execution_leases"
      SET "heartbeat_at" = ${now}, "lease_until" = ${leaseUntil}
      WHERE "request_id" = ${command.requestId}
        AND "owner_id" = ${command.ownerId}
        AND "lease_until" > ${now}
      RETURNING "request_id" AS "requestId", "owner_id" AS "ownerId",
                "acquired_at" AS "acquiredAt", "heartbeat_at" AS "heartbeatAt",
                "lease_until" AS "leaseUntil"
    `);
    const lease = rows[0];
    if (!lease) throw new RelayError("request_execution_lease_lost", "Request execution lease is no longer held", 409);
    return lease;
  }
}

export class ReleaseRequestExecutionLease {
  async execute(
    transaction: Prisma.TransactionClient,
    command: ReleaseRequestExecutionLeaseCommand,
  ): Promise<boolean> {
    const deleted = await transaction.$executeRaw(Prisma.sql`
      DELETE FROM "request_execution_leases"
      WHERE "request_id" = ${command.requestId} AND "owner_id" = ${command.ownerId}
    `);
    return deleted === 1;
  }
}

export class RequestExecutionLeaseService implements RequestExecutionLeasePort {
  private readonly acquireCommand: AcquireRequestExecutionLease;
  private readonly renewCommand: RenewRequestExecutionLease;
  private readonly releaseCommand = new ReleaseRequestExecutionLease();

  constructor(
    private readonly transactions: PrismaTransactionOwner,
    clock: RequestExecutionClock = nowIso,
  ) {
    this.acquireCommand = new AcquireRequestExecutionLease(clock);
    this.renewCommand = new RenewRequestExecutionLease(clock);
  }

  acquire(command: AcquireRequestExecutionLeaseCommand): Promise<RequestExecutionLeaseSnapshot> {
    return this.transactions.withPrismaTransaction(
      (transaction) => this.acquireCommand.execute(transaction, command),
      1,
      { isolationLevel: "ReadCommitted", statementTimeoutMillis: 5_000 },
    );
  }

  renew(command: RenewRequestExecutionLeaseCommand): Promise<RequestExecutionLeaseSnapshot> {
    return this.transactions.withPrismaTransaction(
      (transaction) => this.renewCommand.execute(transaction, command),
      1,
      { isolationLevel: "ReadCommitted", statementTimeoutMillis: 5_000 },
    );
  }

  release(command: ReleaseRequestExecutionLeaseCommand): Promise<boolean> {
    return this.transactions.withPrismaTransaction(
      (transaction) => this.releaseCommand.execute(transaction, command),
      1,
      { isolationLevel: "ReadCommitted", statementTimeoutMillis: 5_000 },
    );
  }
}

export class RequestExecutionTerminalArbiter {
  async execute(transaction: Prisma.TransactionClient, command: CompleteRequestExecutionCommand, allowMissing = false): Promise<void> {
    const rows = await transaction.$queryRaw<Array<{
      status: string;
      ownerId: string;
      terminalErrorCode: string | null;
      outputCommitted: number;
    }>>`
      SELECT "status", "owner_id" AS "ownerId", "terminal_error_code" AS "terminalErrorCode",
             "output_committed" AS "outputCommitted"
      FROM "request_executions" WHERE "request_id" = ${command.requestId} FOR UPDATE
    `;
    const execution = rows[0];
    if (!execution) {
      if (allowMissing) return;
      throw new RelayError("request_execution_not_found", "RequestExecution not found", 404);
    }
    if (execution.status === "running" || execution.status === "pending") {
      if (execution.ownerId !== command.executionOwnerId) {
        throw new RelayError("request_execution_owner_conflict", "RequestExecution is owned by another executor", 409);
      }
      await transaction.request_executions.update({ where: { request_id: command.requestId }, data: {
        status: command.status,
        terminal_error_code: command.terminalErrorCode,
        output_committed: command.outputCommitted || execution.outputCommitted === 1 ? 1 : 0,
        ended_at: command.completedAt,
      } });
      return;
    }
    const equivalent = execution.status === command.status
      && execution.terminalErrorCode === command.terminalErrorCode
      && Boolean(execution.outputCommitted) === command.outputCommitted;
    if (!equivalent) {
      throw new RelayError("request_execution_terminal_conflict", "RequestExecution terminal state cannot be rewritten", 409);
    }
  }
}

export class AdmitFirstProviderInvocation {
  findReplay(transaction: Prisma.TransactionClient, command: AdmitFirstProviderInvocationCommand): Promise<ReplayAdmissionDecision | null> {
    return findReplay(transaction, command);
  }

  inspectNew(transaction: Prisma.TransactionClient, command: AdmitFirstProviderInvocationCommand, inspectedAt: string, preflightReplay?: ReplayAdmissionDecision | null): Promise<ProviderInvocationAdmissionDecision> {
    return inspectNewAdmission(transaction, command, inspectedAt, "first", preflightReplay);
  }

  execute(
    transaction: Prisma.TransactionClient,
    command: AdmitFirstProviderInvocationCommand,
    decision: Extract<ProviderInvocationAdmissionDecision, { kind: "first" }>,
    startedAt: string,
    material: ProviderAttemptPersistenceMaterial,
  ): Promise<ProviderAttemptIdentitySnapshot> {
    return persistProviderAttempt(transaction, command, decision, startedAt, material);
  }
}

export class AdmitFallbackProviderInvocation {
  findReplay(transaction: Prisma.TransactionClient, command: AdmitFallbackProviderInvocationCommand): Promise<ReplayAdmissionDecision | null> {
    return findReplay(transaction, command);
  }

  inspectNew(transaction: Prisma.TransactionClient, command: AdmitFallbackProviderInvocationCommand, inspectedAt: string, preflightReplay?: ReplayAdmissionDecision | null): Promise<ProviderInvocationAdmissionDecision> {
    return inspectNewAdmission(transaction, command, inspectedAt, "fallback", preflightReplay);
  }

  execute(
    transaction: Prisma.TransactionClient,
    command: AdmitFallbackProviderInvocationCommand,
    decision: Extract<ProviderInvocationAdmissionDecision, { kind: "fallback" }>,
    startedAt: string,
    material: ProviderAttemptPersistenceMaterial,
  ): Promise<ProviderAttemptIdentitySnapshot> {
    return persistProviderAttempt(transaction, command, decision, startedAt, material);
  }
}

export class AssertProviderInvocationDispatch {
  async execute(
    transaction: Prisma.TransactionClient,
    providerAttemptRef: string,
    requestId: string,
    executionOwnerId: string,
    checkedAt: string,
  ): Promise<ProviderInvocationDispatchDecision> {
    const rows = await transaction.$queryRaw<Array<{
      attemptOwnerId: string;
      outcome: string;
      costExposure: string;
      outputCommitted: number;
      executionOwnerId: string | null;
      executionStatus: string | null;
      leaseOwnerId: string | null;
      leaseUntil: string | null;
    }>>`
      SELECT attempt."execution_owner_id" AS "attemptOwnerId", attempt."outcome",
             attempt."cost_exposure" AS "costExposure", attempt."output_committed" AS "outputCommitted",
             execution."owner_id" AS "executionOwnerId", execution."status" AS "executionStatus",
             lease."owner_id" AS "leaseOwnerId", lease."lease_until" AS "leaseUntil"
      FROM "request_provider_attempts" attempt
      INNER JOIN "request_executions" execution ON execution."request_id" = attempt."request_id"
      INNER JOIN "request_execution_leases" lease ON lease."request_id" = attempt."request_id"
      WHERE attempt."id" = ${providerAttemptRef} AND attempt."request_id" = ${requestId}
      FOR UPDATE OF attempt, execution, lease
    `;
    const state = rows[0];
    if (state && state.attemptOwnerId === executionOwnerId && state.outcome === "pending"
      && state.executionOwnerId === executionOwnerId && state.executionStatus === "running"
      && state.leaseOwnerId === executionOwnerId && state.leaseUntil !== null && state.leaseUntil > checkedAt
      && state.costExposure === "not_started") {
      await transaction.request_provider_attempts.update({ where: { id: providerAttemptRef }, data: { cost_exposure: "accruing" } });
      return { owned: true, transitionToReconciliation: false, transitionedAt: checkedAt };
    }
    if (state?.outcome === "pending") {
      await transaction.request_provider_attempts.update({ where: { id: providerAttemptRef }, data: {
        outcome: "failed", failure_class: "non_retryable", ended_at: checkedAt,
        cost_exposure: "accruing", final_usage_evidence: "pending", reconciliation_reason: "execution_ownership_lost",
      } });
      await new RequestExecutionTerminalArbiter().execute(transaction, {
        requestId,
        executionOwnerId: state.executionOwnerId ?? executionOwnerId,
        status: "failed",
        terminalErrorCode: "execution_ownership_lost",
        outputCommitted: state.outputCommitted === 1,
        completedAt: checkedAt,
      });
      return { owned: false, transitionToReconciliation: true, transitionedAt: checkedAt };
    }
    return { owned: false, transitionToReconciliation: false, transitionedAt: checkedAt };
  }
}

export class FinalizeProviderInvocation {
  async lock(
    transaction: Prisma.TransactionClient,
    command: FinalizeProviderInvocationCommand,
    requireReconciliation: boolean,
  ): Promise<ProviderInvocationFinalizationDecision> {
    const rows = await transaction.$queryRaw<Array<{
      providerAttemptRef: string;
      requestId: string;
      invocationContract: string;
      startedAt: string;
      outcome: string;
      failureClass: string | null;
      failureReason: string | null;
      outputCommitted: number;
      usageSettled: number;
      reconciliationReason: string | null;
      requestEndedAt: string | null;
    }>>`
      SELECT attempt."id" AS "providerAttemptRef", attempt."request_id" AS "requestId",
             attempt."invocation_contract" AS "invocationContract", attempt."started_at" AS "startedAt",
             attempt."outcome", attempt."failure_class" AS "failureClass", attempt."failure_reason" AS "failureReason",
             attempt."output_committed" AS "outputCommitted", attempt."usage_settled" AS "usageSettled",
             attempt."reconciliation_reason" AS "reconciliationReason", request."ended_at" AS "requestEndedAt"
      FROM "request_provider_attempts" attempt
      INNER JOIN "request_logs" request ON request."id" = attempt."request_id"
      WHERE attempt."id" = ${command.providerAttemptRef}
      FOR UPDATE OF attempt
    `;
    const attempt = rows[0];
    if (!attempt) throw new RelayError("provider_attempt_not_found", "ProviderAttempt not found", 404);
    if (attempt.invocationContract !== "protected@1" && attempt.invocationContract !== "cpa-basic@1") {
      throw new RelayError("provider_attempt_contract_mismatch", "ProviderAttempt invocation contract is unsupported", 409);
    }
    let executionStatus: string | null = null;
    if (attempt.invocationContract === "protected@1") {
      const executions = await transaction.$queryRaw<Array<{ status: string }>>`
        SELECT "status" FROM "request_executions" WHERE "request_id" = ${attempt.requestId} FOR UPDATE
      `;
      executionStatus = executions[0]?.status ?? null;
    }
    const reconciliationReady = attempt.invocationContract === "protected@1"
      ? isTerminalExecutionStatus(executionStatus)
      : attempt.requestEndedAt !== null;
    if (requireReconciliation && attempt.usageSettled !== 1
      && (!attempt.reconciliationReason || !reconciliationReady)) {
      throw new RelayError("provider_attempt_not_reconcilable", "ProviderAttempt has not entered the explicit reconciliation flow", 409);
    }
    const expectedFailureClass = providerAttemptFailureClass(command.outcome, command.failureClass);
    const expectedFailureReason = providerAttemptFailureReason(command.outcome, command.failureReason ?? attempt.failureReason);
    const expectedOutputCommitted = Boolean(command.outputCommitted);
    if (attempt.outcome !== "pending" && (attempt.outcome !== command.outcome
      || attempt.failureClass !== expectedFailureClass
      || attempt.failureReason !== expectedFailureReason
      || Boolean(attempt.outputCommitted) !== expectedOutputCommitted)) {
      throw new RelayError("provider_attempt_settlement_conflict", "ProviderAttempt terminal evidence does not match the finalization command", 409);
    }
    return {
      providerAttemptRef: attempt.providerAttemptRef,
      requestId: attempt.requestId,
      invocationContract: attempt.invocationContract,
      startedAt: attempt.startedAt,
      expectedFailureClass,
      expectedFailureReason,
      expectedOutputCommitted,
      alreadyFinalized: attempt.usageSettled === 1,
    };
  }

  async complete(
    transaction: Prisma.TransactionClient,
    decision: ProviderInvocationFinalizationDecision,
    command: FinalizeProviderInvocationCommand,
    completedAt: string,
  ): Promise<void> {
    if (decision.alreadyFinalized) return;
    await transaction.request_provider_attempts.update({ where: { id: decision.providerAttemptRef }, data: {
      outcome: command.outcome,
      failure_class: decision.expectedFailureClass,
      failure_reason: decision.expectedFailureReason,
      output_committed: decision.expectedOutputCommitted ? 1 : 0,
      trusted_usage_source: command.trustedUsageSource,
      ended_at: completedAt,
      cost_exposure: "stopped",
      final_usage_evidence: "final",
      usage_settled: 1,
      reconciliation_reason: null,
    } });
    if (command.requestTerminalStatus) {
      const attempt = await transaction.request_provider_attempts.findUniqueOrThrow({
        where: { id: decision.providerAttemptRef },
        select: { execution_owner_id: true },
      });
      await new RequestExecutionTerminalArbiter().execute(transaction, {
        requestId: decision.requestId,
        executionOwnerId: attempt.execution_owner_id,
        status: command.requestTerminalStatus,
        terminalErrorCode: command.requestTerminalErrorCode ?? null,
        outputCommitted: Boolean(command.outputCommitted),
        completedAt,
      });
    }
  }
}

export class ReconcileProviderInvocation {
  async execute(
    transaction: Prisma.TransactionClient,
    command: ReconcileProviderInvocationCommand,
    transitionedAt: string,
  ): Promise<ProviderInvocationReconciliationDecision> {
    assertReconciliationReason(command.reason);
    const rows = await transaction.$queryRaw<Array<{
      requestId: string;
      outcome: string;
      failureClass: string | null;
      failureReason: string | null;
      outputCommitted: number;
      endedAt: string | null;
      costExposure: string;
      usageSettled: number;
      reconciliationReason: string | null;
      executionStatus: string;
    }>>`
      SELECT attempt."request_id" AS "requestId", attempt."outcome", attempt."failure_class" AS "failureClass",
             attempt."failure_reason" AS "failureReason", attempt."output_committed" AS "outputCommitted", attempt."ended_at" AS "endedAt",
             attempt."cost_exposure" AS "costExposure", attempt."usage_settled" AS "usageSettled",
             attempt."reconciliation_reason" AS "reconciliationReason", execution."status" AS "executionStatus"
      FROM "request_provider_attempts" attempt
      INNER JOIN "request_executions" execution ON execution."request_id" = attempt."request_id"
      WHERE attempt."id" = ${command.providerAttemptRef}
      FOR UPDATE OF attempt, execution
    `;
    const attempt = rows[0];
    if (!attempt) throw new RelayError("provider_attempt_not_found", "ProviderAttempt not found", 404);
    const expectedFailureClass = providerAttemptFailureClass(command.outcome, command.failureClass);
    const expectedFailureReason = providerAttemptFailureReason(command.outcome, command.failureReason ?? attempt.failureReason);
    const expectedOutputCommitted = Boolean(command.outputCommitted);
    if (attempt.outcome !== "pending" && (attempt.outcome !== command.outcome
      || attempt.failureClass !== expectedFailureClass
      || attempt.failureReason !== expectedFailureReason
      || Boolean(attempt.outputCommitted) !== expectedOutputCommitted)) {
      throw new RelayError("provider_attempt_reconciliation_conflict", "ProviderAttempt terminal evidence cannot be rewritten while usage is pending", 409);
    }
    if (attempt.usageSettled === 1) return { transitionToReconciliation: false, transitionedAt };
    if (attempt.outcome !== "pending" && attempt.reconciliationReason && attempt.costExposure === command.costExposure) {
      return { transitionToReconciliation: false, transitionedAt };
    }
    if (attempt.costExposure === "stopped" && command.costExposure === "accruing") {
      throw new RelayError("provider_attempt_cost_exposure_conflict", "Stopped Provider cost exposure cannot return to accruing", 409);
    }
    await transaction.request_provider_attempts.update({ where: { id: command.providerAttemptRef }, data: {
      outcome: command.outcome,
      failure_class: expectedFailureClass,
      failure_reason: expectedFailureReason,
      output_committed: expectedOutputCommitted ? 1 : 0,
      ended_at: attempt.endedAt ?? transitionedAt,
      cost_exposure: command.costExposure,
      final_usage_evidence: "pending",
      reconciliation_reason: command.reason,
    } });
    if (attempt.executionStatus === "running" || attempt.executionStatus === "pending") {
      const owner = await transaction.request_provider_attempts.findUniqueOrThrow({
        where: { id: command.providerAttemptRef },
        select: { execution_owner_id: true },
      });
      await new RequestExecutionTerminalArbiter().execute(transaction, {
        requestId: attempt.requestId,
        executionOwnerId: owner.execution_owner_id,
        status: command.outcome === "aborted" ? "aborted" : command.outcome === "succeeded" ? "succeeded" : "failed",
        terminalErrorCode: command.outcome === "succeeded" ? null : command.reason,
        outputCommitted: expectedOutputCommitted,
        completedAt: transitionedAt,
      });
    }
    return { transitionToReconciliation: true, transitionedAt };
  }
}

export class FailRequestExecution {
  async execute(
    transaction: Prisma.TransactionClient,
    requestId: string,
    executionOwnerId: string,
    errorCode: string,
    failedAt: string,
  ): Promise<void> {
    const rows = await transaction.$queryRaw<Array<{
      ownerId: string;
      status: string;
      terminalErrorCode: string | null;
      outputCommitted: number;
    }>>`
      SELECT "owner_id" AS "ownerId", "status", "terminal_error_code" AS "terminalErrorCode",
             "output_committed" AS "outputCommitted"
      FROM "request_executions"
      WHERE "request_id" = ${requestId} FOR UPDATE
    `;
    const execution = rows[0];
    if (!execution) return;
    if (!["pending", "running"].includes(execution.status)) {
      if (execution.status === "failed"
        && execution.terminalErrorCode === errorCode
        && execution.outputCommitted === 0) return;
      throw new RelayError("request_execution_terminal_conflict", "RequestExecution terminal state cannot be rewritten", 409);
    }
    await new RequestExecutionTerminalArbiter().execute(transaction, {
      requestId,
      executionOwnerId,
      status: "failed",
      terminalErrorCode: errorCode,
      outputCommitted: false,
      completedAt: failedAt,
    }, true);
  }
}

export class CompleteRequestExecution {
  constructor(private readonly arbiter = new RequestExecutionTerminalArbiter()) {}

  execute(transaction: Prisma.TransactionClient, command: CompleteRequestExecutionCommand): Promise<void> {
    return this.arbiter.execute(transaction, command);
  }
}

export class GetRequestExecutionDetail {
  async execute(transaction: Prisma.TransactionClient, requestId: string, attemptLimit = 100): Promise<RequestExecutionDetail | null> {
    if (!Number.isSafeInteger(attemptLimit) || attemptLimit < 1 || attemptLimit > 500) {
      throw new RelayError("invalid_request_execution_attempt_limit", "RequestExecution attempt limit must be between 1 and 500", 400);
    }
    const execution = await transaction.request_executions.findUnique({ where: { request_id: requestId } });
    if (!execution) return null;
    const attempts = await transaction.request_provider_attempts.findMany({
      where: { request_id: requestId },
      orderBy: [{ attempt_index: "asc" }, { id: "asc" }],
      take: attemptLimit,
    });
    if (!execution.selected_plan_subscription_id || attempts.some((attempt) => !attempt.provider_model_id
      || (attempt.invocation_contract !== "protected@1" && attempt.invocation_contract !== "cpa-basic@1"))) {
      throw new RelayError("request_execution_snapshot_invalid", "RequestExecution detail contains an unsupported mixed-version snapshot", 500);
    }
    return {
      requestId: execution.request_id,
      status: execution.status as RequestExecutionStatus,
      ownerId: execution.owner_id,
      selectedSourceRef: execution.selected_plan_subscription_id,
      attemptCount: execution.attempt_count,
      outputCommitted: execution.output_committed === 1,
      terminalErrorCode: execution.terminal_error_code,
      startedAt: execution.started_at,
      endedAt: execution.ended_at,
      attempts: attempts.map((attempt) => ({
        providerAttemptRef: attempt.id,
        attemptIndex: attempt.attempt_index,
        invocationContract: attempt.invocation_contract as "protected@1" | "cpa-basic@1",
        providerModelId: attempt.provider_model_id!,
        providerId: attempt.provider_id,
        providerModelName: attempt.provider_model_name,
        startedAt: attempt.started_at,
        endedAt: attempt.ended_at,
        outcome: attempt.outcome,
        failureClass: attempt.failure_class,
        failureReason: attempt.failure_reason,
        outputCommitted: attempt.output_committed === 1,
        costExposure: attempt.cost_exposure,
        finalUsageEvidence: attempt.final_usage_evidence,
        usageSettled: attempt.usage_settled === 1,
        reconciliationReason: attempt.reconciliation_reason,
      })),
    };
  }
}

export class ListUnresolvedProviderAttempts {
  execute(transaction: Prisma.TransactionClient, limit = 100): Promise<UnresolvedProviderAttempt[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RelayError("invalid_reconciliation_limit", "Reconciliation limit must be between 1 and 500", 400);
    }
    return transaction.$queryRaw<UnresolvedProviderAttempt[]>(Prisma.sql`
      SELECT attempt."id" AS "providerAttemptRef", attempt."request_id" AS "requestId",
             attempt."invocation_contract" AS "invocationContract",
             attempt."provider_model_id" AS "providerModelId", attempt."provider_id" AS "providerId",
             attempt."provider_model_name" AS "providerModelName", attempt."started_at" AS "startedAt",
             attempt."outcome", attempt."failure_class" AS "failureClass", attempt."failure_reason" AS "failureReason",
             attempt."cost_exposure" AS "costExposure", attempt."reconciliation_reason" AS "reconciliationReason"
      FROM "request_provider_attempts" attempt
      INNER JOIN "request_logs" request ON request."id" = attempt."request_id"
      LEFT JOIN "request_executions" execution ON execution."request_id" = attempt."request_id"
      WHERE attempt."reconciliation_reason" IS NOT NULL
        AND attempt."usage_settled" = 0
        AND ((attempt."invocation_contract" = 'protected@1' AND execution."status" IN ('succeeded', 'failed', 'aborted'))
          OR (attempt."invocation_contract" = 'cpa-basic@1' AND request."ended_at" IS NOT NULL))
      ORDER BY attempt."started_at" ASC, attempt."id" ASC
      LIMIT ${limit}
    `);
  }
}

async function findReplay(
  transaction: Prisma.TransactionClient,
  command: ProviderAttemptAdmissionIdentity,
): Promise<ReplayAdmissionDecision | null> {
  assertProviderAttemptAdmissionIdentity(command);
  const existing = await readAdmissionAttempt(transaction, command.requestId, command.candidate.candidateId, false);
  if (!existing) return null;
  assertEquivalentAttemptIdentity(existing.attempt, command);
  if ("selectedSourceRef" in command && command.selectedSourceRef !== existing.selectedSourceRef) {
    throw new RelayError("request_execution_plan_source_conflict", "A RequestExecution cannot change its admitted source", 409);
  }
  return { kind: "replay", attempt: existing.attempt, selectedSourceRef: existing.selectedSourceRef };
}

type ReplayAdmissionDecision = Extract<ProviderInvocationAdmissionDecision, { kind: "replay" }>;

async function inspectNewAdmission(
  transaction: Prisma.TransactionClient,
  command: ProviderAttemptAdmissionIdentity,
  inspectedAt: string,
  kind: "first" | "fallback",
  preflightReplay?: ReplayAdmissionDecision | null,
): Promise<ProviderInvocationAdmissionDecision> {
  assertProviderAttemptAdmissionIdentity(command);
  const leaseRows = await transaction.$queryRaw<Array<{ ownerId: string; leaseUntil: string }>>`
    SELECT "owner_id" AS "ownerId", "lease_until" AS "leaseUntil"
    FROM "request_execution_leases" WHERE "request_id" = ${command.requestId} FOR UPDATE
  `;
  const lease = leaseRows[0];
  if (!lease || lease.ownerId !== command.executionOwnerId || lease.leaseUntil <= inspectedAt) {
    throw new RelayError("request_execution_lease_lost", "Request execution lease is not continuously held", 409);
  }
  // The caller holds the request/candidate advisory lock while running the
  // preflight lookup. A null preflight result is therefore authoritative for
  // this transaction and avoids reading the same attempt twice.
  const raced = preflightReplay === undefined
    ? await readAdmissionAttempt(transaction, command.requestId, command.candidate.candidateId, true)
    : preflightReplay;
  if (raced) {
    assertEquivalentAttemptIdentity(raced.attempt, command);
    if ("selectedSourceRef" in command && command.selectedSourceRef !== raced.selectedSourceRef) {
      throw new RelayError("request_execution_plan_source_conflict", "A RequestExecution cannot change its admitted source", 409);
    }
    return { kind: "replay", attempt: raced.attempt, selectedSourceRef: raced.selectedSourceRef };
  }
  const executionRows = await transaction.$queryRaw<Array<{
    status: string;
    ownerId: string;
    attemptCount: number;
    selectedSourceRef: string;
  }>>`
    SELECT "status", "owner_id" AS "ownerId", "attempt_count" AS "attemptCount",
           "selected_plan_subscription_id" AS "selectedSourceRef"
    FROM "request_executions" WHERE "request_id" = ${command.requestId} FOR UPDATE
  `;
  const execution = executionRows[0];
  if (kind === "first") {
    if (execution || command.attemptIndex !== 0
      || !("selectedSourceRef" in command)
      || typeof command.selectedSourceRef !== "string") {
      throw new RelayError("request_execution_conflict", "First ProviderAttempt does not match RequestExecution state", 409);
    }
    return { kind: "first", leaseUntil: lease.leaseUntil, selectedSourceRef: command.selectedSourceRef };
  }
  if (!execution || execution.status !== "running"
    || execution.ownerId !== command.executionOwnerId
    || execution.attemptCount !== command.attemptIndex) {
    throw new RelayError("request_execution_conflict", "RequestExecution does not match the next ProviderAttempt", 409);
  }
  const previousRows = await transaction.$queryRaw<Array<{ usageSettled: number }>>`
    SELECT "usage_settled" AS "usageSettled" FROM "request_provider_attempts"
    WHERE "request_id" = ${command.requestId} AND "attempt_index" = ${command.attemptIndex - 1}
    FOR UPDATE
  `;
  if (previousRows[0]?.usageSettled !== 1) {
    throw new RelayError("provider_attempt_previous_unsettled", "A fallback ProviderAttempt cannot be admitted before the previous attempt has final usage", 409);
  }
  return { kind: "fallback", leaseUntil: lease.leaseUntil, selectedSourceRef: execution.selectedSourceRef };
}

async function persistProviderAttempt(
  transaction: Prisma.TransactionClient,
  command: ProviderAttemptAdmissionIdentity,
  decision: Extract<ProviderInvocationAdmissionDecision, { kind: "first" | "fallback" }>,
  startedAt: string,
  material: ProviderAttemptPersistenceMaterial,
): Promise<ProviderAttemptIdentitySnapshot> {
  if (decision.kind === "first") {
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "request_executions" (
        "request_id", "status", "owner_id", "attempt_count", "output_committed",
        "terminal_error_code", "selected_plan_subscription_id", "started_at", "ended_at"
      ) VALUES (
        ${command.requestId}, 'running', ${command.executionOwnerId}, 0, 0,
        NULL, ${decision.selectedSourceRef}, ${startedAt}, NULL
      )
    `);
  }
  const providerAttemptRef = material.providerAttemptRef ?? createId("provider_attempt");
  const attempt = { ...command, providerAttemptRef, startedAt };
  await transaction.request_provider_attempts.create({ data: {
    id: attempt.providerAttemptRef,
    request_id: attempt.requestId,
    attempt_index: attempt.attemptIndex,
    selector_access_point_id: attempt.routing.selectorAccessPointId,
    selector_id: attempt.routing.selectorId,
    selector_behavior_version: attempt.routing.selectorBehaviorVersion,
    routing_revision: attempt.routing.routingRevision,
    candidate_id: attempt.candidate.candidateId,
    selector_target_edge_id: attempt.routing.selectorTargetEdgeId,
    path_target_edge_ids_json: JSON.stringify(attempt.routing.pathTargetEdgeIds),
    access_point_chain_ids_json: JSON.stringify(attempt.routing.accessPointChainIds),
    provider_id: attempt.candidate.providerId,
    provider_model_id: attempt.candidate.providerModelId,
    provider_model_name: attempt.candidate.providerModelName,
    outcome: "pending",
    failure_class: null,
    output_committed: 0,
    trusted_usage_source: null,
    started_at: attempt.startedAt,
    ended_at: null,
    execution_owner_id: attempt.executionOwnerId,
    admission_lease_until: decision.leaseUntil,
    cost_exposure: "not_started",
    final_usage_evidence: "pending",
    usage_settled: 0,
    reconciliation_reason: null,
    invocation_contract: material.invocationContract,
    plan_subscription_id: material.planSubscriptionId,
    api_key_id: material.apiKeyId,
    user_id: material.userId,
    usage_charge_account_id: material.usageChargeAccountId,
    require_service_tier: material.requireServiceTier ? 1 : 0,
    billable_price_profile_json: material.billablePriceProfileJson,
    provider_cost_profile_json: material.providerCostProfileJson,
    access_point_price_profiles_json: material.accessPointPriceProfilesJson,
    billable_price_source: material.billablePriceSource,
    billable_price_id: material.billablePriceId,
    billable_price_tier_key: material.billablePriceTierKey,
    billable_price_snapshot_json: material.billablePriceSnapshotJson,
    routing_revisions_json: JSON.stringify(attempt.routing.routingRevisions),
    input_tokens: material.inputTokens,
    max_output_tokens: material.maxOutputTokens,
    tokenizer_id: material.tokenizerId,
    tokenizer_version: material.tokenizerVersion,
    preparation_evidence_id: material.preparationEvidenceId,
    preparation_evidence_version: material.preparationEvidenceVersion,
    prepared_payload_id: material.preparedPayloadId,
    requested_service_tier: material.requestedServiceTier,
    billing_scope_ref: material.billingScopeRef,
    plan_seller_scope_ref: material.planSellerScopeRef,
    plan_billing_mode: material.planBillingMode,
    subscription_effective_start: material.subscriptionEffectiveStart,
    provider_owner_scope_ref: material.providerOwnerScopeRef,
    provider_model_cost_id: material.providerModelCostId,
    provider_cost_tier_key: material.providerCostTierKey,
    provider_cost_snapshot_json: material.providerCostSnapshotJson,
    access_point_price_snapshots_json: material.accessPointPriceSnapshotsJson,
  } });
  await transaction.request_executions.update({ where: { request_id: command.requestId }, data: { attempt_count: { increment: 1 } } });
  return attempt;
}

async function readAdmissionAttempt(
  transaction: Prisma.TransactionClient,
  requestId: string,
  candidateId: string,
  lock: boolean,
): Promise<{ attempt: ProviderAttemptIdentitySnapshot; selectedSourceRef: string } | null> {
  const lockFragment = lock ? Prisma.sql`FOR UPDATE OF attempt, execution` : Prisma.empty;
  const rows = await transaction.$queryRaw<Array<{
    providerAttemptRef: string;
    requestId: string;
    selectedSourceRef: string;
    executionOwnerId: string;
    attemptIndex: number;
    selectorAccessPointId: string;
    selectorId: string;
    selectorBehaviorVersion: number;
    routingRevision: number;
    routingRevisionsJson: string;
    candidateId: string;
    selectorTargetEdgeId: string;
    pathTargetEdgeIdsJson: string;
    accessPointChainIdsJson: string;
    providerModelId: string;
    providerId: string;
    providerModelName: string;
    startedAt: string;
  }>>(Prisma.sql`
    SELECT attempt."id" AS "providerAttemptRef", attempt."request_id" AS "requestId",
           execution."selected_plan_subscription_id" AS "selectedSourceRef",
           attempt."execution_owner_id" AS "executionOwnerId", attempt."attempt_index" AS "attemptIndex",
           attempt."selector_access_point_id" AS "selectorAccessPointId", attempt."selector_id" AS "selectorId",
           attempt."selector_behavior_version" AS "selectorBehaviorVersion", attempt."routing_revision" AS "routingRevision",
           attempt."routing_revisions_json" AS "routingRevisionsJson", attempt."candidate_id" AS "candidateId",
           attempt."selector_target_edge_id" AS "selectorTargetEdgeId",
           attempt."path_target_edge_ids_json" AS "pathTargetEdgeIdsJson",
           attempt."access_point_chain_ids_json" AS "accessPointChainIdsJson",
           attempt."provider_model_id" AS "providerModelId", attempt."provider_id" AS "providerId",
           attempt."provider_model_name" AS "providerModelName", attempt."started_at" AS "startedAt"
    FROM "request_provider_attempts" attempt
    INNER JOIN "request_executions" execution ON execution."request_id" = attempt."request_id"
    WHERE attempt."request_id" = ${requestId} AND attempt."candidate_id" = ${candidateId}
    ${lockFragment}
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    selectedSourceRef: row.selectedSourceRef,
    attempt: {
      providerAttemptRef: row.providerAttemptRef,
      requestId: row.requestId,
      executionOwnerId: row.executionOwnerId,
      attemptIndex: row.attemptIndex,
      candidate: {
        candidateId: row.candidateId,
        providerModelId: row.providerModelId,
        providerId: row.providerId,
        providerModelName: row.providerModelName,
      },
      routing: {
        selectorAccessPointId: row.selectorAccessPointId,
        selectorId: row.selectorId,
        selectorBehaviorVersion: row.selectorBehaviorVersion,
        routingRevision: row.routingRevision,
        routingRevisions: parseRoutingRevisions(row.routingRevisionsJson),
        selectorTargetEdgeId: row.selectorTargetEdgeId,
        pathTargetEdgeIds: parseStringifiedArray(row.pathTargetEdgeIdsJson, "path target edges") as string[],
        accessPointChainIds: parseStringifiedArray(row.accessPointChainIdsJson, "AccessPoint chain") as string[],
      },
      startedAt: row.startedAt,
    },
  };
}

function assertEquivalentAttemptIdentity(existing: ProviderAttemptIdentitySnapshot, command: ProviderAttemptAdmissionIdentity): void {
  const equivalent = existing.requestId === command.requestId
    && existing.executionOwnerId === command.executionOwnerId
    && existing.attemptIndex === command.attemptIndex
    && existing.candidate.candidateId === command.candidate.candidateId
    && existing.candidate.providerModelId === command.candidate.providerModelId
    && existing.candidate.providerId === command.candidate.providerId
    && existing.candidate.providerModelName === command.candidate.providerModelName
    && existing.routing.selectorAccessPointId === command.routing.selectorAccessPointId
    && existing.routing.selectorId === command.routing.selectorId
    && existing.routing.selectorBehaviorVersion === command.routing.selectorBehaviorVersion
    && existing.routing.routingRevision === command.routing.routingRevision
    && JSON.stringify(existing.routing.routingRevisions) === JSON.stringify(command.routing.routingRevisions)
    && existing.routing.selectorTargetEdgeId === command.routing.selectorTargetEdgeId
    && JSON.stringify(existing.routing.pathTargetEdgeIds) === JSON.stringify(command.routing.pathTargetEdgeIds)
    && JSON.stringify(existing.routing.accessPointChainIds) === JSON.stringify(command.routing.accessPointChainIds);
  if (!equivalent) throw new RelayError("provider_attempt_idempotency_conflict", "Existing ProviderAttempt does not match the admission command", 409);
}

function parseStringifiedArray(json: string, label: string): unknown[] {
  let value: unknown;
  try { value = JSON.parse(json) as unknown; } catch { throw new RelayError("provider_attempt_snapshot_invalid", `ProviderAttempt ${label} snapshot is invalid`, 500); }
  if (!Array.isArray(value)) throw new RelayError("provider_attempt_snapshot_invalid", `ProviderAttempt ${label} snapshot is invalid`, 500);
  return value;
}

function parseRoutingRevisions(json: string): Array<{ accessPointId: string; routingRevision: number }> {
  const items = parseStringifiedArray(json, "routing revisions");
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RelayError("provider_attempt_snapshot_invalid", "ProviderAttempt routing revision snapshot is invalid", 500);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.accessPointId !== "string" || !Number.isSafeInteger(record.routingRevision)) {
      throw new RelayError("provider_attempt_snapshot_invalid", "ProviderAttempt routing revision snapshot is invalid", 500);
    }
    return { accessPointId: record.accessPointId, routingRevision: record.routingRevision as number };
  });
}

function providerAttemptFailureReason(outcome: string, reason: unknown): ProviderCredentialFailureReason | null {
  if (outcome !== "failed") {
    if (reason !== null && reason !== undefined) throw new RelayError("provider_attempt_failure_reason_invalid", "ProviderAttempt failure reason is invalid", 400);
    return null;
  }
  if (reason === null || reason === undefined) return null;
  if (!isProviderCredentialFailureReason(reason)) {
    throw new RelayError("provider_attempt_failure_reason_invalid", "ProviderAttempt failure reason is invalid", 400);
  }
  return reason;
}

function isTerminalExecutionStatus(status: string | null): boolean {
  return status === "succeeded" || status === "failed" || status === "aborted";
}

function requestExecutionLeaseUntil(value: string, seconds: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(seconds) || seconds < 1) {
    throw new RelayError("request_execution_lease_ttl_invalid", "Request execution lease boundary is invalid", 500);
  }
  return new Date(timestamp + seconds * 1_000).toISOString();
}
