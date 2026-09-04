import { isSafeExternalEvidenceRef, nowIso, RelayError, type ProviderCredentialFailureReason, type ProviderFailureClass } from "@frely/core";
import type { AuditActor } from "@frely/audit";
import { AuditCommandService, bindAuditCommands, createAuditCommands, type AuditEventAppender, PrismaAuditEventAppender } from "@frely/audit/application-internal";
import { Prisma, type PrismaTransactionOwner } from "@frely/postgres/server";
import {
  BILLING_MAX_INT64,
  frozenAccessPointPriceIds,
  maximumInvocationChargeUnits,
  parseFrozenPriceUnits,
  validateUsage,
  type InvocationUsageUnits,
} from "@frely/billing";
import {
  bindBillingInvocationParticipants,
  type BoundClaimlessInvocationPreparationParticipant,
  type BoundInvocationAdmissionParticipant,
  type BoundInvocationReconciliationParticipant,
  type BoundInvocationSettlementParticipant,
  type InvocationFundingLock,
} from "@frely/billing/application-internal";
import type {
  AdmitFallbackProviderInvocationCommand,
  AdmitFirstProviderInvocationCommand,
  FinalizeProviderInvocationCommand,
  ProviderAttemptAdmissionIdentity,
  ProviderAttemptIdentitySnapshot,
  ProviderInvocationAdmissionDecision,
  ReconcileProviderInvocationCommand as RequestExecutionReconciliationCommand,
  RoutingRevisionExpectation,
} from "@frely/request-execution";
import type {
  RequestExecutionCommands,
  RequestExecutionQueries,
  RequestExecutionReconciliationReadWorkflow,
} from "../../request-execution.js";
import {
  bindRequestExecutionParticipants,
  type BoundRequestExecutionParticipants,
  type ProviderAttemptPersistenceMaterial,
} from "@frely/request-execution/application-internal";
import {
  ProviderInvocationQueryService,
  ProviderInvocationReconciliationReadWorkflow,
} from "./queries.js";

export type { RoutingRevisionExpectation } from "@frely/request-execution";

export interface AdmitProviderInvocationCommand {
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
  inputTokens: bigint;
  maxOutputTokens: bigint;
  tokenizerId: string;
  tokenizerVersion: number;
  preparationEvidenceId: string;
  preparationEvidenceVersion: number;
  preparedPayloadId: string;
  serviceTier: string;
  billablePriceSource: "access_point" | "plan_access_point";
  billablePriceId: string;
  providerModelCostId: string;
  accessPointPriceIds: string[];
  usageChargeAccountId: string | null;
}

export interface ProviderInvocationAdmission {
  providerAttemptId: string;
  budgetClaimMaxTokens: bigint;
  budgetClaimMaxChargeUnits: bigint;
  usageReservationId: string | null;
  reservationUnits: bigint | null;
  startedAt: string;
}

export interface AdmitCpaBasicProviderInvocationCommand {
  providerAttemptId?: string;
  requestId: string;
  executionOwnerId: string;
  attemptIndex: number;
  selectorAccessPointId: string;
  selectorId: string;
  selectorBehaviorVersion: number;
  routingRevision: number;
  routingRevisions: readonly RoutingRevisionExpectation[];
  candidateId: string;
  selectorTargetEdgeId: string;
  pathTargetEdgeIds: readonly string[];
  accessPointChainIds: readonly string[];
  providerModelId: string;
  providerId: string;
  providerModelName: string;
  planId: string;
  planSubscriptionId: string;
  apiKeyId: string;
  userId: string;
  requestedServiceTier: string;
  requireServiceTier: boolean;
  billablePriceSource: "access_point" | "plan_access_point";
  billablePriceId: string;
  providerModelCostId: string;
  accessPointPriceIds: readonly string[];
  usageChargeAccountId: string | null;
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

export interface ProviderInvocationStage1Options {
  userPaygoConcurrencyLimit?: number;
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

export interface ProviderInvocationVerificationParticipant {
  admitCpaBasic(command: AdmitCpaBasicProviderInvocationCommand): Promise<CpaBasicProviderInvocationAdmission>;
  admitCpaBasicWithCanceledPartnerEntitlement(input: {
    command: AdmitCpaBasicProviderInvocationCommand;
    entitlement: {
      id: string;
      sourceOrderId: string;
      ownerUserId: string;
      partnerTeamId: string;
      partnerPlanId: string;
      planSubscriptionId: string;
      effectiveStart: string;
      effectiveEnd: string;
      createdAt: string;
    };
  }): Promise<CpaBasicProviderInvocationAdmission>;
}

export function createProviderInvocationVerificationParticipant(
  transactions: PrismaTransactionOwner,
  options: ProviderInvocationStage1Options = {},
  auditAppender: AuditEventAppender = new PrismaAuditEventAppender(),
): ProviderInvocationVerificationParticipant {
  const runner = new ProviderInvocationTransactionRunner(transactions, options, auditAppender);
  return Object.freeze({
    admitCpaBasic: (command: AdmitCpaBasicProviderInvocationCommand) => runner.run((participant) => participant.admitCpaBasic(command), 1),
    admitCpaBasicWithCanceledPartnerEntitlement: (input: Parameters<ProviderInvocationVerificationParticipant["admitCpaBasicWithCanceledPartnerEntitlement"]>[0]) => runner.run(
      (participant) => participant.admitCpaBasicWithCanceledPartnerEntitlement(input),
      1,
    ),
  });
}

export interface RequestExecutionApplicationCapabilities {
  readonly queries: RequestExecutionQueries;
  readonly commands: RequestExecutionCommands;
  readonly reconciliationRead: RequestExecutionReconciliationReadWorkflow;
}

export function createRequestExecutionApplicationCapabilities(
  transactions: PrismaTransactionOwner,
  options: ProviderInvocationStage1Options = {},
  auditAppender: AuditEventAppender = new PrismaAuditEventAppender(),
): RequestExecutionApplicationCapabilities {
  const queries: RequestExecutionQueries = Object.freeze(new ProviderInvocationQueryService(transactions));
  const commands: RequestExecutionCommands = Object.freeze(new ProviderInvocationCommandService(transactions, options, auditAppender));
  const reconciliationRead: RequestExecutionReconciliationReadWorkflow = Object.freeze(
    new ProviderInvocationReconciliationReadWorkflow(queries, createAuditCommands(transactions, auditAppender)),
  );
  if ((queries as object) === (commands as object)) throw new Error("request_execution_capability_identity_reused");
  return Object.freeze({ queries, commands, reconciliationRead });
}

class ProviderInvocationCommandService implements RequestExecutionCommands {
  readonly userPaygoConcurrencyLimit: number;
  private readonly runner: ProviderInvocationTransactionRunner;
  private readonly audit: AuditCommandService;

  constructor(
    transactions: PrismaTransactionOwner,
    options: ProviderInvocationStage1Options = {},
    auditAppender: AuditEventAppender = new PrismaAuditEventAppender(),
  ) {
    this.runner = new ProviderInvocationTransactionRunner(transactions, options, auditAppender);
    this.audit = new AuditCommandService(transactions, auditAppender);
    this.userPaygoConcurrencyLimit = this.runner.userPaygoConcurrencyLimit;
  }

  admit(command: AdmitProviderInvocationCommand): Promise<ProviderInvocationAdmission> {
    // BudgetClaim and the PayGo reservation are one Serializable admission decision.
    return this.runner.run((participant) => participant.admit(command), 3, { isolationLevel: "Serializable" });
  }

  admitCpaBasic(command: AdmitCpaBasicProviderInvocationCommand): Promise<CpaBasicProviderInvocationAdmission> {
    return this.runner.run((participant) => participant.admitCpaBasic(command), 1);
  }

  async assertDispatchOwnership(providerAttemptId: string, requestId: string, executionOwnerId: string): Promise<void> {
    const owned = await this.runner.run((participant) => participant.assertDispatchOwnership(providerAttemptId, requestId, executionOwnerId));
    if (!owned) throw new RelayError("provider_invocation_ownership_lost", "Provider invocation cannot be dispatched after execution ownership continuity is lost", 409);
  }

  settleFinalUsage(command: SettleProviderInvocationCommand) {
    return this.runner.run((participant) => participant.settleFinalUsage(command));
  }

  async settleCpaBasicLive(command: SettleProviderInvocationCommand) {
    try {
      return await this.runner.run((participant) => participant.settleCpaBasicLive(command), 1);
    } catch (error) {
      await this.runner.run((participant) => participant.transitionFailedCpaBasicSettlement({
        providerAttemptId: command.providerAttemptId,
        outcome: command.outcome,
        ...(command.failureClass !== undefined ? { failureClass: command.failureClass } : {}),
        ...(command.outputCommitted !== undefined ? { outputCommitted: command.outputCommitted } : {}),
      }), 1);
      throw error;
    }
  }

  async reconcileFinalUsage(command: ReconcileFinalProviderInvocationCommand) {
    assertReconciliationEvidence(command);
    try {
      return await this.runner.run((participant) => participant.reconcileFinalUsage(command), 1);
    } catch (error) {
      await this.audit.record({
        actor: command.audit.actor,
        source: "owner",
        requestId: command.audit.requestId,
        action: "provider_invocation.reconcile_final",
        resourceType: "provider_invocation",
        resourceId: command.providerAttemptId,
        result: "failure",
        metadata: {
          routePattern: "/api/owner/provider-invocations/:id/reconcile-final",
          evidenceKind: command.evidenceKind,
          evidenceRef: command.evidenceRef,
          usageSource: command.usage.source,
          errorCode: error instanceof RelayError ? error.code : "internal_error",
        },
      });
      throw error;
    }
  }

  releaseNotStarted(input: Omit<SettleProviderInvocationCommand, "usage">) {
    return this.runner.run((participant) => participant.releaseNotStarted(input));
  }

  enterReconciliation(command: ReconcileProviderInvocationCommand): Promise<void> {
    return this.runner.run((participant) => participant.enterReconciliation(command));
  }

