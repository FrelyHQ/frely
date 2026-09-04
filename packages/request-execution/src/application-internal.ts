import type { Prisma, PrismaTransactionOwner } from "@frely/postgres/server";
import type {
  AdmitFallbackProviderInvocationCommand,
  AdmitFirstProviderInvocationCommand,
  FinalizeProviderInvocationCommand,
  ProviderAttemptIdentitySnapshot,
  ProviderInvocationAdmissionDecision,
  ProviderInvocationDispatchDecision,
  ProviderInvocationFinalizationDecision,
  ProviderInvocationReconciliationDecision,
  ReconcileProviderInvocationCommand,
  RequestExecutionDetail,
  UnresolvedProviderAttempt,
} from "./contracts.js";
import {
  AdmitFallbackProviderInvocation,
  AdmitFirstProviderInvocation,
  AssertProviderInvocationDispatch,
  CompleteRequestExecution,
  FailRequestExecution,
  FinalizeProviderInvocation,
  GetRequestExecutionDetail,
  ListUnresolvedProviderAttempts,
  ReconcileProviderInvocation,
  RequestExecutionLeaseService,
  type ProviderAttemptPersistenceMaterial,
} from "./server.js";

interface BoundAdmissionParticipant<Command extends AdmitFirstProviderInvocationCommand | AdmitFallbackProviderInvocationCommand> {
  findReplay(command: Command): Promise<Extract<ProviderInvocationAdmissionDecision, { kind: "replay" }> | null>;
  inspectNew(command: Command, inspectedAt: string, preflightReplay?: Extract<ProviderInvocationAdmissionDecision, { kind: "replay" }> | null): Promise<ProviderInvocationAdmissionDecision>;
  execute(
    command: Command,
    decision: Extract<ProviderInvocationAdmissionDecision, { kind: "first" | "fallback" }>,
    startedAt: string,
    material: ProviderAttemptPersistenceMaterial,
  ): Promise<ProviderAttemptIdentitySnapshot>;
}

export interface BoundRequestExecutionParticipants {
  firstAdmission: BoundAdmissionParticipant<AdmitFirstProviderInvocationCommand>;
  fallbackAdmission: BoundAdmissionParticipant<AdmitFallbackProviderInvocationCommand>;
  dispatch: {
    execute(providerAttemptRef: string, requestId: string, executionOwnerId: string, checkedAt: string): Promise<ProviderInvocationDispatchDecision>;
  };
  finalization: {
    lock(command: FinalizeProviderInvocationCommand, requireReconciliation: boolean): Promise<ProviderInvocationFinalizationDecision>;
    complete(decision: ProviderInvocationFinalizationDecision, command: FinalizeProviderInvocationCommand, completedAt: string): Promise<void>;
  };
  reconciliation: {
    execute(command: ReconcileProviderInvocationCommand, transitionedAt: string): Promise<ProviderInvocationReconciliationDecision>;
  };
  failure: {
    execute(requestId: string, executionOwnerId: string, errorCode: string, failedAt: string): Promise<void>;
  };
}

export interface BoundRequestExecutionQueries {
  getDetail(requestId: string, attemptLimit?: number): Promise<RequestExecutionDetail | null>;
  listUnresolved(limit?: number): Promise<UnresolvedProviderAttempt[]>;
}

export function bindRequestExecutionParticipants(transaction: Prisma.TransactionClient): BoundRequestExecutionParticipants {
  const first = new AdmitFirstProviderInvocation();
  const fallback = new AdmitFallbackProviderInvocation();
  const dispatch = new AssertProviderInvocationDispatch();
  const finalization = new FinalizeProviderInvocation();
  const reconciliation = new ReconcileProviderInvocation();
  const failure = new FailRequestExecution();
  const bindAdmission = <Command extends AdmitFirstProviderInvocationCommand | AdmitFallbackProviderInvocationCommand>(
    participant: AdmitFirstProviderInvocation | AdmitFallbackProviderInvocation,
  ): BoundAdmissionParticipant<Command> => Object.freeze({
    findReplay: (command: Command) => participant.findReplay(transaction, command as never),
    inspectNew: (
      command: Command,
      inspectedAt: string,
      preflightReplay: Extract<ProviderInvocationAdmissionDecision, { kind: "replay" }> | null | undefined,
    ) => participant.inspectNew(transaction, command as never, inspectedAt, preflightReplay),
    execute: (
      command: Command,
      decision: Extract<ProviderInvocationAdmissionDecision, { kind: "first" | "fallback" }>,
      startedAt: string,
      material: ProviderAttemptPersistenceMaterial,
    ) => participant.execute(
      transaction,
      command as never,
      decision as never,
      startedAt,
      material,
    ),
  });
  return Object.freeze({
    firstAdmission: bindAdmission<AdmitFirstProviderInvocationCommand>(first),
    fallbackAdmission: bindAdmission<AdmitFallbackProviderInvocationCommand>(fallback),
    dispatch: Object.freeze({ execute: dispatch.execute.bind(dispatch, transaction) }),
    finalization: Object.freeze({
      lock: finalization.lock.bind(finalization, transaction),
      complete: finalization.complete.bind(finalization, transaction),
    }),
    reconciliation: Object.freeze({ execute: reconciliation.execute.bind(reconciliation, transaction) }),
    failure: Object.freeze({ execute: failure.execute.bind(failure, transaction) }),
  });
}

export function bindRequestExecutionQueries(transaction: Prisma.TransactionClient): BoundRequestExecutionQueries {
  const detail = new GetRequestExecutionDetail();
  const unresolved = new ListUnresolvedProviderAttempts();
  return Object.freeze({
    getDetail: detail.execute.bind(detail, transaction),
    listUnresolved: unresolved.execute.bind(unresolved, transaction),
  });
}

export function createRequestExecutionLeaseCommands(
  owner: PrismaTransactionOwner,
  clock?: () => string,
): import("./contracts.js").RequestExecutionLeasePort {
  return new RequestExecutionLeaseService(owner, clock);
}

export { CompleteRequestExecution, RequestExecutionLeaseService };
export type { ProviderAttemptPersistenceMaterial };