  failRequestExecution(requestId: string, executionOwnerId: string, errorCode: string): Promise<void> {
    return this.runner.run((participant) => participant.failRequestExecution(requestId, executionOwnerId, errorCode));
  }
}

class ProviderInvocationTransactionRunner {
  readonly userPaygoConcurrencyLimit: number;

  constructor(
    private readonly transactions: PrismaTransactionOwner,
    options: ProviderInvocationStage1Options,
    private readonly auditAppender: AuditEventAppender,
  ) {
    const limit = options.userPaygoConcurrencyLimit ?? 2;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("user_paygo_concurrency_limit_invalid");
    this.userPaygoConcurrencyLimit = limit;
  }

  run<T>(
    callback: (participant: BoundProviderInvocationOperationParticipant) => Promise<T>,
    maxAttempts = 3,
    options: { isolationLevel?: "ReadCommitted" | "Serializable"; statementTimeoutMillis?: number } = {},
  ): Promise<T> {
    return this.transactions.withPrismaTransaction(
      (transaction) => callback(new BoundProviderInvocationOperationParticipant(
        transaction,
        this.userPaygoConcurrencyLimit,
        this.auditAppender,
      )),
      maxAttempts,
      options,
    );
  }
}

class BoundProviderInvocationOperationParticipant implements ProviderInvocationVerificationParticipant {
  private readonly participants: BoundProviderInvocationParticipants;

  constructor(
    private readonly transaction: Prisma.TransactionClient,
    userPaygoConcurrencyLimit: number,
    private readonly auditAppender: AuditEventAppender,
  ) {
    this.participants = bindProviderInvocationParticipants(transaction, userPaygoConcurrencyLimit);
  }

  admit(command: AdmitProviderInvocationCommand): Promise<ProviderInvocationAdmission> {
    return admitProviderInvocation(this.transaction, command, this.participants.billing.admission, this.participants.requestExecution.firstAdmission, this.participants.requestExecution.fallbackAdmission);
  }

  admitCpaBasic(command: AdmitCpaBasicProviderInvocationCommand): Promise<CpaBasicProviderInvocationAdmission> {
    return admitCpaBasicProviderInvocationInTransaction(this.transaction, command, this.participants);
  }

  async admitCpaBasicWithCanceledPartnerEntitlement(input: Parameters<ProviderInvocationVerificationParticipant["admitCpaBasicWithCanceledPartnerEntitlement"]>[0]): Promise<CpaBasicProviderInvocationAdmission> {
    const item = input.entitlement;
    await this.transaction.partner_operating_entitlements.create({ data: {
      id: item.id,
      source_order_id: item.sourceOrderId,
      owner_user_id: item.ownerUserId,
      partner_team_id: item.partnerTeamId,
      partner_plan_id: item.partnerPlanId,
      plan_subscription_id: item.planSubscriptionId,
      effective_start: item.effectiveStart,
      effective_end: item.effectiveEnd,
      lifecycle: "canceled",
      created_at: item.createdAt,
    } });
    return this.admitCpaBasic(input.command);
  }

  assertDispatchOwnership(providerAttemptId: string, requestId: string, executionOwnerId: string): Promise<boolean> {
    return assertDispatchOwnership(this.transaction, providerAttemptId, requestId, executionOwnerId, this.participants.billing.reconciliation, this.participants.requestExecution.dispatch);
  }

  settleFinalUsage(command: SettleProviderInvocationCommand) {
    return settleFinalUsage(this.transaction, command, "settled", this.participants.billing.settlement, undefined, this.participants.requestExecution.finalization, false);
  }

  settleCpaBasicLive(command: SettleProviderInvocationCommand) {
    return settleFinalUsage(this.transaction, command, "settled", this.participants.billing.settlement, undefined, this.participants.requestExecution.finalization, false, "cpa-basic@1");
  }

  transitionFailedCpaBasicSettlement(command: Omit<SettleProviderInvocationCommand, "usage" | "requestTerminalStatus" | "requestTerminalErrorCode">): Promise<void> {
    return enterReconciliation(this.transaction, {
      providerAttemptId: command.providerAttemptId,
      outcome: command.outcome,
      ...(command.failureClass !== undefined ? { failureClass: command.failureClass } : {}),
      ...(command.failureReason !== undefined ? { failureReason: command.failureReason } : {}),
      ...(command.outputCommitted !== undefined ? { outputCommitted: command.outputCommitted } : {}),
      costExposure: "stopped",
      finalUsageEvidence: "pending",
      reason: "provider_usage_settlement_failed",
    }, this.participants.billing.reconciliation, this.participants.requestExecution.reconciliation);
  }

  async reconcileFinalUsage(command: ReconcileFinalProviderInvocationCommand) {
    const account = await this.participants.billing.settlement.lockFunding(command.providerAttemptId);
    const settled = await settleFinalUsage(this.transaction, command, "settled", this.participants.billing.settlement, account, this.participants.requestExecution.finalization, true);
    await bindAuditCommands(this.transaction, this.auditAppender).record({
      actor: command.audit.actor,
      source: "owner",
      requestId: command.audit.requestId,
      action: "provider_invocation.reconcile_final",
      resourceType: "provider_invocation",
      resourceId: command.providerAttemptId,
      result: "success",
      metadata: {
        routePattern: "/api/owner/provider-invocations/:id/reconcile-final",
        evidenceKind: command.evidenceKind,
        evidenceRef: command.evidenceRef,
        usageSource: command.usage.source,
        billingEventId: settled.billingEventId,
        actualChargeUnits: settled.actualChargeUnits.toString(),
        postingCreated: settled.postingLedgerEventId !== null,
      },
    });
    return settled;
  }

  async releaseNotStarted(input: Omit<SettleProviderInvocationCommand, "usage">): Promise<{ actualChargeUnits: 0n; postingLedgerEventId: null; billingEventId: string }> {
    const usage: InvocationUsageUnits = { inputTokens: 0n, cachedInputTokens: 0n, cacheWriteTokens: 0n, outputTokens: 0n, totalTokens: 0n, source: "provider" };
    const settled = await settleFinalUsage(this.transaction, { ...input, usage }, "released", this.participants.billing.settlement, undefined, this.participants.requestExecution.finalization, false);
    return { actualChargeUnits: 0n, postingLedgerEventId: null, billingEventId: settled.billingEventId };
  }

  enterReconciliation(command: ReconcileProviderInvocationCommand): Promise<void> {
    return enterReconciliation(this.transaction, command, this.participants.billing.reconciliation, this.participants.requestExecution.reconciliation);
  }

  failRequestExecution(requestId: string, executionOwnerId: string, errorCode: string): Promise<void> {
    return this.participants.requestExecution.failure.execute(requestId, executionOwnerId, errorCode, nowIso());
  }
}

interface BoundProviderInvocationParticipants {
  billing: ReturnType<typeof bindBillingInvocationParticipants>;
  requestExecution: BoundRequestExecutionParticipants;
}

function bindProviderInvocationParticipants(
  transaction: Prisma.TransactionClient,
  userPaygoConcurrencyLimit: number,
): BoundProviderInvocationParticipants {
  return {
    billing: bindBillingInvocationParticipants(transaction, userPaygoConcurrencyLimit),
    requestExecution: bindRequestExecutionParticipants(transaction),
  };
}

function assertReconciliationEvidence(command: ReconcileFinalProviderInvocationCommand): void {
  if (!["provider_operation_query", "provider_billing_record", "provider_response"].includes(command.evidenceKind)) {
    throw new RelayError("invalid_provider_reconciliation_evidence", "evidenceKind is not an authoritative final evidence type", 400);
  }
  if (!isSafeExternalEvidenceRef(command.evidenceRef)) {
    throw new RelayError("invalid_provider_reconciliation_evidence", "evidenceRef must be a bounded non-secret external reference", 400);
  }
  const expectedSource = command.evidenceKind === "provider_response" ? "response" : "provider";
  if (command.usage.source !== expectedSource) {
    throw new RelayError("invalid_provider_reconciliation_evidence", "Final usage source does not match evidenceKind", 400);
  }
}

async function admitCpaBasicProviderInvocationInTransaction(
  transaction: Prisma.TransactionClient,
  command: AdmitCpaBasicProviderInvocationCommand,
  participants: BoundProviderInvocationParticipants,
): Promise<CpaBasicProviderInvocationAdmission> {

  assertCpaBasicAdmissionShape(command);
  const admissionIdentity = cpaBasicRequestExecutionAdmissionIdentity(command);
  const firstAdmissionCommand: AdmitFirstProviderInvocationCommand | null = command.attemptIndex === 0
    ? { ...admissionIdentity, attemptIndex: 0, selectedSourceRef: command.planSubscriptionId }
    : null;
  const fallbackAdmissionCommand: AdmitFallbackProviderInvocationCommand | null = command.attemptIndex > 0
    ? admissionIdentity
    : null;
  const firstAdmission = participants.requestExecution.firstAdmission;
  const fallbackAdmission = participants.requestExecution.fallbackAdmission;
  await transaction.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`friday-relay:cpa-basic:${command.requestId}:${command.candidateId}`}, 0))
  `);
  const existingRows = await transaction.$queryRaw<CpaBasicAttemptIdentityRow[]>(Prisma.sql`
    SELECT "id", "request_id" AS "requestId", "attempt_index" AS "attemptIndex",
           "selector_access_point_id" AS "selectorAccessPointId", "selector_id" AS "selectorId",
           "selector_behavior_version" AS "selectorBehaviorVersion", "routing_revision" AS "routingRevision",
           "routing_revisions_json" AS "routingRevisionsJson", "candidate_id" AS "candidateId",
           "selector_target_edge_id" AS "selectorTargetEdgeId", "path_target_edge_ids_json" AS "pathTargetEdgeIdsJson",
           "access_point_chain_ids_json" AS "accessPointChainIdsJson", "provider_model_id" AS "providerModelId",
           "provider_id" AS "providerId", "provider_model_name" AS "providerModelName",
           "plan_subscription_id" AS "planSubscriptionId", "api_key_id" AS "apiKeyId", "user_id" AS "userId",
           "usage_charge_account_id" AS "usageChargeAccountId", "requested_service_tier" AS "requestedServiceTier",
           "require_service_tier" AS "requireServiceTier", "billable_price_source" AS "billablePriceSource",
           "billable_price_id" AS "billablePriceId", "provider_model_cost_id" AS "providerModelCostId",
           "access_point_price_profiles_json" AS "accessPointPriceProfilesJson", "started_at" AS "startedAt",
           "invocation_contract" AS "invocationContract"
    FROM "request_provider_attempts"
    WHERE "request_id" = ${command.requestId}
      AND ("candidate_id" = ${command.candidateId} OR "attempt_index" = ${command.attemptIndex})
    FOR UPDATE
  `);
  if (existingRows.length > 0) {
    const existing = existingRows.find((row) => row.candidateId === command.candidateId);
    if (!existing || existingRows.length !== 1) {
      throw new RelayError("provider_attempt_idempotency_conflict", "CPA basic ProviderAttempt index is already used by a different candidate", 409);
    }
    assertEquivalentCpaBasicAttempt(existing, command);
    const replay = firstAdmissionCommand
      ? await firstAdmission.findReplay(firstAdmissionCommand)
      : await fallbackAdmission.findReplay(fallbackAdmissionCommand!);
    if (!replay) {
      throw new RelayError("provider_invocation_ownership_lost", "A legacy ProviderAttempt without RequestExecution ownership cannot be redispatched", 409);
    }
    return { providerAttemptId: existing.id, startedAt: existing.startedAt, replayed: true };
  }

  const now = await providerInvocationDatabaseNow(transaction);
  const requests = await transaction.$queryRaw<Array<{
    apiKeyId: string;
    userId: string;
    planId: string | null;
    planSubscriptionId: string | null;
    entryAccessPointId: string | null;
    billingScopeRef: string | null;
    endedAt: string | null;
  }>>(Prisma.sql`
    SELECT "api_key_id" AS "apiKeyId", "user_id" AS "userId", "plan_id" AS "planId",
           "plan_subscription_id" AS "planSubscriptionId", "entry_access_point_id" AS "entryAccessPointId",
           "billing_scope_ref" AS "billingScopeRef", "ended_at" AS "endedAt"
    FROM "request_logs" WHERE "id" = ${command.requestId} FOR UPDATE
  `);
  const request = requests[0];
  const entryAccessPointId = command.accessPointChainIds[0]!;
  if (!request || request.endedAt !== null || request.apiKeyId !== command.apiKeyId || request.userId !== command.userId
    || request.planId !== command.planId || request.planSubscriptionId !== command.planSubscriptionId
    || request.entryAccessPointId !== entryAccessPointId) {
    throw new RelayError("request_execution_not_found", "CPA basic ProviderAttempt references do not match the active Request Log", 409);
  }
  const principals = await transaction.$queryRaw<Array<{
    userId: string;
    userStatus: string;
    apiKeyStatus: string;
    revokedAt: string | null;
    expiresAt: string | null;
  }>>(Prisma.sql`
    SELECT key_row."user_id" AS "userId", user_row."status" AS "userStatus",
           key_row."status" AS "apiKeyStatus", key_row."revoked_at" AS "revokedAt",
           key_row."expires_at" AS "expiresAt"
    FROM "api_keys" key_row
    INNER JOIN "user_controls" user_row ON user_row."id" = key_row."user_id"
    WHERE key_row."id" = ${command.apiKeyId}
    FOR SHARE OF key_row, user_row
  `);
  const principal = principals[0];
  if (!principal || principal.userId !== command.userId || principal.userStatus !== "enabled"
    || principal.apiKeyStatus !== "enabled" || principal.revokedAt !== null
    || (principal.expiresAt !== null && principal.expiresAt <= now)) {
    throw new RelayError("request_execution_not_found", "CPA basic principal changed before Provider invocation admission", 409);
  }
  const sourceRows = await transaction.$queryRaw<Array<{
    planId: string;
    scopeRef: string;
    effectiveStart: string;
    effectiveEnd: string | null;
    lifecycle: string;
    planStatus: string;
    planScopeRef: string;
    billingMode: string;
  }>>(Prisma.sql`
    SELECT subscription."plan_id" AS "planId", subscription."scope_ref" AS "scopeRef",
           subscription."effective_start" AS "effectiveStart", subscription."effective_end" AS "effectiveEnd",
           subscription."subscription_lifecycle" AS "lifecycle", plan."plan_status" AS "planStatus",
           plan."scope_ref" AS "planScopeRef", plan."billing_mode" AS "billingMode"
    FROM "plan_subscriptions" subscription
    INNER JOIN "plans" plan ON plan."id" = subscription."plan_id"
    WHERE subscription."id" = ${command.planSubscriptionId}
    FOR UPDATE OF subscription, plan
  `);
  const source = sourceRows[0];
  if (!source || source.planId !== command.planId || source.lifecycle !== "active"
    || source.effectiveStart > now || (source.effectiveEnd !== null && source.effectiveEnd <= now)
    || (source.planStatus !== "enabled" && source.planStatus !== "closed")) {
    throw new RelayError("plan_subscription_unavailable", "CPA basic Plan source changed before Provider invocation admission", 402);
  }
  if (request.billingScopeRef !== source.scopeRef) {
    throw new RelayError("plan_subscription_unavailable", "CPA basic Request Log scope no longer matches the Plan source", 409);
  }
  await assertCpaBasicSourceAuthorization(transaction, source.scopeRef, command.userId, now);
  if (source.billingMode !== "prepaid" && source.billingMode !== "paygo") {
    throw new RelayError("plan_billing_mode_invalid", "Plan billing mode is invalid", 500);
  }
  if ((source.billingMode === "paygo") !== Boolean(command.usageChargeAccountId)) {
    throw new RelayError("usage_charge_account_not_found", "CPA basic PayGo account reference is invalid", 409);
  }
  if (command.usageChargeAccountId) {
    const accounts = await transaction.$queryRaw<Array<{ scopeRef: string; status: string; balanceSnapUnits: bigint }>>(Prisma.sql`
      SELECT "scope_ref" AS "scopeRef", "status", "balance_snap_units" AS "balanceSnapUnits"
      FROM "credit_accounts" WHERE "id" = ${command.usageChargeAccountId} FOR UPDATE
    `);
    const account = accounts[0];
    if (!account || account.scopeRef !== `user:${command.userId}` || account.status !== "active") {
      throw new RelayError("usage_charge_account_not_found", "CPA basic PayGo account is unavailable", 402);
    }
    if (account.balanceSnapUnits <= 0n) {
      throw new RelayError("insufficient_credit", "CPA basic Provider invocation requires a positive PayGo balance", 402);
    }
  }

  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('friday-relay:model-access-routing-graph', 0))`;
  const entitlements = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "plan_access_points"
    WHERE "plan_id" = ${command.planId} AND "access_point_id" = ${entryAccessPointId}
    FOR SHARE
  `);
  if (!entitlements[0]) throw new RelayError("access_configuration_changed", "Plan no longer includes the entry AccessPoint", 409);

  const accessPoints = await transaction.$queryRaw<Array<{
    id: string;
    scopeRef: string;
    status: string;
    removedAt: string | null;
    selectorId: string;
    selectorBehaviorVersion: number;
    routingRevision: number;
  }>>(Prisma.sql`
    SELECT "id", "scope_ref" AS "scopeRef", "status", "removed_at" AS "removedAt",
           "selector_id" AS "selectorId", "selector_behavior_version" AS "selectorBehaviorVersion",
           "routing_revision" AS "routingRevision"
    FROM "access_points" WHERE "id" = ANY(${command.accessPointChainIds}::text[])
    ORDER BY "id" FOR SHARE
  `);
  const accessPointById = new Map(accessPoints.map((row) => [row.id, row]));
  const expectedRevisionById = new Map(command.routingRevisions.map((row) => [row.accessPointId, row.routingRevision]));
  if (accessPoints.length !== command.accessPointChainIds.length) {
    throw new RelayError("access_configuration_changed", "CPA basic AccessPoint path is incomplete", 409);
  }
  for (const accessPointId of command.accessPointChainIds) {
    const accessPoint = accessPointById.get(accessPointId);
    if (!accessPoint || accessPoint.status !== "enabled" || accessPoint.removedAt !== null
      || accessPoint.routingRevision !== expectedRevisionById.get(accessPointId)) {
      throw new RelayError("access_configuration_changed", "CPA basic AccessPoint path changed before admission", 409);
    }
  }
  const selector = accessPointById.get(command.selectorAccessPointId);
  if (!selector || selector.selectorId !== command.selectorId
    || selector.selectorBehaviorVersion !== command.selectorBehaviorVersion
    || selector.routingRevision !== command.routingRevision) {
    throw new RelayError("access_configuration_changed", "CPA basic selector changed before admission", 409);
  }

  const edges = await transaction.$queryRaw<Array<{
    id: string;
    accessPointId: string;
    targetType: string;
    targetAccessPointId: string | null;
    targetProviderId: string | null;
    targetProviderModelName: string | null;
    targetProviderModelId: string | null;
    status: string;
    removedAt: string | null;
  }>>(Prisma.sql`
    SELECT "id", "access_point_id" AS "accessPointId", "target_type" AS "targetType",
           "target_access_point_id" AS "targetAccessPointId", "target_provider_id" AS "targetProviderId",
           "target_provider_model_name" AS "targetProviderModelName", "target_provider_model_id" AS "targetProviderModelId",
           "status", "removed_at" AS "removedAt"
    FROM "access_point_targets" WHERE "id" = ANY(${command.pathTargetEdgeIds}::text[])
    ORDER BY "id" FOR SHARE
  `);
  const edgeById = new Map(edges.map((row) => [row.id, row]));
  if (edges.length !== command.pathTargetEdgeIds.length) {
    throw new RelayError("access_configuration_changed", "CPA basic target path is incomplete", 409);
  }
  for (const [index, accessPointId] of command.accessPointChainIds.entries()) {
    const edge = edgeById.get(command.pathTargetEdgeIds[index]!);
    const nextAccessPointId = command.accessPointChainIds[index + 1];
    const expectedTarget = nextAccessPointId === undefined
      ? edge?.targetType === "provider-model"
        && edge.targetProviderModelId === command.providerModelId
        && edge.targetProviderId === command.providerId
        && edge.targetProviderModelName === command.providerModelName
      : edge?.targetType === "access-point" && edge.targetAccessPointId === nextAccessPointId;
    if (!edge || edge.status !== "enabled" || edge.removedAt !== null || edge.accessPointId !== accessPointId || !expectedTarget) {
      throw new RelayError("access_configuration_changed", "CPA basic target path changed before admission", 409);
    }
  }
  const selectorEdge = edgeById.get(command.selectorTargetEdgeId);
  if (!selectorEdge || selectorEdge.accessPointId !== command.selectorAccessPointId) {
    throw new RelayError("access_configuration_changed", "CPA basic selector target changed before admission", 409);
  }

  const providerRows = await transaction.$queryRaw<Array<{
    providerModelId: string;
    providerId: string;
    providerModelName: string;
    modelStatus: string;
    providerStatus: string;
    providerScopeRef: string;
    bindingStatus: string | null;
  }>>(Prisma.sql`
    SELECT model."id" AS "providerModelId", model."provider_id" AS "providerId",
           model."provider_model_name" AS "providerModelName", model."status" AS "modelStatus",
           provider."status" AS "providerStatus", provider."scope_ref" AS "providerScopeRef",
           binding."sync_status" AS "bindingStatus"
    FROM "provider_models" model
    INNER JOIN "providers" provider ON provider."id" = model."provider_id"
    INNER JOIN "provider_bindings" binding ON binding."provider_id" = provider."id"
    WHERE model."id" = ${command.providerModelId}
    FOR SHARE OF model, provider, binding
  `);
  const provider = providerRows[0];
  if (!provider || provider.providerId !== command.providerId || provider.providerModelName !== command.providerModelName
    || provider.modelStatus !== "enabled" || provider.providerStatus !== "enabled" || provider.bindingStatus !== "ready") {
    throw new RelayError("access_configuration_changed", "CPA basic Provider target changed before admission", 409);
  }

  const accessPointPrices = await transaction.$queryRaw<Array<{ id: string; accessPointId: string; status: string }>>(Prisma.sql`
    SELECT "id", "access_point_id" AS "accessPointId", "status"
    FROM "access_point_prices" WHERE "id" = ANY(${command.accessPointPriceIds}::text[])
    ORDER BY "id" FOR SHARE
  `);
  const accessPointPriceById = new Map(accessPointPrices.map((row) => [row.id, row]));
  for (const [index, priceId] of command.accessPointPriceIds.entries()) {
    const price = accessPointPriceById.get(priceId);
    if (!price || price.status !== "enabled" || price.accessPointId !== command.accessPointChainIds[index]) {
      throw new RelayError("access_configuration_changed", "CPA basic AccessPoint price path changed before admission", 409);
    }
  }
  if (command.billablePriceSource === "access_point") {
    const price = accessPointPriceById.get(command.billablePriceId);
    if (!price || price.status !== "enabled" || price.accessPointId !== entryAccessPointId) {
      throw new RelayError("billable_price_changed", "CPA basic billable AccessPoint price changed before admission", 409);
    }
  } else {
    const prices = await transaction.$queryRaw<Array<{ planId: string; accessPointId: string; status: string }>>(Prisma.sql`
      SELECT "plan_id" AS "planId", "access_point_id" AS "accessPointId", "status"
      FROM "plan_access_point_prices" WHERE "id" = ${command.billablePriceId} FOR SHARE
    `);
    const price = prices[0];
    if (!price || price.planId !== command.planId || price.accessPointId !== entryAccessPointId || price.status !== "enabled") {
      throw new RelayError("billable_price_changed", "CPA basic Plan AccessPoint price changed before admission", 409);
    }
  }
  const providerCosts = await transaction.$queryRaw<Array<{ providerId: string; providerModelName: string; status: string }>>(Prisma.sql`
    SELECT "provider_id" AS "providerId", "provider_model_name" AS "providerModelName", "status"
    FROM "provider_model_costs" WHERE "id" = ${command.providerModelCostId} FOR SHARE
  `);
  const providerCost = providerCosts[0];
  if (!providerCost || providerCost.providerId !== command.providerId
    || providerCost.providerModelName !== command.providerModelName || providerCost.status !== "enabled") {
    throw new RelayError("access_configuration_changed", "CPA basic Provider cost changed before admission", 409);
  }
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "access_point_price_tiers"
      WHERE "access_point_price_id" = ANY(${command.accessPointPriceIds}::text[]) FOR SHARE
  `);
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "provider_model_cost_tiers"
    WHERE "provider_model_cost_id" = ${command.providerModelCostId} FOR SHARE
  `);
  if (command.billablePriceSource === "plan_access_point") {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "plan_access_point_price_tiers"
      WHERE "plan_access_point_price_id" = ${command.billablePriceId} FOR SHARE
    `);
  }

  const priceContexts = command.accessPointChainIds.map((accessPointId, index) => ({
    accessPointId,
    targetAccessPointId: edgeById.get(command.pathTargetEdgeIds[index]!)!.targetAccessPointId,
    buyerScopeRef: index === 0 ? source.scopeRef : accessPointById.get(command.accessPointChainIds[index - 1]!)!.scopeRef,
    sellerScopeRef: accessPointById.get(accessPointId)!.scopeRef,
    priceId: command.accessPointPriceIds[index]!,
  }));
  const frozen = await participants.billing.claimlessPreparation.execute({
    planId: command.planId,
    providerId: command.providerId,
    providerModelName: command.providerModelName,
    providerModelCostId: command.providerModelCostId,
    billablePriceSource: command.billablePriceSource,
    billablePriceId: command.billablePriceId,
    providerOwnerScopeRef: provider.providerScopeRef,
    accessPointPriceContexts: priceContexts,
  });
  const material: ProviderAttemptPersistenceMaterial = Object.freeze({
    ...(command.providerAttemptId ? { providerAttemptRef: command.providerAttemptId } : {}),
    invocationContract: "cpa-basic@1",
    planSubscriptionId: command.planSubscriptionId,
    apiKeyId: command.apiKeyId,
    userId: command.userId,
    usageChargeAccountId: command.usageChargeAccountId,
    requireServiceTier: command.requireServiceTier,
    billablePriceProfileJson: frozen.billablePriceProfileJson,
    providerCostProfileJson: frozen.providerCostProfileJson,
    accessPointPriceProfilesJson: frozen.accessPointPriceProfilesJson,
    billablePriceSource: command.billablePriceSource,
    billablePriceId: command.billablePriceId,
    billablePriceTierKey: null,
    billablePriceSnapshotJson: null,
    inputTokens: null,
    maxOutputTokens: null,
    tokenizerId: null,
    tokenizerVersion: null,
    preparationEvidenceId: null,
    preparationEvidenceVersion: null,
    preparedPayloadId: null,
    requestedServiceTier: command.requestedServiceTier,
    billingScopeRef: source.scopeRef,
    planSellerScopeRef: source.planScopeRef,
    planBillingMode: source.billingMode,
    subscriptionEffectiveStart: source.effectiveStart,
    providerOwnerScopeRef: provider.providerScopeRef,
    providerModelCostId: command.providerModelCostId,
    providerCostTierKey: null,
    providerCostSnapshotJson: null,
    accessPointPriceSnapshotsJson: null,
  });
  let attempt: ProviderAttemptIdentitySnapshot;
  if (firstAdmissionCommand) {
    const inspection = await firstAdmission.inspectNew(firstAdmissionCommand, now, null);
    if (inspection.kind !== "first") throw new RelayError("provider_attempt_idempotency_conflict", "CPA basic first admission changed during its serialized transaction", 409);
    attempt = await firstAdmission.execute(firstAdmissionCommand, inspection, now, material);
  } else {
    const inspection = await fallbackAdmission.inspectNew(fallbackAdmissionCommand!, now, null);
    if (inspection.kind !== "fallback") throw new RelayError("provider_attempt_idempotency_conflict", "CPA basic fallback admission changed during its serialized transaction", 409);
    attempt = await fallbackAdmission.execute(fallbackAdmissionCommand!, inspection, now, material);
  }
  return { providerAttemptId: attempt.providerAttemptRef, startedAt: attempt.startedAt, replayed: false };
}

async function assertCpaBasicSourceAuthorization(
  transaction: Prisma.TransactionClient,
  scopeRef: string,
  userId: string,
  at: string,
): Promise<void> {
  if (scopeRef === "global:") return;
  if (scopeRef.startsWith("user:")) {
    if (scopeRef === `user:${userId}`) return;
    throw new RelayError("plan_subscription_unavailable", "CPA basic user Plan source is no longer authorized", 402);
  }
  if (!scopeRef.startsWith("team:") || scopeRef.length === "team:".length) {
    throw new RelayError("plan_subscription_unavailable", "CPA basic Plan source scope is invalid", 402);
  }

  const teamId = scopeRef.slice("team:".length);
  const teams = await transaction.$queryRaw<Array<{ ownerId: string; status: string }>>(Prisma.sql`
    SELECT "owner_id" AS "ownerId", "status"
    FROM "teams" WHERE "id" = ${teamId} FOR SHARE
  `);
  const team = teams[0];
  if (!team || team.status !== "enabled") {
    throw new RelayError("plan_subscription_unavailable", "CPA basic Team Plan source is unavailable", 402);
  }
  const activeDeletions = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "team_deletion_lifecycles"
    WHERE "team_id" = ${teamId} AND "cancelled_at" IS NULL AND "purged_at" IS NULL
    FOR SHARE
  `);
  if (activeDeletions[0]) {
    throw new RelayError("plan_subscription_unavailable", "CPA basic Team Plan source is unavailable", 402);
  }
  const memberships = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "team_memberships"
    WHERE "team_id" = ${teamId} AND "user_id" = ${userId}
    FOR SHARE
  `);
  if (team.ownerId !== userId && !memberships[0]) {
    throw new RelayError("plan_subscription_unavailable", "CPA basic Team Plan source is no longer authorized", 402);
  }

  const partnerEntitlements = await transaction.$queryRaw<Array<{
    lifecycle: string;
    effectiveStart: string;
    effectiveEnd: string;
    partnerPlanId: string;
    supportPlanId: string;
    supportScopeRef: string;
    supportLifecycle: string;
    supportEffectiveStart: string;
    supportEffectiveEnd: string | null;
  }>>(Prisma.sql`
    SELECT entitlement."lifecycle", entitlement."effective_start" AS "effectiveStart",
           entitlement."effective_end" AS "effectiveEnd", entitlement."partner_plan_id" AS "partnerPlanId",
           support."plan_id" AS "supportPlanId", support."scope_ref" AS "supportScopeRef",
           support."subscription_lifecycle" AS "supportLifecycle",
           support."effective_start" AS "supportEffectiveStart", support."effective_end" AS "supportEffectiveEnd"
    FROM "partner_operating_entitlements" entitlement
    INNER JOIN "plan_subscriptions" support ON support."id" = entitlement."plan_subscription_id"
    WHERE entitlement."partner_team_id" = ${teamId}
    ORDER BY entitlement."effective_end" DESC, entitlement."created_at" DESC
    FOR SHARE OF entitlement, support
  `);
  if (partnerEntitlements.length === 0) return;
  const activePartnerEntitlement = partnerEntitlements.some((entitlement) => entitlement.lifecycle === "active"
    && entitlement.effectiveStart <= at && entitlement.effectiveEnd > at
    && entitlement.supportPlanId === entitlement.partnerPlanId
    && entitlement.supportScopeRef === scopeRef
    && entitlement.supportLifecycle === "active"
    && entitlement.supportEffectiveStart <= at
    && (entitlement.supportEffectiveEnd === null || entitlement.supportEffectiveEnd > at));
  if (!activePartnerEntitlement) {
    throw new RelayError("partner_subscription_expired", "This Partner service has expired. Use the main platform service or ask the Partner to renew.", 402);
  }
}

interface CpaBasicAttemptIdentityRow {
  id: string;
  requestId: string;
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
  planSubscriptionId: string | null;
  apiKeyId: string | null;
  userId: string | null;
  usageChargeAccountId: string | null;
  requestedServiceTier: string;
  requireServiceTier: number;
  billablePriceSource: string;
  billablePriceId: string;
  providerModelCostId: string;
  accessPointPriceProfilesJson: string | null;
  startedAt: string;
  invocationContract: string;
}

function assertEquivalentCpaBasicAttempt(existing: CpaBasicAttemptIdentityRow, command: AdmitCpaBasicProviderInvocationCommand): void {
  const equivalent = existing.invocationContract === "cpa-basic@1"
    && (command.providerAttemptId === undefined || existing.id === command.providerAttemptId)
    && existing.requestId === command.requestId
    && existing.attemptIndex === command.attemptIndex
    && existing.selectorAccessPointId === command.selectorAccessPointId
    && existing.selectorId === command.selectorId
    && existing.selectorBehaviorVersion === command.selectorBehaviorVersion
    && existing.routingRevision === command.routingRevision
    && existing.routingRevisionsJson === JSON.stringify(command.routingRevisions)
    && existing.candidateId === command.candidateId
    && existing.selectorTargetEdgeId === command.selectorTargetEdgeId
    && existing.pathTargetEdgeIdsJson === JSON.stringify(command.pathTargetEdgeIds)
    && existing.accessPointChainIdsJson === JSON.stringify(command.accessPointChainIds)
    && existing.providerModelId === command.providerModelId
    && existing.providerId === command.providerId
    && existing.providerModelName === command.providerModelName
    && existing.planSubscriptionId === command.planSubscriptionId
    && existing.apiKeyId === command.apiKeyId
    && existing.userId === command.userId
    && existing.usageChargeAccountId === command.usageChargeAccountId
    && existing.requestedServiceTier === command.requestedServiceTier
    && Boolean(existing.requireServiceTier) === command.requireServiceTier
    && existing.billablePriceSource === command.billablePriceSource
    && existing.billablePriceId === command.billablePriceId
    && existing.providerModelCostId === command.providerModelCostId
    && frozenClaimlessAccessPointPriceIds(existing.accessPointPriceProfilesJson).join("\u0000") === command.accessPointPriceIds.join("\u0000");
  if (!equivalent) throw new RelayError("provider_attempt_idempotency_conflict", "Existing CPA basic ProviderAttempt does not match the admission command", 409);
}

function frozenClaimlessAccessPointPriceIds(json: string | null): string[] {
  let value: unknown;
  try { value = json === null ? null : JSON.parse(json) as unknown; } catch {
    throw new RelayError("provider_attempt_snapshot_invalid", "CPA basic AccessPoint price profile snapshot is invalid", 500);
  }
  if (!Array.isArray(value)) throw new RelayError("provider_attempt_snapshot_invalid", "CPA basic AccessPoint price profile snapshot is invalid", 500);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof (item as Record<string, unknown>).priceId !== "string") {
      throw new RelayError("provider_attempt_snapshot_invalid", "CPA basic AccessPoint price identity is invalid", 500);
    }
    return (item as { priceId: string }).priceId;
  });
}

function assertCpaBasicAdmissionShape(command: AdmitCpaBasicProviderInvocationCommand): void {
  if (typeof command.executionOwnerId !== "string" || command.executionOwnerId.length === 0
    || !Number.isSafeInteger(command.attemptIndex) || command.attemptIndex < 0
    || !Number.isSafeInteger(command.selectorBehaviorVersion) || command.selectorBehaviorVersion < 1
    || !Number.isSafeInteger(command.routingRevision) || command.routingRevision < 1
    || command.accessPointChainIds.length < 1
    || command.accessPointChainIds.length !== command.pathTargetEdgeIds.length
    || command.accessPointChainIds.length !== command.routingRevisions.length
    || command.accessPointChainIds.length !== command.accessPointPriceIds.length
    || new Set(command.accessPointChainIds).size !== command.accessPointChainIds.length
    || new Set(command.pathTargetEdgeIds).size !== command.pathTargetEdgeIds.length
    || new Set(command.routingRevisions.map((item) => item.accessPointId)).size !== command.routingRevisions.length
    || command.routingRevisions.some((item) => !Number.isSafeInteger(item.routingRevision) || item.routingRevision < 1)
    || !command.accessPointChainIds.includes(command.selectorAccessPointId)
    || !command.pathTargetEdgeIds.includes(command.selectorTargetEdgeId)) {
    throw new RelayError("invalid_provider_attempt", "CPA basic ProviderAttempt admission shape is invalid", 400);
  }
}

async function admitProviderInvocation(
  transaction: Prisma.TransactionClient,
  command: AdmitProviderInvocationCommand,
  billing: BoundInvocationAdmissionParticipant,
  first: BoundRequestExecutionParticipants["firstAdmission"],
  fallback: BoundRequestExecutionParticipants["fallbackAdmission"],
): Promise<ProviderInvocationAdmission> {
  assertAdmissionNumbers(command);
  await transaction.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`friday-relay:protected:${command.requestId}:${command.candidateId}`}, 0))
  `);
  const identity = requestExecutionAdmissionIdentity(command);
  const firstCommand: AdmitFirstProviderInvocationCommand | null = command.attemptIndex === 0
    ? { ...identity, attemptIndex: 0, selectedSourceRef: command.planSubscriptionId }
    : null;
  const fallbackCommand: AdmitFallbackProviderInvocationCommand | null = command.attemptIndex > 0 ? identity : null;
  const replay = firstCommand
    ? await first.findReplay(firstCommand)
    : await fallback.findReplay(fallbackCommand!);
  if (replay) return equivalentAdmission(transaction, replay, command, billing);

  const now = await providerInvocationDatabaseNow(transaction);
  const account = await billing.lockAdmissionFunding({ userId: command.userId, usageChargeAccountId: command.usageChargeAccountId });
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('friday-relay:model-access-routing-graph', 0))`;
  const request = await transaction.request_logs.findUnique({ where: { id: command.requestId }, select: { api_key_id: true, user_id: true } });
  if (!request || request.api_key_id !== command.apiKeyId || request.user_id !== command.userId) {
    throw new RelayError("request_execution_not_found", "Request execution input is not authoritative", 409);
  }
  const inspection = firstCommand
    ? await first.inspectNew(firstCommand, now, null)
    : await fallback.inspectNew(fallbackCommand!, now, null);
  if (inspection.kind === "replay") return equivalentAdmission(transaction, inspection, command, billing);
  if (inspection.selectedSourceRef !== command.planSubscriptionId) {
    throw new RelayError("request_execution_plan_source_conflict", "A RequestExecution cannot change its admitted Plan source", 409);
  }

  const subscriptionRows = await transaction.$queryRaw<Array<{
    planId: string;
    subscriptionLifecycle: string;
    effectiveStart: string;
    effectiveEnd: string | null;
    scopeRef: string;
    planStatus: string;
    planScopeRef: string;
    planBillingMode: string;
  }>>(Prisma.sql`
    SELECT subscription."plan_id" AS "planId", subscription."subscription_lifecycle" AS "subscriptionLifecycle",
           subscription."effective_start" AS "effectiveStart", subscription."effective_end" AS "effectiveEnd",
           subscription."scope_ref" AS "scopeRef", plan."plan_status" AS "planStatus",
           plan."scope_ref" AS "planScopeRef", plan."billing_mode" AS "planBillingMode"
    FROM "plan_subscriptions" subscription
    INNER JOIN "plans" plan ON plan."id" = subscription."plan_id"
    WHERE subscription."id" = ${command.planSubscriptionId}
    FOR UPDATE OF subscription, plan
  `);
  const subscription = subscriptionRows[0];
  if (!subscription || subscription.planId !== command.planId || subscription.subscriptionLifecycle !== "active"
    || (subscription.planStatus !== "enabled" && subscription.planStatus !== "closed")
    || subscription.effectiveStart > now || (subscription.effectiveEnd !== null && subscription.effectiveEnd <= now)) {
    throw new RelayError("plan_subscription_unavailable", "Plan Subscription changed before Provider invocation admission", 402);
  }
  const frozenRouting = await assertFrozenRoutingPath(transaction, command);
  const billingReferences = loadInvocationBillingReferenceDecision(frozenRouting, command, subscription.scopeRef);
  const billingTerms = await billing.prepareFinancialTerms({
    planId: command.planId, providerId: command.providerId, providerModelName: command.providerModelName,
    providerModelCostId: command.providerModelCostId,
    billablePriceSource: command.billablePriceSource, billablePriceId: command.billablePriceId,
    inputTokens: command.inputTokens, serviceTier: command.serviceTier,
    providerOwnerScopeRef: billingReferences.providerOwnerScopeRef,
    accessPointPriceContexts: billingReferences.accessPointPriceContexts,
  });
  const price = billingTerms.price;
  const maximumChargeUnits = maximumInvocationChargeUnits(command.inputTokens, command.maxOutputTokens, price.units);
  const maximumTokens = command.inputTokens + command.maxOutputTokens;
  if (maximumTokens > BILLING_MAX_INT64 || maximumChargeUnits > BILLING_MAX_INT64) {
    throw new RelayError("invalid_provider_attempt", "ProviderAttempt Billing claims exceed signed 64-bit storage", 400);
  }
  const budgetInput = {
    planId: command.planId, planSubscriptionId: command.planSubscriptionId,
    apiKeyId: command.apiKeyId, userId: command.userId,
    subscriptionEffectiveStart: subscription.effectiveStart, subscriptionEffectiveEnd: subscription.effectiveEnd,
    maximumTokens, maximumChargeUnits, occurredAt: now,
  };
  await billing.assertPlanBudgets(budgetInput);
  const apiKeyLock = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "api_keys" WHERE "id" = ${command.apiKeyId} FOR UPDATE
  `;
  if (!apiKeyLock[0]) throw new RelayError("request_execution_not_found", "API Key changed before Provider invocation admission", 409);
  await billing.assertDirectBudgets(budgetInput);
  if (command.usageChargeAccountId) await billing.assertCapacity({ account: account!, userId: command.userId, requiredUnits: maximumChargeUnits, now });

  const material: ProviderAttemptPersistenceMaterial = Object.freeze({
    invocationContract: "protected@1",
    planSubscriptionId: null,
    apiKeyId: null,
    userId: null,
    usageChargeAccountId: null,
    requireServiceTier: false,
    billablePriceProfileJson: null,
    providerCostProfileJson: null,
    accessPointPriceProfilesJson: null,
    billablePriceSource: command.billablePriceSource,
    billablePriceId: command.billablePriceId,
    billablePriceTierKey: price.tierKey,
    billablePriceSnapshotJson: price.snapshotJson,
    inputTokens: command.inputTokens,
    maxOutputTokens: command.maxOutputTokens,
    tokenizerId: command.tokenizerId,
    tokenizerVersion: command.tokenizerVersion,
    preparationEvidenceId: command.preparationEvidenceId,
    preparationEvidenceVersion: command.preparationEvidenceVersion,
    preparedPayloadId: command.preparedPayloadId,
    requestedServiceTier: command.serviceTier,
    billingScopeRef: subscription.scopeRef,
    planSellerScopeRef: subscription.planScopeRef,
    planBillingMode: subscription.planBillingMode,
    subscriptionEffectiveStart: subscription.effectiveStart,
    providerOwnerScopeRef: billingTerms.providerOwnerScopeRef,
    providerModelCostId: command.providerModelCostId,
    providerCostTierKey: billingTerms.providerCost.tierKey,
    providerCostSnapshotJson: billingTerms.providerCost.snapshotJson,
    accessPointPriceSnapshotsJson: JSON.stringify(billingTerms.accessPointPrices),
  });
  const attempt = inspection.kind === "first"
    ? await first.execute(firstCommand!, inspection, now, material)
    : await fallback.execute(fallbackCommand!, inspection, now, material);
  const { usageReservationId } = await billing.execute({
    billableInvocationRef: attempt.providerAttemptRef, requestId: command.requestId, planId: command.planId,
    planSubscriptionId: command.planSubscriptionId, apiKeyId: command.apiKeyId, userId: command.userId,
    maximumTokens, maximumChargeUnits, usageChargeAccountId: command.usageChargeAccountId,
    inputTokens: command.inputTokens, maxOutputTokens: command.maxOutputTokens,
    tokenizerId: command.tokenizerId, tokenizerVersion: command.tokenizerVersion,
    preparationEvidenceId: command.preparationEvidenceId, preparationEvidenceVersion: command.preparationEvidenceVersion,
    preparedPayloadId: command.preparedPayloadId, serviceTier: price.serviceTier,
    billablePriceSource: command.billablePriceSource, billablePriceId: command.billablePriceId,
    billablePriceTierKey: price.tierKey, priceSnapshotJson: price.snapshotJson, createdAt: attempt.startedAt,
  });
  return {
    providerAttemptId: attempt.providerAttemptRef,
    budgetClaimMaxTokens: maximumTokens,
    budgetClaimMaxChargeUnits: maximumChargeUnits,
    usageReservationId,
    reservationUnits: usageReservationId ? maximumChargeUnits : null,
    startedAt: attempt.startedAt,
  };
}

async function equivalentAdmission(
  transaction: Prisma.TransactionClient,
  replay: Extract<ProviderInvocationAdmissionDecision, { kind: "replay" }>,
  command: AdmitProviderInvocationCommand,
  billing: BoundInvocationAdmissionParticipant,
): Promise<ProviderInvocationAdmission> {
  if (replay.selectedSourceRef !== command.planSubscriptionId) {
    throw new RelayError("request_execution_plan_source_conflict", "A RequestExecution cannot change its admitted Plan source", 409);
  }
  const physical = await readProviderAttemptCompatibility(transaction, replay.attempt.providerAttemptRef);
  const physicalMatches = physical.billablePriceSource === command.billablePriceSource
    && physical.billablePriceId === command.billablePriceId
    && physical.providerModelCostId === command.providerModelCostId
    && frozenAccessPointPriceIds(physical.accessPointPriceSnapshotsJson).join("\u0000") === command.accessPointPriceIds.join("\u0000")
    && physical.inputTokens === command.inputTokens
    && physical.maxOutputTokens === command.maxOutputTokens
    && physical.tokenizerId === command.tokenizerId
    && physical.tokenizerVersion === command.tokenizerVersion
    && physical.preparationEvidenceId === command.preparationEvidenceId
    && physical.preparationEvidenceVersion === command.preparationEvidenceVersion
    && physical.preparedPayloadId === command.preparedPayloadId
    && physical.requestedServiceTier === command.serviceTier;
  if (!physicalMatches) throw new RelayError("provider_attempt_idempotency_conflict", "Existing ProviderAttempt does not match the admission command", 409);
  const { claim, reservation } = await billing.readOccupation(replay.attempt.providerAttemptRef);
  if (!claim) throw new RelayError("provider_attempt_admission_incomplete", "Existing ProviderAttempt has no BudgetClaim", 409);
  const price = parseFrozenPriceUnits(physical.billablePriceSnapshotJson);
  const maximumTokens = command.inputTokens + command.maxOutputTokens;
  const maximumChargeUnits = maximumInvocationChargeUnits(command.inputTokens, command.maxOutputTokens, price);
  const referencesMatch = claim.requestId === command.requestId
    && claim.planId === command.planId
    && claim.planSubscriptionId === command.planSubscriptionId
    && claim.apiKeyId === command.apiKeyId
    && claim.userId === command.userId
    && claim.maximumTokens === maximumTokens
    && claim.maximumChargeUnits === maximumChargeUnits;
  const reservationMatches = command.usageChargeAccountId === null
    ? reservation === null
    : reservation?.creditAccountId === command.usageChargeAccountId
      && reservation.planSubscriptionId === command.planSubscriptionId
      && reservation.userId === command.userId
      && reservation.inputTokens === command.inputTokens
      && reservation.maxOutputTokens === command.maxOutputTokens
      && reservation.tokenizerId === command.tokenizerId
      && reservation.tokenizerVersion === command.tokenizerVersion
      && reservation.preparationEvidenceId === command.preparationEvidenceId
      && reservation.preparationEvidenceVersion === command.preparationEvidenceVersion
      && reservation.preparedPayloadId === command.preparedPayloadId
      && reservation.billablePriceSource === command.billablePriceSource
      && reservation.billablePriceId === command.billablePriceId
      && reservation.reservationUnits === maximumChargeUnits;
  if (!referencesMatch || !reservationMatches) throw new RelayError("provider_attempt_idempotency_conflict", "Existing ProviderAttempt admission facts do not match the command", 409);
  return {
    providerAttemptId: replay.attempt.providerAttemptRef,
    budgetClaimMaxTokens: claim.maximumTokens,
    budgetClaimMaxChargeUnits: claim.maximumChargeUnits,
    usageReservationId: reservation?.id ?? null,
    reservationUnits: reservation?.reservationUnits ?? null,
    startedAt: replay.attempt.startedAt,
  };
}

async function assertDispatchOwnership(
  transaction: Prisma.TransactionClient,
  providerAttemptId: string,
  requestId: string,
  executionOwnerId: string,
  billing: BoundInvocationReconciliationParticipant,
  requestExecution: BoundRequestExecutionParticipants["dispatch"],
): Promise<boolean> {
  await billing.lockFunding(providerAttemptId);
  const decision = await requestExecution.execute(providerAttemptId, requestId, executionOwnerId, nowIso());
  if (decision.transitionToReconciliation) await billing.execute({
    billableInvocationRef: providerAttemptId, costExposure: "accruing", transitionedAt: decision.transitionedAt,
  });
  return decision.owned;
}

async function settleFinalUsage(
  transaction: Prisma.TransactionClient,
  command: SettleProviderInvocationCommand,
  zeroReservationOutcome: "settled" | "released" = "settled",
  billing: BoundInvocationSettlementParticipant,
  lockedAccount: InvocationFundingLock | null | undefined,
  requestExecution: BoundRequestExecutionParticipants["finalization"],
  requireReconciliation = false,
  expectedInvocationContract?: "protected@1" | "cpa-basic@1",
): Promise<{ actualChargeUnits: bigint; postingLedgerEventId: string | null; billingEventId: string }> {
  validateUsage(command.usage);
  const account = lockedAccount === undefined ? await billing.lockFunding(command.providerAttemptId) : lockedAccount;
  const requestExecutionCommand: FinalizeProviderInvocationCommand = {
    providerAttemptRef: command.providerAttemptId,
    outcome: command.outcome,
    trustedUsageSource: command.usage.source,
    ...(command.failureClass !== undefined ? { failureClass: command.failureClass } : {}),
    ...(command.failureReason !== undefined ? { failureReason: command.failureReason } : {}),
    ...(command.outputCommitted !== undefined ? { outputCommitted: command.outputCommitted } : {}),
    ...(command.requestTerminalStatus !== undefined ? { requestTerminalStatus: command.requestTerminalStatus } : {}),
    ...(command.requestTerminalErrorCode !== undefined ? { requestTerminalErrorCode: command.requestTerminalErrorCode } : {}),
  };
  const decision = await requestExecution.lock(requestExecutionCommand, requireReconciliation);
  if (expectedInvocationContract && decision.invocationContract !== expectedInvocationContract) {
    throw new RelayError("provider_attempt_contract_mismatch", "ProviderAttempt does not match the settlement command contract", 409);
  }
  const attempt = await readInvocationBillingAttemptSnapshot(transaction, decision.providerAttemptRef, decision.startedAt);
  const now = nowIso();
  const settled = await billing.execute({
    billableInvocationRef: command.providerAttemptId,
    usage: command.usage,
    zeroReservationOutcome,
    account,
    settledAt: now,
    attempt,
  });
  await requestExecution.complete(decision, requestExecutionCommand, now);
  return settled;
}

async function enterReconciliation(
  transaction: Prisma.TransactionClient,
  command: ReconcileProviderInvocationCommand,
  billing: BoundInvocationReconciliationParticipant,
  requestExecution: BoundRequestExecutionParticipants["reconciliation"],
): Promise<void> {
  await billing.lockFunding(command.providerAttemptId);
  const requestExecutionCommand: RequestExecutionReconciliationCommand = {
    providerAttemptRef: command.providerAttemptId,
    outcome: command.outcome,
    costExposure: command.costExposure,
    reason: command.reason,
    ...(command.failureClass !== undefined ? { failureClass: command.failureClass } : {}),
    ...(command.failureReason !== undefined ? { failureReason: command.failureReason } : {}),
    ...(command.outputCommitted !== undefined ? { outputCommitted: command.outputCommitted } : {}),
  };
  const decision = await requestExecution.execute(requestExecutionCommand, nowIso());
  if (decision.transitionToReconciliation) await billing.execute({
    billableInvocationRef: command.providerAttemptId,
    costExposure: command.costExposure,
    transitionedAt: decision.transitionedAt,
  });
}

async function failRequestExecution(
  requestId: string,
  executionOwnerId: string,
  errorCode: string,
  requestExecution: BoundRequestExecutionParticipants["failure"],
): Promise<void> {
  await requestExecution.execute(requestId, executionOwnerId, errorCode, nowIso());
}

function cpaBasicRequestExecutionAdmissionIdentity(command: AdmitCpaBasicProviderInvocationCommand): ProviderAttemptAdmissionIdentity {
  return requestExecutionAdmissionIdentity({
    ...command,
    routingRevisions: [...command.routingRevisions],
    pathTargetEdgeIds: [...command.pathTargetEdgeIds],
    accessPointChainIds: [...command.accessPointChainIds],
  });
}

function requestExecutionAdmissionIdentity(command: Pick<AdmitProviderInvocationCommand,
  "requestId" | "executionOwnerId" | "attemptIndex" | "candidateId" | "providerModelId" | "providerId" |
  "providerModelName" | "selectorAccessPointId" | "selectorId" | "selectorBehaviorVersion" | "routingRevision" |
  "routingRevisions" | "selectorTargetEdgeId" | "pathTargetEdgeIds" | "accessPointChainIds"
>): ProviderAttemptAdmissionIdentity {
  return {
    requestId: command.requestId,
    executionOwnerId: command.executionOwnerId,
    attemptIndex: command.attemptIndex,
    candidate: {
      candidateId: command.candidateId,
      providerModelId: command.providerModelId,
      providerId: command.providerId,
      providerModelName: command.providerModelName,
    },
    routing: {
      selectorAccessPointId: command.selectorAccessPointId,
      selectorId: command.selectorId,
      selectorBehaviorVersion: command.selectorBehaviorVersion,
      routingRevision: command.routingRevision,
      routingRevisions: command.routingRevisions,
      selectorTargetEdgeId: command.selectorTargetEdgeId,
      pathTargetEdgeIds: command.pathTargetEdgeIds,
      accessPointChainIds: command.accessPointChainIds,
    },
  };
}

async function readProviderAttemptCompatibility(transaction: Prisma.TransactionClient, providerAttemptId: string): Promise<{
  billablePriceSource: string;
  billablePriceId: string;
  billablePriceSnapshotJson: string;
  providerModelCostId: string;
  accessPointPriceSnapshotsJson: string;
  inputTokens: bigint;
  maxOutputTokens: bigint;
  tokenizerId: string;
  tokenizerVersion: number;
  preparationEvidenceId: string;
  preparationEvidenceVersion: number;
  preparedPayloadId: string;
  requestedServiceTier: string;
}> {
  const row = await transaction.request_provider_attempts.findUniqueOrThrow({ where: { id: providerAttemptId } });
  if (row.invocation_contract !== "protected@1"
    || row.billable_price_snapshot_json === null
    || row.access_point_price_snapshots_json === null
    || row.input_tokens === null
    || row.max_output_tokens === null
    || row.tokenizer_id === null
    || row.tokenizer_version === null
    || row.preparation_evidence_id === null
    || row.preparation_evidence_version === null
    || row.prepared_payload_id === null) {
    throw new RelayError("provider_attempt_contract_mismatch", "Provider Attempt is not a protected invocation", 409);
  }
  return {
    billablePriceSource: row.billable_price_source,
    billablePriceId: row.billable_price_id,
    billablePriceSnapshotJson: row.billable_price_snapshot_json,
    providerModelCostId: row.provider_model_cost_id,
    accessPointPriceSnapshotsJson: row.access_point_price_snapshots_json,
    inputTokens: row.input_tokens,
    maxOutputTokens: row.max_output_tokens,
    tokenizerId: row.tokenizer_id,
    tokenizerVersion: row.tokenizer_version,
    preparationEvidenceId: row.preparation_evidence_id,
    preparationEvidenceVersion: row.preparation_evidence_version,
    preparedPayloadId: row.prepared_payload_id,
    requestedServiceTier: row.requested_service_tier,
  };
}

async function providerInvocationDatabaseNow(transaction: Prisma.TransactionClient): Promise<string> {
  const rows = await transaction.$queryRaw<Array<{ currentTime: string }>>`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "currentTime"
  `;
  const currentTime = rows[0]?.currentTime;
  if (!currentTime || !Number.isFinite(Date.parse(currentTime))) {
    throw new RelayError("database_time_unavailable", "PostgreSQL current time is unavailable", 503);
  }
  return currentTime;
}

async function readInvocationBillingAttemptSnapshot(transaction: Prisma.TransactionClient, providerAttemptId: string, startedAt: string) {
  const row = await transaction.request_provider_attempts.findUniqueOrThrow({ where: { id: providerAttemptId } });
  const common = {
    billableInvocationRef: row.id,
    requestId: row.request_id,
    startedAt,
    billingScopeRef: row.billing_scope_ref,
    planSellerScopeRef: row.plan_seller_scope_ref,
    planBillingMode: row.plan_billing_mode,
    subscriptionEffectiveStart: row.subscription_effective_start,
    providerOwnerScopeRef: row.provider_owner_scope_ref,
    providerId: row.provider_id,
    providerModelName: row.provider_model_name,
    providerModelCostId: row.provider_model_cost_id,
    billablePriceId: row.billable_price_id,
    billablePriceSource: row.billable_price_source,
  };
  if (row.invocation_contract === "protected@1") {
    if (row.provider_cost_tier_key === null
      || row.provider_cost_snapshot_json === null
      || row.billable_price_tier_key === null
      || row.billable_price_snapshot_json === null
      || row.access_point_price_snapshots_json === null) {
      throw new RelayError("provider_attempt_contract_mismatch", "Protected ProviderAttempt has incomplete Billing snapshots", 409);
    }
    return {
      ...common,
      invocationContract: "protected@1" as const,
      preparationEvidenceId: row.preparation_evidence_id,
      preparationEvidenceVersion: row.preparation_evidence_version,
      preparedPayloadId: row.prepared_payload_id,
      providerCostTierKey: row.provider_cost_tier_key,
      providerCostSnapshotJson: row.provider_cost_snapshot_json,
      billablePriceTierKey: row.billable_price_tier_key,
      billablePriceSnapshotJson: row.billable_price_snapshot_json,
      accessPointPriceSnapshotsJson: row.access_point_price_snapshots_json,
    };
  }
  if (row.invocation_contract === "cpa-basic@1") {
    if (row.plan_subscription_id === null || row.api_key_id === null || row.user_id === null
      || row.billable_price_profile_json === null || row.provider_cost_profile_json === null
      || row.access_point_price_profiles_json === null) {
      throw new RelayError("provider_attempt_contract_mismatch", "CPA basic ProviderAttempt has incomplete frozen Billing profiles", 409);
    }
    return {
      ...common,
      invocationContract: "cpa-basic@1" as const,
      planSubscriptionId: row.plan_subscription_id,
      apiKeyId: row.api_key_id,
      userId: row.user_id,
      usageChargeAccountId: row.usage_charge_account_id,
      requestedServiceTier: row.requested_service_tier,
      requireServiceTier: row.require_service_tier === 1,
      billablePriceProfileJson: row.billable_price_profile_json,
      providerCostProfileJson: row.provider_cost_profile_json,
      accessPointPriceProfilesJson: row.access_point_price_profiles_json,
    };
  }
  throw new RelayError("provider_attempt_contract_mismatch", "ProviderAttempt invocation contract is unsupported", 409);
}

interface FrozenRoutingPathFacts {
  accessPointsById: ReadonlyMap<string, { id: string; scopeRef: string; routingRevision: number }>;
  edgesById: ReadonlyMap<string, {
    id: string;
    accessPointId: string;
    targetType: string;
    targetAccessPointId: string | null;
    targetProviderId: string | null;
    targetProviderModelName: string | null;
    targetProviderModelId: string | null;
  }>;
  providerOwnerScopeRef: string;
}

async function assertFrozenRoutingPath(transaction: Prisma.TransactionClient, command: AdmitProviderInvocationCommand): Promise<FrozenRoutingPathFacts> {
  if (command.accessPointChainIds.length === 0
    || command.pathTargetEdgeIds.length !== command.accessPointChainIds.length
    || command.routingRevisions.length !== command.accessPointChainIds.length
    || !command.accessPointChainIds.includes(command.selectorAccessPointId)
    || !command.routingRevisions.some((item) => item.accessPointId === command.selectorAccessPointId)) {
    throw new RelayError("access_configuration_changed", "AccessPoint path shape changed before Provider invocation admission", 409);
  }
  const uniqueAccessPointIds = new Set(command.accessPointChainIds);
  const uniqueEdgeIds = new Set(command.pathTargetEdgeIds);
  if (uniqueAccessPointIds.size !== command.accessPointChainIds.length || uniqueEdgeIds.size !== command.pathTargetEdgeIds.length) {
    throw new RelayError("access_configuration_changed", "AccessPoint path is not a simple frozen path", 409);
  }
  const accessPoints = await transaction.$queryRaw<Array<{ id: string; scopeRef: string; routingRevision: number }>>(Prisma.sql`
    SELECT "id", "scope_ref" AS "scopeRef", "routing_revision" AS "routingRevision"
    FROM "access_points"
    WHERE "id" = ANY(${command.accessPointChainIds}::text[])
      AND "removed_at" IS NULL AND "status" = 'enabled'
    ORDER BY "id" ASC
    FOR SHARE
  `);
  const byAccessPointId = new Map(accessPoints.map((accessPoint) => [accessPoint.id, accessPoint]));
  const revisions = new Map(command.routingRevisions.map((item) => [item.accessPointId, item.routingRevision]));
  const edges = await transaction.$queryRaw<Array<{
    id: string;
    accessPointId: string;
    targetType: string;
    targetAccessPointId: string | null;
    targetProviderId: string | null;
    targetProviderModelName: string | null;
    targetProviderModelId: string | null;
  }>>(Prisma.sql`
    SELECT "id", "access_point_id" AS "accessPointId", "target_type" AS "targetType",
           "target_access_point_id" AS "targetAccessPointId", "target_provider_id" AS "targetProviderId",
           "target_provider_model_name" AS "targetProviderModelName", "target_provider_model_id" AS "targetProviderModelId"
    FROM "access_point_targets"
    WHERE "id" = ANY(${command.pathTargetEdgeIds}::text[])
      AND "removed_at" IS NULL AND "status" = 'enabled'
    ORDER BY "id" ASC
    FOR SHARE
  `);
  const byEdgeId = new Map(edges.map((edge) => [edge.id, edge]));
  for (const [index, accessPointId] of command.accessPointChainIds.entries()) {
    const accessPoint = byAccessPointId.get(accessPointId);
    const edge = byEdgeId.get(command.pathTargetEdgeIds[index]!);
    if (!accessPoint || revisions.get(accessPointId) !== accessPoint.routingRevision || !edge || edge.accessPointId !== accessPointId) {
      throw new RelayError("access_configuration_changed", "AccessPoint path changed before Provider invocation admission", 409);
    }
    const nextAccessPointId = command.accessPointChainIds[index + 1];
    const edgeMatches = nextAccessPointId === undefined
      ? edge.targetType === "provider-model"
        && edge.targetProviderModelId === command.providerModelId
        && edge.targetProviderId === command.providerId
        && edge.targetProviderModelName === command.providerModelName
      : edge.targetType === "access-point" && edge.targetAccessPointId === nextAccessPointId;
    if (!edgeMatches) throw new RelayError("access_configuration_changed", "AccessPoint edge no longer identifies the frozen candidate", 409);
  }
  const selectorEdge = byEdgeId.get(command.selectorTargetEdgeId);
  if (!selectorEdge || selectorEdge.accessPointId !== command.selectorAccessPointId) {
    throw new RelayError("access_configuration_changed", "Selector edge changed before Provider invocation admission", 409);
  }
  const providerRows = await transaction.$queryRaw<Array<{
    providerModelId: string;
    providerId: string;
    providerModelName: string;
    modelStatus: string;
    providerStatus: string;
    providerScopeRef: string;
    bindingStatus: string;
  }>>(Prisma.sql`
    SELECT model."id" AS "providerModelId", model."provider_id" AS "providerId",
           model."provider_model_name" AS "providerModelName", model."status" AS "modelStatus",
           provider."status" AS "providerStatus", provider."scope_ref" AS "providerScopeRef",
           binding."sync_status" AS "bindingStatus"
    FROM "provider_models" model
    INNER JOIN "providers" provider ON provider."id" = model."provider_id"
    INNER JOIN "provider_bindings" binding ON binding."provider_id" = provider."id"
    WHERE model."id" = ${command.providerModelId}
    FOR SHARE OF model, provider, binding
  `);
  const provider = providerRows[0];
  if (!provider || provider.modelStatus !== "enabled"
    || provider.providerId !== command.providerId
    || provider.providerModelName !== command.providerModelName
    || provider.providerStatus !== "enabled" || provider.bindingStatus !== "ready") {
    throw new RelayError("access_configuration_changed", "Provider or Provider binding changed before Provider invocation admission", 409);
  }
  return {
    accessPointsById: byAccessPointId,
    edgesById: byEdgeId,
    providerOwnerScopeRef: provider.providerScopeRef,
  };
}

function loadInvocationBillingReferenceDecision(
  frozenRouting: FrozenRoutingPathFacts,
  command: AdmitProviderInvocationCommand,
  billingScopeRef: string,
): {
  providerOwnerScopeRef: string;
  accessPointPriceContexts: Array<{ accessPointId: string; targetAccessPointId: string | null; buyerScopeRef: string; sellerScopeRef: string; priceId: string }>;
} {
  if (command.accessPointPriceIds.length !== command.accessPointChainIds.length) throw new RelayError("access_configuration_changed", "AccessPoint price chain does not match the admitted path", 409);
  const accessPointPriceContexts: Array<{ accessPointId: string; targetAccessPointId: string | null; buyerScopeRef: string; sellerScopeRef: string; priceId: string }> = [];
  let buyerScopeRef = billingScopeRef;
  for (const [index, accessPointId] of command.accessPointChainIds.entries()) {
    const accessPoint = frozenRouting.accessPointsById.get(accessPointId);
    const edge = frozenRouting.edgesById.get(command.pathTargetEdgeIds[index]!);
    if (!accessPoint || !edge) throw new RelayError("access_configuration_changed", "AccessPoint billing references changed before admission", 409);
    accessPointPriceContexts.push({
      accessPointId,
      targetAccessPointId: edge.targetAccessPointId,
      buyerScopeRef,
      sellerScopeRef: accessPoint.scopeRef,
      priceId: command.accessPointPriceIds[index]!,
    });
    buyerScopeRef = accessPoint.scopeRef;
  }
  return { providerOwnerScopeRef: frozenRouting.providerOwnerScopeRef, accessPointPriceContexts };
}

function assertAdmissionNumbers(command: AdmitProviderInvocationCommand): void {
  if (!Number.isSafeInteger(command.attemptIndex) || command.attemptIndex < 0) throw new RelayError("invalid_provider_attempt", "ProviderAttempt index is invalid", 400);
  if (!Number.isSafeInteger(command.selectorBehaviorVersion) || !Number.isSafeInteger(command.routingRevision)) throw new RelayError("invalid_provider_attempt", "ProviderAttempt revisions are invalid", 400);
  if (command.inputTokens < 0n || command.inputTokens > BILLING_MAX_INT64
    || command.maxOutputTokens < 1n || command.maxOutputTokens > BILLING_MAX_INT64
    || command.inputTokens + command.maxOutputTokens > BILLING_MAX_INT64) {
    throw new RelayError("invalid_provider_attempt", "ProviderAttempt requires a positive enforceable output cap and signed 64-bit token bounds", 400);
  }
  if (!Number.isSafeInteger(command.tokenizerVersion) || command.tokenizerVersion < 1
    || !Number.isSafeInteger(command.preparationEvidenceVersion) || command.preparationEvidenceVersion < 1
    || !boundedPreparationIdentity(command.tokenizerId)
    || !boundedPreparationIdentity(command.preparationEvidenceId)
    || !boundedPreparationIdentity(command.preparedPayloadId)) {
    throw new RelayError("invalid_provider_attempt", "CPA preparation evidence identity, version, payload binding, or tokenizer identity is invalid", 400);
  }
}

function boundedPreparationIdentity(value: string): boolean {
  return value.length >= 1 && value.length <= 256;
}
