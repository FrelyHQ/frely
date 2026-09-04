import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "@frely/core";
import { PostgresProviderRuntimeTargetReader } from "@frely/provider-runtime/server";
import type { RequestExecutionLeasePort } from "@frely/request-execution/server";
import { CompleteRequestExecution, createRequestExecutionLeaseCommands, RequestExecutionLeaseService } from "@frely/request-execution/application-internal";
import { createProviderInvocationVerificationCommands, createProviderInvocationVerificationParticipant, createRequestExecutionApplicationCapabilities } from "@frely/application/internal/verification";
import { PostgresClientOwner } from "@frely/postgres/server";
import { PostgresVerificationRuntime } from "./postgres-verification-runtime.js";
import { SqlShapeCollector, type SqlShapeInventory } from "./sql-shape-observation.js";
import type { AdmitCpaBasicProviderInvocationCommand, AdmitProviderInvocationCommand } from "@frely/application/runtime";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const postgresPackageRoot = join(packageRoot, "..", "postgres");
const prismaConfigPath = join(postgresPackageRoot, "prisma.config.ts");
const prismaBinPath = join(postgresPackageRoot, "node_modules", ".bin", "prisma");
const image = process.env.FRIDAY_RELAY_PROVIDER_INVOCATION_POSTGRES_IMAGE ?? "postgres:16-alpine";
const user = "friday_invocation";
const password = "friday_invocation_local_only";
const database = "friday_invocation";
const maxBuffer = 32 * 1024 * 1024;
const now = new Date().toISOString();

export async function runProviderInvocationVerification(): Promise<void> {
  const runtime = await PostgresVerificationRuntime.start({
    verifier: "provider_invocation",
    databases: [database],
    docker: { image, user, password, containerPrefix: "friday-relay-invocation" },
    allowSuppliedDisposableDatabase: true,
  });
  let owner: PostgresClientOwner | undefined;
  try {
    const connectionString = runtime.connectionString(database);
    let activeSqlCollector: SqlShapeCollector | undefined;
    const providerAdmissionSqlShapes: Record<string, SqlShapeInventory> = {};
    const providerAdmissionDurationsMs: Record<string, number> = {};
    const observeProviderAdmission = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
      const collector = new SqlShapeCollector();
      const startedAt = performance.now();
      activeSqlCollector = collector;
      try {
        return await operation();
      } finally {
        activeSqlCollector = undefined;
        providerAdmissionSqlShapes[label] = collector.snapshot();
        providerAdmissionDurationsMs[label] = Math.max(0, Math.round(performance.now() - startedAt));
      }
    };
    owner = new PostgresClientOwner({
      connectionString,
      max: 8,
      queryObserver: (observation) => activeSqlCollector?.record(observation),
    });
    await waitForTcpPostgres(owner);
    run("bun", [prismaBinPath, "migrate", "deploy", "--config", prismaConfigPath], undefined, { ...process.env, FRIDAY_RELAY_PG_CONNECTION_STRING: connectionString }, runtime);
    const transactionWindowStartedAt = Date.now();
    await owner.withPrismaTransaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_sleep(5.2)`;
    });
    assert(Date.now() - transactionWindowStartedAt >= 5_000, "prisma_transaction_window_beyond_five_seconds");
    const requestExecution = createRequestExecutionApplicationCapabilities(owner, { userPaygoConcurrencyLimit: 1 });
    const service = requestExecution.commands;
    const serviceQueries = requestExecution.queries;
    const invocationVerification = createProviderInvocationVerificationParticipant(owner, { userPaygoConcurrencyLimit: 1 });
    const leases = createRequestExecutionLeaseCommands(owner);
    await seed(owner);

    await createRequest(owner, leases, "req_lease_matrix", "owner_lease_bootstrap");
    assert(await leases.release({ requestId: "req_lease_matrix", ownerId: "owner_lease_bootstrap" }), "lease_bootstrap_release");
    let leaseClock = now;
    const deterministicLeases = new RequestExecutionLeaseService(owner, () => leaseClock);
    const acquiredLease = await deterministicLeases.acquire({ requestId: "req_lease_matrix", ownerId: "owner_lease_a", leaseTtlSeconds: 10 });
    assert(acquiredLease.ownerId === "owner_lease_a" && acquiredLease.leaseUntil === addSeconds(now, 10), "lease_acquire_persists_owner_and_expiry");
    leaseClock = addSeconds(now, 5);
    const renewedLease = await deterministicLeases.renew({ requestId: "req_lease_matrix", ownerId: "owner_lease_a", leaseTtlSeconds: 10 });
    assert(renewedLease.ownerId === "owner_lease_a" && renewedLease.leaseUntil === addSeconds(now, 15), "lease_renew_extends_same_owner");
    await expectRelay("request_execution_lease_conflict", () => deterministicLeases.acquire({
      requestId: "req_lease_matrix", ownerId: "owner_lease_b", leaseTtlSeconds: 10,
    }));
    leaseClock = addSeconds(now, 16);
    await expectRelay("request_execution_lease_lost", () => deterministicLeases.renew({
      requestId: "req_lease_matrix", ownerId: "owner_lease_a", leaseTtlSeconds: 10,
    }));
    const takeoverLease = await deterministicLeases.acquire({ requestId: "req_lease_matrix", ownerId: "owner_lease_b", leaseTtlSeconds: 10 });
    assert(takeoverLease.ownerId === "owner_lease_b", "expired_lease_allows_new_owner_takeover");
    assert(!(await deterministicLeases.release({ requestId: "req_lease_matrix", ownerId: "owner_lease_a" })), "lost_owner_cannot_release_takeover");
    assert(await deterministicLeases.release({ requestId: "req_lease_matrix", ownerId: "owner_lease_b" }), "current_owner_releases_lease");

    const verificationCommands = createProviderInvocationVerificationCommands(owner);
    await createRequest(owner, leases, "req_cpa_basic", "owner_cpa_basic");
    const cpaBasicAttempt = await service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic", "attempt_cpa_basic", "candidate_cpa_basic"));
    const replayedCpaBasicAdmission = await service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic", "attempt_cpa_basic", "candidate_cpa_basic"));
    assert(replayedCpaBasicAdmission.providerAttemptId === cpaBasicAttempt.providerAttemptId && replayedCpaBasicAdmission.replayed, "cpa_basic_admission_idempotent");
    const cpaBasicPhysical = await owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: cpaBasicAttempt.providerAttemptId } });
    assert(cpaBasicPhysical.invocation_contract === "cpa-basic@1", "cpa_basic_contract_persisted");
    assert(cpaBasicPhysical.input_tokens === null && cpaBasicPhysical.max_output_tokens === null, "cpa_basic_has_no_token_bounds");
    assert(cpaBasicPhysical.tokenizer_id === null && cpaBasicPhysical.tokenizer_version === null, "cpa_basic_has_no_tokenizer_sentinel");
    assert(cpaBasicPhysical.billable_price_snapshot_json === null && cpaBasicPhysical.provider_cost_snapshot_json === null, "cpa_basic_has_no_preparation_price_selection");
    assert(cpaBasicPhysical.billable_price_profile_json !== null && cpaBasicPhysical.provider_cost_profile_json !== null
      && cpaBasicPhysical.access_point_price_profiles_json !== null, "cpa_basic_relay_billing_profiles_frozen");
    assert(cpaBasicPhysical.plan_subscription_id === "subscription_invocation" && cpaBasicPhysical.api_key_id === "key_invocation"
      && cpaBasicPhysical.user_id === "user_invocation" && cpaBasicPhysical.usage_charge_account_id === "credit_invocation", "cpa_basic_relay_references_frozen");
    assert(await owner.prisma.request_executions.count({ where: { request_id: "req_cpa_basic" } }) === 1, "cpa_basic_has_request_execution_owner");
    assert(await owner.prisma.budget_claims.count({ where: { provider_attempt_id: cpaBasicAttempt.providerAttemptId } }) === 0, "cpa_basic_has_no_budget_claim");
    assert(await owner.prisma.usage_reservations.count({ where: { provider_attempt_id: cpaBasicAttempt.providerAttemptId } }) === 0, "cpa_basic_has_no_usage_reservation");
    await owner.prisma.seller_settlement_events.create({ data: {
      id: "seller_settlement_cpa_basic_guard", plan_subscription_id: "subscription_invocation", authority_purchase_id: null,
      seller_scope_ref: "global:", window_start: now, window_end: addSeconds(now, 2_592_000), release_at: addSeconds(now, 2_592_000),
      event_type: "revenue", amount_units: 1n, source_type: "verification", source_id: "cpa_basic_guard", created_at: now,
    } });
    await service.assertDispatchOwnership(cpaBasicAttempt.providerAttemptId, "req_cpa_basic", "owner_cpa_basic");
    const deferredSettlement = await verificationCommands.releaseDueSellerSettlements(addSeconds(now, 2_592_001));
    assert(deferredSettlement.deferredWindows === 1 && deferredSettlement.releasedWindows === 0, "seller_settlement_defers_accruing_claimless_cpa_basic_attempt");
    await expectRelay("provider_invocation_ownership_lost", () => service.assertDispatchOwnership(cpaBasicAttempt.providerAttemptId, "req_cpa_basic", "owner_cpa_basic"));
    await service.enterReconciliation({
      providerAttemptId: cpaBasicAttempt.providerAttemptId,
      outcome: "failed",
      failureClass: "non_retryable",
      costExposure: "stopped",
      finalUsageEvidence: "pending",
      reason: "provider_final_usage_pending",
    });
    await verificationCommands.finishRequestLog("req_cpa_basic", "failed", "provider_invocation_reconciliation_required");
    const unresolvedCpaBasic = (await serviceQueries.listUnresolved()).find((row) => row.providerAttemptId === cpaBasicAttempt.providerAttemptId);
    assert(unresolvedCpaBasic?.invocationContract === "cpa-basic@1"
      && unresolvedCpaBasic.maxTotalTokens === null && unresolvedCpaBasic.maxChargeUnits === null
      && unresolvedCpaBasic.reservationStatus === null && unresolvedCpaBasic.heldUnits === null, "cpa_basic_claimless_reconciliation_query");
    await expectRelay("invalid_provider_reconciliation_evidence", () => service.reconcileFinalUsage({
      providerAttemptId: cpaBasicAttempt.providerAttemptId,
      outcome: "failed",
      failureClass: "non_retryable",
      usage: usage(0n, 0n),
      evidenceKind: "provider_billing_record",
      evidenceRef: "sk-proj-0123456789abcdef",
      audit: { actor: { actorType: "user", actorId: "user_invocation" }, requestId: "req_owner_cpa_basic_secret" },
    }));
    assert(await owner.prisma.audit_logs.count({ where: { request_id: "req_owner_cpa_basic_secret" } }) === 0
      && await owner.prisma.billing_events.count({ where: { request_id: "req_cpa_basic" } }) === 0,
    "secret_shaped_evidence_rejected_before_append_only_facts");
    const zeroCostSettlement = await service.reconcileFinalUsage({
      providerAttemptId: cpaBasicAttempt.providerAttemptId,
      outcome: "failed",
      failureClass: "non_retryable",
      usage: usage(0n, 0n),
      evidenceKind: "provider_billing_record",
      evidenceRef: "billing/verification/req_cpa_basic",
      audit: { actor: { actorType: "user", actorId: "user_invocation" }, requestId: "req_owner_cpa_basic_zero" },
    });
    assert(zeroCostSettlement.actualChargeUnits === 0n && zeroCostSettlement.postingLedgerEventId === null, "cpa_basic_zero_cost_has_no_ledger_posting");
    const cpaBasicReplay = await service.reconcileFinalUsage({
      providerAttemptId: cpaBasicAttempt.providerAttemptId,
      outcome: "failed",
      failureClass: "non_retryable",
      usage: usage(0n, 0n),
      evidenceKind: "provider_billing_record",
      evidenceRef: "billing/verification/req_cpa_basic",
      audit: { actor: { actorType: "user", actorId: "user_invocation" }, requestId: "req_owner_cpa_basic_zero_replay" },
    });
    assert(cpaBasicReplay.billingEventId === zeroCostSettlement.billingEventId, "cpa_basic_zero_cost_reconciliation_idempotent");
    const cpaBasicFinal = await owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: cpaBasicAttempt.providerAttemptId } });
    assert(cpaBasicFinal.outcome === "failed" && cpaBasicFinal.usage_settled === 1 && cpaBasicFinal.reconciliation_reason === null, "cpa_basic_finalization_persisted");
    assert(await owner.prisma.billing_events.count({ where: { request_id: "req_cpa_basic" } }) === 1, "cpa_basic_zero_cost_billing_fact_persisted");
    assert(await owner.prisma.billing_provider_cost_events.count({ where: { provider_attempt_id: cpaBasicAttempt.providerAttemptId } }) === 1, "cpa_basic_zero_cost_provider_fact_persisted");
    assert(await owner.prisma.billing_access_point_edges.count({ where: { request_id: "req_cpa_basic" } }) === 1, "cpa_basic_zero_cost_access_point_fact_persisted");
    assert(await owner.prisma.credit_ledger_events.count({ where: { billing_event_id: zeroCostSettlement.billingEventId } }) === 0, "cpa_basic_zero_cost_ledger_absent");
    assert(!(await serviceQueries.listUnresolved()).some((row) => row.providerAttemptId === cpaBasicAttempt.providerAttemptId), "cpa_basic_settled_attempt_leaves_query");

    await createRequest(owner, leases, "req_cpa_basic_fallback", "owner_cpa_basic_fallback");
    const cpaBasicFirstForFallback = await service.admitCpaBasic(cpaBasicAdmission(
      "req_cpa_basic_fallback", "attempt_cpa_basic_fallback_first", "candidate_cpa_basic_fallback_first",
    ));
    const cpaBasicFirstStartedAt = cpaBasicFirstForFallback.startedAt;
    await service.releaseNotStarted({
      providerAttemptId: cpaBasicFirstForFallback.providerAttemptId,
      outcome: "failed",
      failureClass: "connect_error",
    });
    assert(await leases.release({ requestId: "req_cpa_basic_fallback", ownerId: "owner_cpa_basic_fallback" }),
      "fallback_owner_continuity_releases_original_lease_for_negative_case");
    await leases.acquire({ requestId: "req_cpa_basic_fallback", ownerId: "owner_cpa_basic_fallback_other", leaseTtlSeconds: 3_600 });
    await expectRelay("request_execution_conflict", () => service.admitCpaBasic(cpaBasicAdmission(
      "req_cpa_basic_fallback", "attempt_cpa_basic_fallback_wrong_owner", "candidate_cpa_basic_fallback_wrong_owner",
      "owner_cpa_basic_fallback_other", 1,
    )));
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_fallback" } }) === 1,
      "fallback_rejects_new_lease_owner_without_attempt");
    assert(await leases.release({ requestId: "req_cpa_basic_fallback", ownerId: "owner_cpa_basic_fallback_other" }),
      "fallback_owner_continuity_releases_negative_owner");
    await leases.acquire({ requestId: "req_cpa_basic_fallback", ownerId: "owner_cpa_basic_fallback", leaseTtlSeconds: 3_600 });
    await leases.renew({ requestId: "req_cpa_basic_fallback", ownerId: "owner_cpa_basic_fallback", leaseTtlSeconds: 3_600 });
    const cpaBasicFallback = await service.admitCpaBasic(cpaBasicAdmission(
      "req_cpa_basic_fallback", "attempt_cpa_basic_fallback_second", "candidate_cpa_basic_fallback_second",
      "owner_cpa_basic_fallback", 1,
    ));
    const cpaBasicFallbackRows = await owner.prisma.request_provider_attempts.findMany({
      where: { request_id: "req_cpa_basic_fallback" }, orderBy: { attempt_index: "asc" },
    });
    assert(cpaBasicFallbackRows.length === 2
      && cpaBasicFallbackRows.every((attempt) => attempt.execution_owner_id === "owner_cpa_basic_fallback")
      && cpaBasicFallbackRows[0]?.started_at === cpaBasicFirstStartedAt
      && cpaBasicFallbackRows[1]?.id === cpaBasicFallback.providerAttemptId,
    "cpa_basic_first_and_fallback_share_owner_and_freeze_started_at");
    await service.releaseNotStarted({
      providerAttemptId: cpaBasicFallback.providerAttemptId,
      outcome: "failed",
      failureClass: "connect_error",
      requestTerminalStatus: "failed",
      requestTerminalErrorCode: "fallback_complete",
    });

    await createRequest(owner, leases, "req_cpa_basic_owner_loss", "owner_cpa_basic_owner_loss_a");
    const cpaBasicOwnerLoss = await service.admitCpaBasic(cpaBasicAdmission(
      "req_cpa_basic_owner_loss", "attempt_cpa_basic_owner_loss", "candidate_cpa_basic_owner_loss",
      "owner_cpa_basic_owner_loss_a",
    ));
    assert(await leases.release({ requestId: "req_cpa_basic_owner_loss", ownerId: "owner_cpa_basic_owner_loss_a" }), "owner_loss_releases_original_lease");
    await leases.acquire({ requestId: "req_cpa_basic_owner_loss", ownerId: "owner_cpa_basic_owner_loss_b", leaseTtlSeconds: 3_600 });
    await expectRelay("provider_invocation_ownership_lost", () => service.assertDispatchOwnership(
      cpaBasicOwnerLoss.providerAttemptId, "req_cpa_basic_owner_loss", "owner_cpa_basic_owner_loss_a",
    ));
    await expectRelay("provider_invocation_ownership_lost", () => service.assertDispatchOwnership(
      cpaBasicOwnerLoss.providerAttemptId, "req_cpa_basic_owner_loss", "owner_cpa_basic_owner_loss_b",
    ));
    await expectRelay("request_execution_conflict", () => service.admitCpaBasic(cpaBasicAdmission(
      "req_cpa_basic_owner_loss", "attempt_cpa_basic_owner_loss_fallback", "candidate_cpa_basic_owner_loss_fallback",
      "owner_cpa_basic_owner_loss_b", 1,
    )));
    const cpaBasicOwnerLossState = await owner.prisma.request_provider_attempts.findUniqueOrThrow({
      where: { id: cpaBasicOwnerLoss.providerAttemptId },
    });
    assert(cpaBasicOwnerLossState.execution_owner_id === "owner_cpa_basic_owner_loss_a"
      && cpaBasicOwnerLossState.cost_exposure === "accruing"
      && cpaBasicOwnerLossState.final_usage_evidence === "pending"
      && cpaBasicOwnerLossState.reconciliation_reason === "execution_ownership_lost"
      && await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_owner_loss" } }) === 1,
    "cpa_basic_owner_loss_blocks_redispatch_and_fallback");
    await verificationCommands.finishRequestLog(
      "req_cpa_basic_owner_loss", "failed", "execution_ownership_lost",
    );
    assert((await serviceQueries.listUnresolved()).some((row) => row.providerAttemptId === cpaBasicOwnerLoss.providerAttemptId),
      "cpa_basic_owner_loss_visible_for_reconciliation");
    await service.reconcileFinalUsage({
      providerAttemptId: cpaBasicOwnerLoss.providerAttemptId,
      outcome: "failed",
      failureClass: "non_retryable",
      usage: usage(0n, 0n),
      evidenceKind: "provider_billing_record",
      evidenceRef: "billing/verification/req_cpa_basic_owner_loss",
      audit: { actor: { actorType: "user", actorId: "user_invocation" }, requestId: "req_owner_cpa_basic_owner_loss" },
    });
    assert(!(await serviceQueries.listUnresolved()).some((row) => row.providerAttemptId === cpaBasicOwnerLoss.providerAttemptId)
      && await owner.prisma.billing_events.count({ where: { request_id: "req_cpa_basic_owner_loss" } }) === 1,
    "cpa_basic_owner_loss_reconciles_once_through_billing");

    await createRequest(owner, leases, "req_cpa_basic_tier", "owner_cpa_basic_tier");
    const cpaBasicTierAttempt = await service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_tier", "attempt_cpa_basic_tier", "candidate_cpa_basic_tier"));
    await service.assertDispatchOwnership(cpaBasicTierAttempt.providerAttemptId, "req_cpa_basic_tier", "owner_cpa_basic_tier");
    await service.enterReconciliation({
      providerAttemptId: cpaBasicTierAttempt.providerAttemptId,
      outcome: "failed",
      failureClass: "upstream_5xx",
      costExposure: "stopped",
      finalUsageEvidence: "pending",
      reason: "provider_final_usage_pending",
    });
    await verificationCommands.finishRequestLog("req_cpa_basic_tier", "failed", "provider_invocation_reconciliation_required");
    const balanceBeforeCpaBasicTier = (await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: "credit_invocation" } })).balance_snap_units;
    const failingCpaBasicAuditService = createRequestExecutionApplicationCapabilities(
      owner,
      { userPaygoConcurrencyLimit: 1 },
      { append: async () => { throw new Error("verification_audit_failure"); } },
    ).commands;
    await expectFailure(() => failingCpaBasicAuditService.reconcileFinalUsage({
      providerAttemptId: cpaBasicTierAttempt.providerAttemptId,
      outcome: "failed",
      failureClass: "upstream_5xx",
      usage: usage(300n, 25n, "response"),
      evidenceKind: "provider_response",
      evidenceRef: "response/verification/req_cpa_basic_tier",
      audit: { actor: { actorType: "user", actorId: "user_invocation" }, requestId: "req_owner_cpa_basic_tier_rollback" },
    }));
    const cpaBasicTierAfterRollback = await owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: cpaBasicTierAttempt.providerAttemptId } });
    assert(cpaBasicTierAfterRollback.usage_settled === 0 && cpaBasicTierAfterRollback.reconciliation_reason === "provider_final_usage_pending"
      && await owner.prisma.billing_events.count({ where: { request_id: "req_cpa_basic_tier" } }) === 0
      && await owner.prisma.provider_invocation_usage_facts.count({ where: { provider_attempt_id: cpaBasicTierAttempt.providerAttemptId } }) === 0
      && await owner.prisma.billing_provider_cost_events.count({ where: { provider_attempt_id: cpaBasicTierAttempt.providerAttemptId } }) === 0
      && await owner.prisma.billing_access_point_edges.count({ where: { request_id: "req_cpa_basic_tier" } }) === 0
      && await owner.prisma.credit_ledger_events.count({ where: { provider_attempt_id: cpaBasicTierAttempt.providerAttemptId } }) === 0
      && (await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: "credit_invocation" } })).balance_snap_units === balanceBeforeCpaBasicTier,
    "cpa_basic_reconciliation_and_audit_rollback_atomic");
    const cpaBasicTierSettlement = await service.reconcileFinalUsage({
      providerAttemptId: cpaBasicTierAttempt.providerAttemptId,
      outcome: "failed",
      failureClass: "upstream_5xx",
      usage: usage(300n, 25n, "response"),
      evidenceKind: "provider_response",
      evidenceRef: "response/verification/req_cpa_basic_tier",
      audit: { actor: { actorType: "user", actorId: "user_invocation" }, requestId: "req_owner_cpa_basic_tier" },
    });
    assert(cpaBasicTierSettlement.actualChargeUnits === 650n && cpaBasicTierSettlement.postingLedgerEventId !== null, "cpa_basic_nonzero_authoritative_charge");
    const cpaBasicTierBilling = await owner.prisma.billing_events.findUniqueOrThrow({ where: { id: cpaBasicTierSettlement.billingEventId } });
    const cpaBasicTierProvider = await owner.prisma.billing_provider_cost_events.findFirstOrThrow({ where: { provider_attempt_id: cpaBasicTierAttempt.providerAttemptId } });
    const cpaBasicTierEdge = await owner.prisma.billing_access_point_edges.findFirstOrThrow({ where: { request_id: "req_cpa_basic_tier" } });
    const cpaBasicTierLedger = await owner.prisma.credit_ledger_events.findUniqueOrThrow({ where: { id: cpaBasicTierSettlement.postingLedgerEventId! } });
    assert(cpaBasicTierBilling.billable_price_tier_key === "long_context" && cpaBasicTierBilling.billable_amount_units === 650n
      && cpaBasicTierBilling.provider_cost_tier_key === "long_context" && cpaBasicTierBilling.provider_cost_amount_units === 325n, "cpa_basic_authoritative_tier_amounts");
    assert(cpaBasicTierProvider.provider_id === "provider_invocation" && cpaBasicTierProvider.provider_model_name === "model-invocation"
      && cpaBasicTierProvider.provider_model_cost_id === "cost_invocation" && cpaBasicTierProvider.amount_units === 325n, "cpa_basic_provider_identity_and_cost");
    assert(cpaBasicTierEdge.access_point_id === "ap_invocation" && cpaBasicTierEdge.access_point_price_id === "price_invocation"
      && cpaBasicTierEdge.price_tier_key === "long_context" && cpaBasicTierEdge.amount_units === 650n, "cpa_basic_access_point_identity_and_amount");
    assert(cpaBasicTierLedger.provider_attempt_id === cpaBasicTierAttempt.providerAttemptId && cpaBasicTierLedger.amount_units === -650n
      && (await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: "credit_invocation" } })).balance_snap_units === balanceBeforeCpaBasicTier - 650n, "cpa_basic_ledger_and_balance_atomic");
    assert(await owner.prisma.budget_claims.count({ where: { provider_attempt_id: cpaBasicTierAttempt.providerAttemptId } }) === 0
      && await owner.prisma.usage_reservations.count({ where: { provider_attempt_id: cpaBasicTierAttempt.providerAttemptId } }) === 0
      && await owner.prisma.request_executions.count({ where: { request_id: "req_cpa_basic_tier" } }) === 1, "cpa_basic_nonzero_remains_claimless_with_execution_owner");

    await createRequest(owner, leases, "req_cpa_basic_live", "owner_cpa_basic_live");
    const cpaBasicLive = await service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_live", "attempt_cpa_basic_live", "candidate_cpa_basic_live"));
    await service.assertDispatchOwnership(cpaBasicLive.providerAttemptId, "req_cpa_basic_live", "owner_cpa_basic_live");
    const cpaBasicLiveSettlement = await service.settleCpaBasicLive({
      providerAttemptId: cpaBasicLive.providerAttemptId,
      outcome: "succeeded",
      outputCommitted: true,
      usage: usage(300n, 25n, "response"),
      requestTerminalStatus: "succeeded",
    });
    const cpaBasicLiveAttempt = await owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: cpaBasicLive.providerAttemptId } });
    assert(cpaBasicLiveAttempt.outcome === "succeeded" && cpaBasicLiveAttempt.usage_settled === 1
      && await owner.prisma.provider_invocation_usage_facts.count({ where: { provider_attempt_id: cpaBasicLive.providerAttemptId } }) === 1
      && await owner.prisma.billing_events.count({ where: { request_id: "req_cpa_basic_live" } }) === 1,
    "cpa_basic_live_billing_and_attempt_finalize_atomically");
    const cpaBasicLiveReplay = await service.settleCpaBasicLive({
      providerAttemptId: cpaBasicLive.providerAttemptId,
      outcome: "succeeded",
      outputCommitted: true,
      usage: usage(300n, 25n, "response"),
    });
    assert(cpaBasicLiveReplay.billingEventId === cpaBasicLiveSettlement.billingEventId, "cpa_basic_live_settlement_idempotent");

    await createRequest(owner, leases, "req_cpa_basic_failed_final", "owner_cpa_basic_failed_final");
    const cpaBasicFailedFinal = await service.admitCpaBasic(cpaBasicAdmission(
      "req_cpa_basic_failed_final",
      "attempt_cpa_basic_failed_final",
      "candidate_cpa_basic_failed_final",
    ));
    await service.assertDispatchOwnership(
      cpaBasicFailedFinal.providerAttemptId,
      "req_cpa_basic_failed_final",
      "owner_cpa_basic_failed_final",
    );
    const failedFinalCommand = {
      providerAttemptId: cpaBasicFailedFinal.providerAttemptId,
      outcome: "failed" as const,
      failureClass: "non_retryable" as const,
      failureReason: "auth_unauthorized" as const,
      outputCommitted: true,
      usage: usage(300n, 25n, "response"),
      requestTerminalStatus: "failed" as const,
      requestTerminalErrorCode: "cliproxy_provider_credentials_unauthorized",
    };
    const cpaBasicFailedFinalSettlement = await service.settleCpaBasicLive(failedFinalCommand);
    const cpaBasicFailedFinalReplay = await service.settleCpaBasicLive(failedFinalCommand);
    await verificationCommands.finishRequestLog(
      "req_cpa_basic_failed_final",
      "failed",
      "cliproxy_provider_credentials_unauthorized",
      "auth_unauthorized",
    );
    const [cpaBasicFailedFinalAttempt, cpaBasicFailedFinalExecution, cpaBasicFailedFinalRequest] = await Promise.all([
      owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: cpaBasicFailedFinal.providerAttemptId } }),
      owner.prisma.request_executions.findUniqueOrThrow({ where: { request_id: "req_cpa_basic_failed_final" } }),
      owner.prisma.request_logs.findUniqueOrThrow({ where: { id: "req_cpa_basic_failed_final" } }),
    ]);
    assert(cpaBasicFailedFinalReplay.billingEventId === cpaBasicFailedFinalSettlement.billingEventId
      && cpaBasicFailedFinalAttempt.outcome === "failed"
      && cpaBasicFailedFinalAttempt.failure_class === "non_retryable"
      && cpaBasicFailedFinalAttempt.failure_reason === "auth_unauthorized"
      && cpaBasicFailedFinalAttempt.usage_settled === 1
      && cpaBasicFailedFinalExecution.status === "failed"
      && cpaBasicFailedFinalExecution.terminal_error_code === "cliproxy_provider_credentials_unauthorized"
      && cpaBasicFailedFinalRequest.status === "failed"
      && cpaBasicFailedFinalRequest.error_code === "cliproxy_provider_credentials_unauthorized"
      && cpaBasicFailedFinalRequest.credential_failure_reason === "auth_unauthorized"
      && await owner.prisma.provider_invocation_usage_facts.count({ where: { provider_attempt_id: cpaBasicFailedFinal.providerAttemptId } }) === 1
      && await owner.prisma.billing_events.count({ where: { request_id: "req_cpa_basic_failed_final" } }) === 1
      && await owner.prisma.billing_provider_cost_events.count({ where: { provider_attempt_id: cpaBasicFailedFinal.providerAttemptId } }) === 1,
    "cpa_basic_failed_final_usage_settles_once_without_success_transition");
    await verificationCommands.finishRequestLog(
      "req_cpa_basic_failed_final",
      "failed",
      "cliproxy_provider_credentials_unauthorized",
    );
    const credentialReasonVerificationPrisma = owner.prisma;
    assert((await credentialReasonVerificationPrisma.request_logs.findUniqueOrThrow({
      where: { id: "req_cpa_basic_failed_final" },
    })).credential_failure_reason === "auth_unauthorized", "request_log_omitted_failure_reason_preserves_terminal_fact");
    await expectFailure(() => credentialReasonVerificationPrisma.request_provider_attempts.update({
      where: { id: cpaBasicFailedFinal.providerAttemptId },
      data: { failure_reason: "auth_unavailable" },
    }));
    await expectFailure(() => credentialReasonVerificationPrisma.request_logs.update({
      where: { id: "req_cpa_basic_failed_final" },
      data: { credential_failure_reason: "auth_unavailable" },
    }));
    await expectFailure(() => credentialReasonVerificationPrisma.request_provider_attempts.update({
      where: { id: cpaBasicLive.providerAttemptId },
      data: { failure_reason: "auth_unavailable" },
    }));
    await expectFailure(() => credentialReasonVerificationPrisma.request_logs.update({
      where: { id: "req_cpa_basic_live" },
      data: { status: "succeeded", credential_failure_reason: "auth_unavailable" },
    }));

    await createRequest(owner, leases, "req_cpa_basic_live_rollback", "owner_cpa_basic_live_rollback");
    const cpaBasicLiveRollback = await service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_live_rollback", "attempt_cpa_basic_live_rollback", "candidate_cpa_basic_live_rollback"));
    await service.assertDispatchOwnership(cpaBasicLiveRollback.providerAttemptId, "req_cpa_basic_live_rollback", "owner_cpa_basic_live_rollback");
    await owner.prisma.$executeRawUnsafe(`
      CREATE FUNCTION "verification_fail_cpa_basic_live_settlement"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'verification cpa basic settlement failure'; END $$
    `);
    await owner.prisma.$executeRawUnsafe(`
      CREATE TRIGGER "verification_fail_cpa_basic_live_settlement"
      BEFORE INSERT ON "billing_provider_cost_events"
      FOR EACH ROW EXECUTE FUNCTION "verification_fail_cpa_basic_live_settlement"()
    `);
    try {
      await expectFailure(() => service.settleCpaBasicLive({
        providerAttemptId: cpaBasicLiveRollback.providerAttemptId,
        outcome: "succeeded",
        outputCommitted: true,
        usage: usage(300n, 25n, "response"),
      }));
    } finally {
      await owner.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "verification_fail_cpa_basic_live_settlement" ON "billing_provider_cost_events"`);
      await owner.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "verification_fail_cpa_basic_live_settlement"()`);
    }
    const cpaBasicLiveAfterRollback = await owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: cpaBasicLiveRollback.providerAttemptId } });
    assert(cpaBasicLiveAfterRollback.outcome === "succeeded"
      && cpaBasicLiveAfterRollback.cost_exposure === "stopped"
      && cpaBasicLiveAfterRollback.final_usage_evidence === "pending"
      && cpaBasicLiveAfterRollback.usage_settled === 0
      && cpaBasicLiveAfterRollback.reconciliation_reason === "provider_usage_settlement_failed"
      && await owner.prisma.provider_invocation_usage_facts.count({ where: { provider_attempt_id: cpaBasicLiveRollback.providerAttemptId } }) === 0
      && await owner.prisma.billing_events.count({ where: { request_id: "req_cpa_basic_live_rollback" } }) === 0
      && await owner.prisma.billing_provider_cost_events.count({ where: { provider_attempt_id: cpaBasicLiveRollback.providerAttemptId } }) === 0
      && await owner.prisma.billing_access_point_edges.count({ where: { request_id: "req_cpa_basic_live_rollback" } }) === 0
      && await owner.prisma.credit_ledger_events.count({ where: { provider_attempt_id: cpaBasicLiveRollback.providerAttemptId } }) === 0,
    "cpa_basic_live_settlement_command_rolls_back_billing_and_enters_reconciliation");
    await verificationCommands.finishRequestLog("req_cpa_basic_live_rollback", "failed", "provider_usage_settlement_failed");
    const cpaBasicLiveRecovery = (await serviceQueries.listUnresolved()).find((row) => row.providerAttemptId === cpaBasicLiveRollback.providerAttemptId);
    assert(cpaBasicLiveRecovery?.outcome === "succeeded" && cpaBasicLiveRecovery.costExposure === "stopped"
      && cpaBasicLiveRecovery.reconciliationReason === "provider_usage_settlement_failed",
    "cpa_basic_live_settlement_rollback_is_owner_reconcilable");
    const recoveryDeferredSettlement = await verificationCommands.releaseDueSellerSettlements(addSeconds(now, 2_592_062));
    assert(recoveryDeferredSettlement.deferredWindows === 1 && recoveryDeferredSettlement.releasedWindows === 0,
      "seller_settlement_defers_cpa_basic_settlement_recovery");
    const recoveredCpaBasicLive = await service.reconcileFinalUsage({
      providerAttemptId: cpaBasicLiveRollback.providerAttemptId,
      outcome: "succeeded",
      outputCommitted: true,
      usage: usage(300n, 25n, "response"),
      evidenceKind: "provider_response",
      evidenceRef: "response/verification/req_cpa_basic_live_rollback",
      audit: { actor: { actorType: "user", actorId: "user_invocation" }, requestId: "req_owner_cpa_basic_live_rollback" },
    });
    assert(recoveredCpaBasicLive.actualChargeUnits === 650n
      && await owner.prisma.provider_invocation_usage_facts.count({ where: { provider_attempt_id: cpaBasicLiveRollback.providerAttemptId } }) === 1
      && await owner.prisma.billing_events.count({ where: { request_id: "req_cpa_basic_live_rollback" } }) === 1
      && await owner.prisma.billing_provider_cost_events.count({ where: { provider_attempt_id: cpaBasicLiveRollback.providerAttemptId } }) === 1
      && await owner.prisma.billing_access_point_edges.count({ where: { request_id: "req_cpa_basic_live_rollback" } }) === 1
      && await owner.prisma.credit_ledger_events.count({ where: { provider_attempt_id: cpaBasicLiveRollback.providerAttemptId } }) === 1
      && !(await serviceQueries.listUnresolved()).some((row) => row.providerAttemptId === cpaBasicLiveRollback.providerAttemptId),
    "cpa_basic_live_settlement_recovery_preserves_unique_facts");

    await createRequest(owner, leases, "req_cpa_basic_subscription_guard", "owner_cpa_basic_subscription_guard");
    await owner.prisma.plan_subscriptions.update({ where: { id: "subscription_invocation" }, data: { subscription_lifecycle: "canceled" } });
    await expectRelay("plan_subscription_unavailable", () => service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_subscription_guard", "attempt_cpa_basic_subscription_guard", "candidate_cpa_basic_subscription_guard")));
    await owner.prisma.plan_subscriptions.update({ where: { id: "subscription_invocation" }, data: { subscription_lifecycle: "active" } });
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_subscription_guard" } }) === 0, "cpa_basic_subscription_recheck_is_atomic");

    await createRequest(owner, leases, "req_cpa_basic_plan_guard", "owner_cpa_basic_plan_guard");
    await owner.prisma.plans.update({ where: { id: "plan_invocation" }, data: { plan_status: "disabled" } });
    await expectRelay("plan_subscription_unavailable", () => service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_plan_guard", "attempt_cpa_basic_plan_guard", "candidate_cpa_basic_plan_guard")));
    await owner.prisma.plans.update({ where: { id: "plan_invocation" }, data: { plan_status: "enabled" } });
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_plan_guard" } }) === 0, "cpa_basic_plan_runtime_recheck_is_atomic");

    await createRequest(owner, leases, "req_cpa_basic_route_guard", "owner_cpa_basic_route_guard");
    await owner.prisma.accessPointTarget.update({ where: { id: "edge_invocation" }, data: { status: "disabled" } });
    await expectRelay("access_configuration_changed", () => service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_route_guard", "attempt_cpa_basic_route_guard", "candidate_cpa_basic_route_guard")));
    await owner.prisma.accessPointTarget.update({ where: { id: "edge_invocation" }, data: { status: "enabled" } });
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_route_guard" } }) === 0, "cpa_basic_routing_target_recheck_is_atomic");

    await createRequest(owner, leases, "req_cpa_basic_price_guard", "owner_cpa_basic_price_guard");
    await owner.prisma.access_point_prices.update({ where: { id: "price_invocation" }, data: { status: "disabled" } });
    await expectRelay("access_configuration_changed", () => service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_price_guard", "attempt_cpa_basic_price_guard", "candidate_cpa_basic_price_guard")));
    await owner.prisma.access_point_prices.update({ where: { id: "price_invocation" }, data: { status: "enabled" } });
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_price_guard" } }) === 0, "cpa_basic_price_recheck_is_atomic");

    await createRequest(owner, leases, "req_cpa_basic_balance_guard", "owner_cpa_basic_balance_guard");
    const balanceBeforeAdmissionGuard = (await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: "credit_invocation" } })).balance_snap_units;
    await owner.prisma.credit_accounts.update({ where: { id: "credit_invocation" }, data: { balance_snap_units: 0n } });
    await expectRelay("insufficient_credit", () => service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_balance_guard", "attempt_cpa_basic_balance_guard", "candidate_cpa_basic_balance_guard")));
    await owner.prisma.credit_accounts.update({ where: { id: "credit_invocation" }, data: { balance_snap_units: balanceBeforeAdmissionGuard } });
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_balance_guard" } }) === 0, "cpa_basic_positive_balance_recheck_is_atomic");

    await createRequest(owner, leases, "req_cpa_basic_user_guard", "owner_cpa_basic_user_guard");
    await owner.prisma.user_controls.update({ where: { id: "user_invocation" }, data: { status: "disabled" } });
    await expectRelay("request_execution_not_found", () => service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_user_guard", "attempt_cpa_basic_user_guard", "candidate_cpa_basic_user_guard")));
    await owner.prisma.user_controls.update({ where: { id: "user_invocation" }, data: { status: "enabled" } });
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_user_guard" } }) === 0,
      "cpa_basic_enabled_user_recheck_is_atomic");

    await createRequest(owner, leases, "req_cpa_basic_user_scope_guard", "owner_cpa_basic_user_scope_guard", "subscription_invocation_foreign_user", "user:team_owner_invocation");
    await expectRelay("plan_subscription_unavailable", () => service.admitCpaBasic({
      ...cpaBasicAdmission("req_cpa_basic_user_scope_guard", "attempt_cpa_basic_user_scope_guard", "candidate_cpa_basic_user_scope_guard"),
      planSubscriptionId: "subscription_invocation_foreign_user",
    }));
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_user_scope_guard" } }) === 0,
      "cpa_basic_user_scope_identity_recheck_is_atomic");

    await createRequest(owner, leases, "req_cpa_basic_membership_guard", "owner_cpa_basic_membership_guard", "subscription_invocation_team", "team:team_invocation");
    await owner.prisma.team_memberships.delete({ where: { team_id_user_id: { team_id: "team_invocation", user_id: "user_invocation" } } });
    await expectRelay("plan_subscription_unavailable", () => service.admitCpaBasic({
      ...cpaBasicAdmission("req_cpa_basic_membership_guard", "attempt_cpa_basic_membership_guard", "candidate_cpa_basic_membership_guard"),
      planSubscriptionId: "subscription_invocation_team",
    }));
    await owner.prisma.team_memberships.create({ data: {
      id: "membership_invocation", team_id: "team_invocation", user_id: "user_invocation",
      roles_json: "[\"viewer\"]", by_invite_link: null, created_at: now, updated_at: now,
    } });
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_membership_guard" } }) === 0,
      "cpa_basic_team_membership_recheck_is_atomic");

    await createRequest(owner, leases, "req_cpa_basic_team_guard", "owner_cpa_basic_team_guard", "subscription_invocation_team", "team:team_invocation");
    await owner.prisma.teams.update({ where: { id: "team_invocation" }, data: { status: "disabled" } });
    await owner.prisma.team_deletion_lifecycles.create({ data: {
      id: "team_deletion_invocation", team_id: "team_invocation", requested_at: now,
      requested_by_user_id: "team_owner_invocation", purge_not_before: addSeconds(now, 15_552_000),
      archive_status: "pending", archive_manifest_id: null, archive_manifest_object_key: null,
      archive_manifest_sha256: null, archive_coverage_json: null, archived_at: null, cancelled_at: null, purged_at: null,
    } });
    await expectRelay("plan_subscription_unavailable", () => service.admitCpaBasic({
      ...cpaBasicAdmission("req_cpa_basic_team_guard", "attempt_cpa_basic_team_guard", "candidate_cpa_basic_team_guard"),
      planSubscriptionId: "subscription_invocation_team",
    }));
    await owner.prisma.team_deletion_lifecycles.update({ where: { id: "team_deletion_invocation" }, data: { cancelled_at: now } });
    await owner.prisma.teams.update({ where: { id: "team_invocation" }, data: { status: "enabled" } });
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_team_guard" } }) === 0,
      "cpa_basic_team_availability_recheck_is_atomic");

    await createRequest(owner, leases, "req_cpa_basic_partner_guard", "owner_cpa_basic_partner_guard", "subscription_invocation_team", "team:team_invocation");
    await expectRelay("partner_subscription_expired", () => invocationVerification.admitCpaBasicWithCanceledPartnerEntitlement({
      entitlement: {
        id: "partner_entitlement_invocation_revoked",
        sourceOrderId: "service_order_missing_deferred",
        ownerUserId: "team_owner_invocation",
        partnerTeamId: "team_invocation",
        partnerPlanId: "plan_invocation",
        planSubscriptionId: "subscription_invocation_team",
        effectiveStart: now,
        effectiveEnd: addSeconds(now, 3_600),
        createdAt: now,
      },
      command: {
        ...cpaBasicAdmission("req_cpa_basic_partner_guard", "attempt_cpa_basic_partner_guard", "candidate_cpa_basic_partner_guard"),
        planSubscriptionId: "subscription_invocation_team",
      },
    }));
    assert(await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_cpa_basic_partner_guard" } }) === 0,
      "cpa_basic_partner_source_entitlement_recheck_is_atomic");

    await createRequest(owner, leases, "req_cpa_basic_scope_authority", "owner_cpa_basic_scope_authority");
    await owner.prisma.accessPoint.update({ where: { id: "ap_invocation" }, data: { scopeRef: "team:authoritative-ap" } });
    await owner.prisma.providers.update({ where: { id: "provider_invocation" }, data: { scope_ref: "team:authoritative-provider" } });
    const cpaBasicScopeAuthority = await service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_scope_authority", "attempt_cpa_basic_scope_authority", "candidate_cpa_basic_scope_authority"));
    const cpaBasicScopeAttempt = await owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: cpaBasicScopeAuthority.providerAttemptId } });
    const frozenScopeProfiles = JSON.parse(cpaBasicScopeAttempt.access_point_price_profiles_json!) as Array<{ buyerScopeRef: string; sellerScopeRef: string }>;
    assert(cpaBasicScopeAttempt.provider_owner_scope_ref === "team:authoritative-provider"
      && frozenScopeProfiles[0]?.buyerScopeRef === "user:user_invocation"
      && frozenScopeProfiles[0]?.sellerScopeRef === "team:authoritative-ap",
    "cpa_basic_freezes_database_authoritative_scopes");
    await owner.prisma.accessPoint.update({ where: { id: "ap_invocation" }, data: { scopeRef: "global:" } });
    await owner.prisma.providers.update({ where: { id: "provider_invocation" }, data: { scope_ref: "global:" } });
    await service.releaseNotStarted({
      providerAttemptId: cpaBasicScopeAuthority.providerAttemptId,
      outcome: "failed",
      failureClass: "non_retryable",
      requestTerminalStatus: "failed",
      requestTerminalErrorCode: "non_retryable",
    });

    await createRequest(owner, leases, "req_tier", "owner_tier");
    await expectRelay("price_service_tier_unavailable", () => observeProviderAdmission(
      "protected.denial.service_tier",
      () => service.admit({ ...admission("req_tier", "owner_tier", "candidate_tier"), serviceTier: "priority" }),
    ));
    assert(await owner.prisma.request_executions.count({ where: { request_id: "req_tier" } }) === 0, "unpriced_service_tier_admission_is_atomic");

    await createRequest(owner, leases, "req_stable_model", "owner_stable_model");
    await expectRelay("access_configuration_changed", () => service.admit({
      ...admission("req_stable_model", "owner_stable_model", "candidate_stable_model"),
      providerModelId: "provider_model_not_in_frozen_path",
    }));
    assert(await owner.prisma.request_executions.count({ where: { request_id: "req_stable_model" } }) === 0, "stable_provider_model_admission_is_atomic");

    await createRequest(owner, leases, "req_source_guard", "owner_source_guard", null);
    const sourceGuard = await service.admit(admission("req_source_guard", "owner_source_guard", "candidate_source_guard"));
    const sourceGuardAttempt = await owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: sourceGuard.providerAttemptId } });
    const sourceGuardExecution = await owner.prisma.request_executions.findUniqueOrThrow({ where: { request_id: "req_source_guard" } });
    assert(sourceGuardAttempt.provider_model_id === "provider_model_invocation", "provider_attempt_persists_stable_provider_model");
    assert(sourceGuardExecution.selected_plan_subscription_id === "subscription_invocation", "request_execution_persists_selected_source");
    await expectFailure(() => owner!.prisma.request_executions.update({
      where: { request_id: "req_source_guard" },
      data: { selected_plan_subscription_id: "subscription_invocation_other" },
    }));
    await expectFailure(() => owner!.prisma.request_logs.update({
      where: { id: "req_source_guard" },
      data: { plan_subscription_id: "subscription_invocation_other" },
    }));
    await owner.prisma.request_logs.update({
      where: { id: "req_source_guard" },
      data: { plan_subscription_id: "subscription_invocation" },
    });
    await service.releaseNotStarted({
      providerAttemptId: sourceGuard.providerAttemptId,
      outcome: "failed",
      failureClass: "connect_error",
      requestTerminalStatus: "failed",
      requestTerminalErrorCode: "source_guard_complete",
    });

    await createRequest(owner, leases, "req_1", "owner_1");
    const first = await observeProviderAdmission("protected.paygo.first", () => service.admit(admission("req_1", "owner_1", "candidate_1")));
    assert(first.usageReservationId !== null && first.reservationUnits === 272n, "maximum_reservation");
    const idempotent = await observeProviderAdmission("protected.paygo.replay", () => service.admit(admission("req_1", "owner_1", "candidate_1")));
    assert(idempotent.providerAttemptId === first.providerAttemptId, "provider_attempt_idempotency");
    await expectRelay("provider_attempt_idempotency_conflict", () => observeProviderAdmission(
      "protected.paygo.idempotency_conflict",
      () => service.admit({ ...admission("req_1", "owner_1", "candidate_1"), maxOutputTokens: 173n }),
    ));
    await owner.prisma.accessPoint.update({ where: { id: "ap_invocation" }, data: { routingRevision: 2 } });
    const replayAfterRoutingChange = await observeProviderAdmission(
      "protected.paygo.replay_after_routing_change",
      () => service.admit(admission("req_1", "owner_1", "candidate_1")),
    );
    assert(replayAfterRoutingChange.providerAttemptId === first.providerAttemptId, "idempotent_replay_uses_frozen_admission");
    await owner.prisma.accessPoint.update({ where: { id: "ap_invocation" }, data: { routingRevision: 1 } });
    await service.assertDispatchOwnership(first.providerAttemptId, "req_1", "owner_1");
    assert(!(await serviceQueries.listUnresolved()).some((row) => row.providerAttemptId === first.providerAttemptId), "running_attempt_hidden_from_reconciliation_query");
    await expectRelay("provider_attempt_not_reconcilable", () => service.reconcileFinalUsage({
      providerAttemptId: first.providerAttemptId, outcome: "succeeded", usage: usage(100n, 25n),
      evidenceKind: "provider_billing_record", evidenceRef: "billing/verification/req_1",
      audit: { actor: { actorType: "user", actorId: "user_invocation" }, requestId: "req_early_reconcile" },
    }));
    const failedReconciliationAudit = await owner.prisma.audit_logs.findFirstOrThrow({ where: {
      action: "provider_invocation.reconcile_final", resource_id: first.providerAttemptId, result: "failure",
    } });
    assert(failedReconciliationAudit.request_id === "req_early_reconcile", "reconciliation_failure_audit_short_transaction");

    await createRequest(owner, leases, "req_2", "owner_2");
    await expectRelay("paygo_concurrency_limit_exceeded", () => observeProviderAdmission(
      "protected.paygo.denial_concurrency",
      () => service.admit(admission("req_2", "owner_2", "candidate_2")),
    ));

    const settled = await service.settleFinalUsage({
      providerAttemptId: first.providerAttemptId, outcome: "succeeded", usage: usage(100n, 25n),
      requestTerminalStatus: "succeeded",
    });
    assert(settled.actualChargeUnits === 125n && settled.postingLedgerEventId !== null, "actual_integer_charge");
    assert(await owner.prisma.budget_claims.count({ where: { provider_attempt_id: first.providerAttemptId } }) === 0, "claim_replaced_by_usage");
    assert((await owner.prisma.usage_reservations.findUniqueOrThrow({ where: { provider_attempt_id: first.providerAttemptId } })).status === "settled", "reservation_settled");
    assert(await owner.prisma.credit_ledger_events.count({ where: { provider_attempt_id: first.providerAttemptId } }) === 1, "unique_nonzero_posting");
    const fact = await owner.prisma.provider_invocation_usage_facts.findUniqueOrThrow({ where: { provider_attempt_id: first.providerAttemptId } });
    const attempt = await owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: first.providerAttemptId } });
    const billingEvent = await owner.prisma.billing_events.findUniqueOrThrow({ where: { id: fact.billing_event_id } });
    const posting = await owner.prisma.credit_ledger_events.findUniqueOrThrow({ where: { id: settled.postingLedgerEventId! } });
    assert(billingEvent.billable_amount_units === 125n && billingEvent.provider_cost_amount_units === 63n, "billing_units_atomic");
    assert(posting.billing_event_id === billingEvent.id, "ledger_links_billing_event");
    assert(await owner.prisma.billing_provider_cost_events.count({ where: { provider_attempt_id: first.providerAttemptId } }) === 1, "provider_cost_atomic");
    assert(await owner.prisma.billing_access_point_edges.count({ where: { request_id: "req_1" } }) === 1, "access_point_edge_atomic");
    assert(fact.occurred_at === attempt.started_at, "usage_occurrence_uses_attempt_start");
    const replayedSettlement = await service.settleFinalUsage({
      providerAttemptId: first.providerAttemptId, outcome: "succeeded", usage: usage(100n, 25n),
      requestTerminalStatus: "succeeded",
    });
    assert(replayedSettlement.postingLedgerEventId === settled.postingLedgerEventId, "matching_settlement_is_idempotent");
    await expectRelay("provider_attempt_settlement_conflict", () => service.settleFinalUsage({
      providerAttemptId: first.providerAttemptId, outcome: "succeeded", usage: usage(100n, 26n),
      requestTerminalStatus: "succeeded",
    }));
    await expectRelay("provider_attempt_settlement_conflict", () => service.settleFinalUsage({
      providerAttemptId: first.providerAttemptId, outcome: "succeeded", outputCommitted: true, usage: usage(100n, 25n),
      requestTerminalStatus: "succeeded",
    }));

    await createRequest(owner, leases, "req_provider_admission_rollback", "owner_provider_admission_rollback");
    await owner.prisma.$executeRawUnsafe(`
      CREATE FUNCTION "verification_fail_provider_admission"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'verification provider admission failure'; END $$
    `);
    await owner.prisma.$executeRawUnsafe(`
      CREATE TRIGGER "verification_fail_provider_admission"
      BEFORE INSERT ON "budget_claims"
      FOR EACH ROW EXECUTE FUNCTION "verification_fail_provider_admission"()
    `);
    try {
      await expectFailure(() => observeProviderAdmission(
        "protected.paygo.rollback",
        () => service.admit(admission("req_provider_admission_rollback", "owner_provider_admission_rollback", "candidate_provider_admission_rollback")),
      ));
    } finally {
      await owner.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "verification_fail_provider_admission" ON "budget_claims"`);
      await owner.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "verification_fail_provider_admission"()`);
    }
    assert(await owner.prisma.request_executions.count({ where: { request_id: "req_provider_admission_rollback" } }) === 0
      && await owner.prisma.request_provider_attempts.count({ where: { request_id: "req_provider_admission_rollback" } }) === 0
      && await owner.prisma.budget_claims.count({ where: { request_id: "req_provider_admission_rollback" } }) === 0
      && await owner.prisma.usage_reservations.count({ where: { request_id: "req_provider_admission_rollback" } }) === 0,
    "provider_admission_failure_rolls_back_execution_attempt_claim_and_reservation");

    const second = await service.admit(admission("req_2", "owner_2", "candidate_2"));
    await service.enterReconciliation({ providerAttemptId: second.providerAttemptId, outcome: "failed", failureClass: "timeout", costExposure: "accruing", finalUsageEvidence: "pending", reason: "ambiguous_dispatch" });
    const accruing = await owner.prisma.usage_reservations.findUniqueOrThrow({ where: { provider_attempt_id: second.providerAttemptId } });
    assert(accruing.status === "reconciling" && accruing.held_units === accruing.reservation_units, "accruing_keeps_hold");
    assert(await owner.prisma.budget_claims.count({ where: { provider_attempt_id: second.providerAttemptId } }) === 1, "accruing_keeps_claim");
    const accruingQuery = (await serviceQueries.listUnresolved()).find((row) => row.providerAttemptId === second.providerAttemptId);
    assert(accruingQuery?.heldUnits === accruing.reservation_units && accruingQuery.maxChargeUnits === 272n, "explicit_reconciliation_query");
    await service.settleFinalUsage({ providerAttemptId: second.providerAttemptId, outcome: "failed", failureClass: "timeout", usage: usage(100n, 0n) });
    assert(!(await serviceQueries.listUnresolved()).some((row) => row.providerAttemptId === second.providerAttemptId), "settled_attempt_leaves_reconciliation_query");

    await createRequest(owner, leases, "req_3", "owner_3");
    const third = await service.admit(admission("req_3", "owner_3", "candidate_3"));
    await leases.release({ requestId: "req_3", ownerId: "owner_3" });
    await leases.acquire({ requestId: "req_3", ownerId: "takeover", leaseTtlSeconds: 3_600 });
    await expectRelay("provider_invocation_ownership_lost", () => service.assertDispatchOwnership(third.providerAttemptId, "req_3", "owner_3"));
    const ownershipLoss = await owner.prisma.usage_reservations.findUniqueOrThrow({ where: { provider_attempt_id: third.providerAttemptId } });
    assert(ownershipLoss.status === "reconciling" && ownershipLoss.held_units > 0n, "ownership_loss_fail_closed");
    const ownershipLossExecution = await owner.prisma.request_executions.findUniqueOrThrow({ where: { request_id: "req_3" } });
    assert(ownershipLossExecution.status === "failed" && ownershipLossExecution.terminal_error_code === "execution_ownership_lost", "ownership_loss_terminates_execution");
    await service.settleFinalUsage({ providerAttemptId: third.providerAttemptId, outcome: "failed", usage: usage(100n, 0n) });

    await createRequest(owner, leases, "req_4", "owner_4");
    const fourth = await service.admit(admission("req_4", "owner_4", "candidate_4"));
    await service.enterReconciliation({ providerAttemptId: fourth.providerAttemptId, outcome: "failed", costExposure: "stopped", finalUsageEvidence: "pending", reason: "usage_pending" });
    const stoppedPending = await owner.prisma.usage_reservations.findUniqueOrThrow({ where: { provider_attempt_id: fourth.providerAttemptId } });
    assert(stoppedPending.status === "reconciling" && stoppedPending.held_units === 0n, "stopped_pending_releases_hold_only");
    assert(await owner.prisma.budget_claims.count({ where: { provider_attempt_id: fourth.providerAttemptId } }) === 1, "stopped_pending_keeps_claim");
    const stoppedPendingQuery = (await serviceQueries.listUnresolved()).find((row) => row.providerAttemptId === fourth.providerAttemptId);
    assert(stoppedPendingQuery?.costExposure === "stopped" && stoppedPendingQuery.heldUnits === 0n, "stopped_pending_visible_for_reconciliation");
    await expectRelay("provider_attempt_reconciliation_conflict", () => service.enterReconciliation({ providerAttemptId: fourth.providerAttemptId, outcome: "succeeded", costExposure: "stopped", finalUsageEvidence: "pending", reason: "invalid_terminal_rewrite" }));
    await expectRelay("provider_attempt_cost_exposure_conflict", () => service.enterReconciliation({ providerAttemptId: fourth.providerAttemptId, outcome: "failed", costExposure: "accruing", finalUsageEvidence: "pending", reason: "invalid_regression" }));
    await service.reconcileFinalUsage({
      providerAttemptId: fourth.providerAttemptId, outcome: "failed", failureClass: "non_retryable", usage: usage(100n, 0n),
      evidenceKind: "provider_billing_record", evidenceRef: "billing/verification/req_4",
      audit: { actor: { actorType: "user", actorId: "user_invocation" }, requestId: "req_owner_reconcile" },
    });
    const reconciliationAudit = await owner.prisma.audit_logs.findFirst({ where: { action: "provider_invocation.reconcile_final", resource_id: fourth.providerAttemptId } });
    assert(reconciliationAudit?.request_id === "req_owner_reconcile", "reconciliation_settlement_and_audit_atomic");
    assert(reconciliationAudit?.result === "success", "reconciliation_success_audit_result_explicit");
    assert(Object.keys(JSON.parse(reconciliationAudit!.metadata_json) as Record<string, unknown>).sort().join(",") === "actualChargeUnits,billingEventId,evidenceKind,evidenceRef,postingCreated,routePattern,usageSource", "reconciliation_success_audit_metadata_strict");
    await expectFailure(() => owner!.prisma.audit_logs.update({
      where: { id: reconciliationAudit!.id }, data: { result: "failure" },
    }));
    await expectFailure(() => owner!.prisma.audit_logs.delete({ where: { id: reconciliationAudit!.id } }));
    const reconciliationAuditAfterMutationAttempts = await owner.prisma.audit_logs.findUniqueOrThrow({
      where: { id: reconciliationAudit!.id },
    });
    assert(reconciliationAuditAfterMutationAttempts.result === "success"
      && reconciliationAuditAfterMutationAttempts.metadata_json === reconciliationAudit!.metadata_json,
    "audit_append_only_update_delete_triggers_preserve_original_row");

    await createRequest(owner, leases, "req_5", "owner_5");
    const fifth = await service.admit(admission("req_5", "owner_5", "candidate_5"));
    const released = await service.releaseNotStarted({ providerAttemptId: fifth.providerAttemptId, outcome: "failed", failureClass: "connect_error", requestTerminalStatus: "failed", requestTerminalErrorCode: "not_started" });
    assert(released.actualChargeUnits === 0n && released.postingLedgerEventId === null, "not_started_zero_usage");
    assert(await owner.prisma.credit_ledger_events.count({ where: { provider_attempt_id: fifth.providerAttemptId } }) === 0, "zero_usage_no_posting");
    assert((await owner.prisma.usage_reservations.findUniqueOrThrow({ where: { provider_attempt_id: fifth.providerAttemptId } })).status === "released", "not_started_releases_reservation");

    await createRequest(owner, leases, "req_6", "owner_6");
    const sixth = await service.admit(admission("req_6", "owner_6", "candidate_6"));
    await service.assertDispatchOwnership(sixth.providerAttemptId, "req_6", "owner_6");
    await service.settleFinalUsage({ providerAttemptId: sixth.providerAttemptId, outcome: "failed", failureClass: "upstream_5xx", usage: usage(100n, 10n) });
    const fallback = await observeProviderAdmission(
      "protected.paygo.fallback",
      () => service.admit(admission("req_6", "owner_6", "candidate_7", 1)),
    );
    assert(fallback.providerAttemptId !== sixth.providerAttemptId, "settled_attempt_allows_new_fallback_admission");
    await service.releaseNotStarted({ providerAttemptId: fallback.providerAttemptId, outcome: "failed", failureClass: "connect_error", requestTerminalStatus: "failed" });

    await owner.prisma.plans.update({ where: { id: "plan_invocation" }, data: { billing_mode: "prepaid" } });
    await createRequest(owner, leases, "req_prepaid", "owner_prepaid", "subscription_invocation_release");
    const prepaid = await observeProviderAdmission(
      "protected.prepaid.first",
      () => service.admit(admission("req_prepaid", "owner_prepaid", "candidate_prepaid", 0, {
        planSubscriptionId: "subscription_invocation_release",
        usageChargeAccountId: null,
      })),
    );
    assert(prepaid.usageReservationId === null && prepaid.reservationUnits === null, "prepaid_admission_has_no_paygo_reservation");
    await service.releaseNotStarted({ providerAttemptId: prepaid.providerAttemptId, outcome: "failed", failureClass: "non_retryable" });
    await owner.prisma.plans.update({ where: { id: "plan_invocation" }, data: { billing_mode: "paygo" } });

    await createRequest(owner, leases, "req_8", "owner_8");
    const eighth = await service.admit(admission("req_8", "owner_8", "candidate_9"));
    await service.assertDispatchOwnership(eighth.providerAttemptId, "req_8", "owner_8");
    await expectRelay("provider_attempt_previous_unsettled", () => service.admit(admission("req_8", "owner_8", "candidate_10", 1)));
    await expectRelay("provider_invocation_ownership_lost", () => service.assertDispatchOwnership(eighth.providerAttemptId, "req_8", "owner_8"));
    const repeatedDispatchExecution = await owner.prisma.request_executions.findUniqueOrThrow({ where: { request_id: "req_8" } });
    const repeatedDispatchReservation = await owner.prisma.usage_reservations.findUniqueOrThrow({ where: { provider_attempt_id: eighth.providerAttemptId } });
    assert(repeatedDispatchExecution.status === "failed" && repeatedDispatchExecution.terminal_error_code === "execution_ownership_lost", "repeat_dispatch_terminates_execution");
    assert(repeatedDispatchReservation.status === "reconciling" && repeatedDispatchReservation.held_units === repeatedDispatchReservation.reservation_units, "repeat_dispatch_keeps_hold");
    assert(await owner.prisma.budget_claims.count({ where: { provider_attempt_id: eighth.providerAttemptId } }) === 1, "repeat_dispatch_keeps_claim");
    await service.settleFinalUsage({ providerAttemptId: eighth.providerAttemptId, outcome: "failed", usage: usage(100n, 0n) });

    await createRequest(owner, leases, "req_9", "owner_9");
    const ninth = await service.admit(admission("req_9", "owner_9", "candidate_11"));
    await service.failRequestExecution("req_9", "owner_9", "fallback_admission_failed");
    const failedExecution = await owner.prisma.request_executions.findUniqueOrThrow({ where: { request_id: "req_9" } });
    assert(failedExecution.status === "failed" && failedExecution.terminal_error_code === "fallback_admission_failed", "explicit_execution_failure");
    const completeExecution = new CompleteRequestExecution();
    await owner.withPrismaTransaction((transaction) => completeExecution.execute(transaction, {
      requestId: "req_9", executionOwnerId: "owner_9", status: "failed",
      terminalErrorCode: "fallback_admission_failed", outputCommitted: false, completedAt: now,
    }));
    await expectRelay("request_execution_terminal_conflict", () => owner!.withPrismaTransaction((transaction) => completeExecution.execute(transaction, {
      requestId: "req_9", executionOwnerId: "owner_9", status: "failed",
      terminalErrorCode: "different_terminal_error", outputCommitted: false, completedAt: now,
    })));
    await service.releaseNotStarted({ providerAttemptId: ninth.providerAttemptId, outcome: "failed", failureClass: "non_retryable" });

    await createRequest(owner, leases, "req_7", "owner_7");
    const seventh = await service.admit(admission("req_7", "owner_7", "candidate_8"));
    const balanceBeforeFailedSettlement = (await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: "credit_invocation" } })).balance_snap_units;
    await owner.prisma.billing_provider_cost_events.create({ data: {
      id: "billing_provider_cost_collision", request_id: "req_7", provider_attempt_id: seventh.providerAttemptId,
      operation_kind: "inference", provider_owner_scope_ref: "global:", provider_id: "provider_invocation",
      provider_model_name: "model-invocation", provider_model_cost_id: "cost_invocation", cost_tier_key: "legacy_flat",
      cost_snapshot_json: "{}", input_tokens: 0n, cached_input_tokens: 0n, cache_write_tokens: 0n,
      output_tokens: 0n, amount: 0, amount_units: 0n, created_at: now,
    } });
    await expectFailure(() => service.settleFinalUsage({
      providerAttemptId: seventh.providerAttemptId, outcome: "succeeded", usage: usage(100n, 25n),
      requestTerminalStatus: "succeeded",
    }));
    const failedSettlementReservation = await owner.prisma.usage_reservations.findUniqueOrThrow({ where: { provider_attempt_id: seventh.providerAttemptId } });
    assert((await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: "credit_invocation" } })).balance_snap_units === balanceBeforeFailedSettlement, "failed_settlement_keeps_balance");
    assert(await owner.prisma.billing_events.count({ where: { request_id: "req_7" } }) === 0, "failed_settlement_rolls_back_billing_event");
    assert(await owner.prisma.billing_history_refs.count({ where: { request_id: "req_7" } }) === 0, "failed_settlement_rolls_back_history_ref");
    assert(await owner.prisma.provider_invocation_usage_facts.count({ where: { provider_attempt_id: seventh.providerAttemptId } }) === 0, "failed_settlement_rolls_back_usage");
    assert(await owner.prisma.budget_claims.count({ where: { provider_attempt_id: seventh.providerAttemptId } }) === 1, "failed_settlement_keeps_claim");
    assert(failedSettlementReservation.status === "active" && failedSettlementReservation.held_units === failedSettlementReservation.reservation_units, "failed_settlement_keeps_hold");

    await owner.prisma.provider_bindings.update({
      where: { provider_id: "provider_invocation" },
      data: { credential_ownership: "cpa-managed", credential_refs_json: "[\"opaque-runtime-ref\"]", revision: 2 },
    });
    const runtimeTarget = await new PostgresProviderRuntimeTargetReader(owner).loadAvailableTarget("provider_model_invocation");
    assert(runtimeTarget.providerModelId === "provider_model_invocation" && runtimeTarget.bindingRevision === 2, "provider_runtime_target_stable_read");
    assert(!JSON.stringify(runtimeTarget).includes("opaque-runtime-ref"), "provider_runtime_target_redacted");

    await createRequest(owner, leases, "req_cpa_basic_overdraft", "owner_cpa_basic_overdraft");
    await owner.prisma.credit_accounts.update({ where: { id: "credit_invocation" }, data: { balance_snap_units: 1n } });
    const cpaBasicOverdraft = await service.admitCpaBasic(cpaBasicAdmission("req_cpa_basic_overdraft", "attempt_cpa_basic_overdraft", "candidate_cpa_basic_overdraft"));
    await service.assertDispatchOwnership(cpaBasicOverdraft.providerAttemptId, "req_cpa_basic_overdraft", "owner_cpa_basic_overdraft");
    const cpaBasicOverdraftSettlement = await service.settleCpaBasicLive({
      providerAttemptId: cpaBasicOverdraft.providerAttemptId,
      outcome: "succeeded",
      outputCommitted: true,
      usage: usage(300n, 25n, "response"),
      requestTerminalStatus: "succeeded",
    });
    assert(cpaBasicOverdraftSettlement.actualChargeUnits === 650n && cpaBasicOverdraftSettlement.postingLedgerEventId !== null
      && (await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: "credit_invocation" } })).balance_snap_units === -649n,
    "cpa_basic_live_settlement_preserves_paygo_overdraft");
    await owner.prisma.credit_accounts.update({ where: { id: "credit_invocation" }, data: { balance_snap_units: 1n } });

    await createRequest(owner, leases, "req_cpa_basic_not_started_release", "owner_cpa_basic_not_started_release", "subscription_invocation_release", "user:user_invocation");
    const cpaBasicNotStartedRelease = await service.admitCpaBasic({
      ...cpaBasicAdmission("req_cpa_basic_not_started_release", "attempt_cpa_basic_not_started_release", "candidate_cpa_basic_not_started_release"),
      planSubscriptionId: "subscription_invocation_release",
    });
    await service.releaseNotStarted({
      providerAttemptId: cpaBasicNotStartedRelease.providerAttemptId,
      outcome: "failed",
      failureClass: "non_retryable",
      requestTerminalStatus: "failed",
      requestTerminalErrorCode: "non_retryable",
    });
    await owner.prisma.seller_settlement_events.create({ data: {
      id: "seller_settlement_cpa_basic_not_started", plan_subscription_id: "subscription_invocation_release", authority_purchase_id: null,
      seller_scope_ref: "global:", window_start: now, window_end: addSeconds(now, 2_592_000), release_at: addSeconds(now, 2_592_000),
      event_type: "revenue", amount_units: 1n, source_type: "verification", source_id: "cpa_basic_not_started", created_at: now,
    } });
    await verificationCommands.releaseDueSellerSettlements(addSeconds(now, 2_592_200));
    assert(await owner.prisma.seller_settlement_events.count({ where: {
      plan_subscription_id: "subscription_invocation_release", event_type: "release",
    } }) === 1, "seller_settlement_ignores_authoritative_cpa_basic_not_started_absent_attempt");

    await owner.prisma.credit_accounts.update({ where: { id: "credit_invocation" }, data: { balance_snap_units: 1_000_000_000n } });
    const budgetCollectionService = createRequestExecutionApplicationCapabilities(owner, { userPaygoConcurrencyLimit: 2 }).commands;
    await addBudgetCollection(owner, "one", 0, 1);
    await createRequest(owner, leases, "req_budget_collection_one", "owner_budget_collection_one");
    const budgetCollectionOne = await observeProviderAdmission(
      "protected.paygo.budget_collection_one",
      () => budgetCollectionService.admit(admission("req_budget_collection_one", "owner_budget_collection_one", "candidate_budget_collection_one")),
    );
    await budgetCollectionService.releaseNotStarted({ providerAttemptId: budgetCollectionOne.providerAttemptId, outcome: "failed", failureClass: "connect_error", requestTerminalStatus: "failed" });

    await addBudgetCollection(owner, "many", 1, 3);
    await createRequest(owner, leases, "req_budget_collection_many", "owner_budget_collection_many");
    const budgetCollectionMany = await observeProviderAdmission(
      "protected.paygo.budget_collection_many",
      () => budgetCollectionService.admit(admission("req_budget_collection_many", "owner_budget_collection_many", "candidate_budget_collection_many")),
    );
    await budgetCollectionService.releaseNotStarted({ providerAttemptId: budgetCollectionMany.providerAttemptId, outcome: "failed", failureClass: "connect_error", requestTerminalStatus: "failed" });

    assertFixedSqlStatementCount([
      ["protected.paygo.first", providerAdmissionSqlShapes["protected.paygo.first"]],
      ["protected.paygo.fallback", providerAdmissionSqlShapes["protected.paygo.fallback"]],
    ], "provider_admission_success_statement_count_fixed");
    assertFixedSqlShapes([
      ["protected.paygo.replay", providerAdmissionSqlShapes["protected.paygo.replay"]],
      ["protected.paygo.replay_after_routing_change", providerAdmissionSqlShapes["protected.paygo.replay_after_routing_change"]],
    ], "provider_admission_replay_sql_shape_fixed");
    assertFixedSqlShapes([
      ["protected.paygo.budget_collection_one", providerAdmissionSqlShapes["protected.paygo.budget_collection_one"]],
      ["protected.paygo.budget_collection_many", providerAdmissionSqlShapes["protected.paygo.budget_collection_many"]],
    ], "provider_admission_budget_collection_sql_shape_fixed");

    process.stdout.write(`${JSON.stringify({
      admissionAtomic: true,
      cpaBasicProviderAttemptPersisted: true,
      cpaBasicAtMostOnceDispatch: true,
      cpaBasicSameOwnerFallback: true,
      cpaBasicOwnerLossNoRedispatchOrFallback: true,
      cpaBasicClaimless: true,
      cpaBasicOwnerReconciliation: true,
      cpaBasicReconciliationRollbackAtomic: true,
      cpaBasicAdmissionDatabaseAuthoritative: true,
      cpaBasicAdmissionIdempotent: true,
      cpaBasicLiveSettlementAtomic: true,
      cpaBasicLiveSettlementIdempotent: true,
      cpaBasicFailedFinalSettlementAtomic: true,
      cpaBasicFailedFinalSettlementIdempotent: true,
      credentialFailureReasonAtomicAndImmutable: true,
      cpaBasicLiveSettlementRollbackAtomic: true,
      cpaBasicLiveSettlementRollbackOwnerReconcilable: true,
      cpaBasicPaygoOverdraft: true,
      cpaBasicSourceAuthorizationRevalidated: true,
      cpaBasicSellerSettlementDeferredWhileUnresolved: true,
      cpaBasicSellerSettlementReleasedForNotStartedAbsent: true,
      cpaBasicFrozenBillingProfiles: true,
      cpaBasicZeroCostFacts: true,
      cpaBasicNonzeroTierFacts: true,
      secretShapedEvidenceRejectedBeforeAudit: true,
      prismaTransactionWindowBeyondFiveSeconds: true,
      reservationUnits: first.reservationUnits?.toString(),
      integerChargeUnits: settled.actualChargeUnits.toString(),
      atomicBillingEvent: true,
      atMostOnceOwnership: true,
      leaseAcquireRenewLossTakeover: true,
      repeatDispatchRejected: true,
      unsettledFallbackRejected: true,
      ownershipLossTerminatesExecution: true,
      explicitExecutionFailure: true,
      terminalReplayExact: true,
      serviceTierFrozenFailClosed: true,
      admissionConflictRejected: true,
      idempotentReplayIgnoresLaterRoutingChange: true,
      settlementConflictRejected: true,
      settlementRollbackAtomic: true,
      settledFallbackAdmission: true,
      providerRuntimeTargetRedacted: true,
      auditAppendOnlyTriggers: true,
      unresolvedStates: ["accruing", "stopped_pending"],
      providerAdmissionSqlShapes,
      providerAdmissionDurationsMs,
      providerAdmissionTimingStagesClosed: Object.keys(providerAdmissionDurationsMs).sort(),
      zeroChargePosting: false,
    })}\n`);
  } finally {
    await owner?.close().catch(() => undefined);
    await runtime.cleanup();
  }
}

export function cpaBasicAdmission(
  requestId: string,
  providerAttemptId: string,
  candidateId: string,
  executionOwnerId = requestId.replace(/^req_/u, "owner_"),
  attemptIndex = 0,
): AdmitCpaBasicProviderInvocationCommand {
  return {
    providerAttemptId,
    requestId,
    executionOwnerId,
    attemptIndex,
    selectorAccessPointId: "ap_invocation",
    selectorId: "direct",
    selectorBehaviorVersion: 1,
    routingRevision: 1,
    candidateId,
    selectorTargetEdgeId: "edge_invocation",
    pathTargetEdgeIds: ["edge_invocation"],
    accessPointChainIds: ["ap_invocation"],
    providerId: "provider_invocation",
    providerModelName: "model-invocation",
    providerModelId: "provider_model_invocation",
    routingRevisions: [{ accessPointId: "ap_invocation", routingRevision: 1 }],
    requestedServiceTier: "standard",
    requireServiceTier: false,
    planId: "plan_invocation",
    planSubscriptionId: "subscription_invocation",
    apiKeyId: "key_invocation",
    userId: "user_invocation",
    usageChargeAccountId: "credit_invocation",
    billablePriceSource: "access_point",
    billablePriceId: "price_invocation",
    accessPointPriceIds: ["price_invocation"],
    providerModelCostId: "cost_invocation",
  };
}

function admission(
  requestId: string,
  executionOwnerId: string,
  candidateId: string,
  attemptIndex = 0,
  options: { planSubscriptionId?: string; usageChargeAccountId?: string | null } = {},
): AdmitProviderInvocationCommand {
  return {
    requestId, executionOwnerId, attemptIndex, selectorAccessPointId: "ap_invocation", selectorId: "direct",
    selectorBehaviorVersion: 1, routingRevision: 1, routingRevisions: [{ accessPointId: "ap_invocation", routingRevision: 1 }],
    candidateId, selectorTargetEdgeId: "edge_invocation", pathTargetEdgeIds: ["edge_invocation"], accessPointChainIds: ["ap_invocation"],
    providerModelId: "provider_model_invocation", providerId: "provider_invocation", providerModelName: "model-invocation",
    planId: "plan_invocation", planSubscriptionId: options.planSubscriptionId ?? "subscription_invocation",
    apiKeyId: "key_invocation", userId: "user_invocation", inputTokens: 100n, maxOutputTokens: 172n,
    tokenizerId: "cpa-verifier-tokenizer", tokenizerVersion: 1,
    preparationEvidenceId: `cpa-evidence:${requestId}:${candidateId}`, preparationEvidenceVersion: 1,
    preparedPayloadId: `cpa-payload:${requestId}:${candidateId}`, serviceTier: "standard", billablePriceSource: "access_point",
    billablePriceId: "price_invocation", providerModelCostId: "cost_invocation",
    accessPointPriceIds: ["price_invocation"], usageChargeAccountId: options.usageChargeAccountId === undefined ? "credit_invocation" : options.usageChargeAccountId,
  };
}

export function usage(inputTokens: bigint, outputTokens: bigint, source: "provider" | "response" = "provider") {
  return { inputTokens, cachedInputTokens: 0n, cacheWriteTokens: 0n, outputTokens, totalTokens: inputTokens + outputTokens, source };
}

export function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1_000).toISOString();
}

async function addBudgetCollection(owner: PostgresClientOwner, label: string, offset: number, count: number): Promise<void> {
  const planLimits = Array.from({ length: count }, (_, index) => ({
    id: `plan_limit_verification_${label}_${offset + index}`,
    plan_id: "plan_invocation",
    limit_scope: "subscription",
    metric: index % 2 === 0 ? "tokens" : "amount",
    limit_value: 1_000_000_000 - offset - index,
    limit_amount_units: index % 2 === 0 ? null : BigInt(1_000_000_000 - offset - index) * 1_000_000n,
    window_type: "cumulative",
    window_seconds: null,
    created_at: now,
  }));
  const policies = Array.from({ length: count }, (_, index) => ({
    id: `budget_policy_verification_${label}_${offset + index}`,
    metric: index % 2 === 0 ? "tokens" : "amount",
    limit_value: 1_000_000_000 - offset - index,
    limit_amount_units: index % 2 === 0 ? null : BigInt(1_000_000_000 - offset - index) * 1_000_000n,
    window_type: "rolling",
    window_seconds: 86_400,
    status: "enabled",
    created_at: now,
    updated_at: now,
  }));
  await owner.prisma.plan_budget_limits.createMany({ data: planLimits });
  await owner.prisma.budget_policies.createMany({ data: policies });
  await owner.prisma.scope_budget_policies.createMany({ data: policies.map((policy) => ({
    id: `scope_budget_policy_verification_${label}_${policy.id.slice(policy.id.lastIndexOf("_") + 1)}`,
    scope_ref: "key:key_invocation",
    budget_policy_id: policy.id,
    status: "enabled",
    created_at: now,
    updated_at: now,
  })) });
}

function assertFixedSqlShapes(entries: readonly (readonly [string, SqlShapeInventory | undefined])[], assertion: string): void {
  const baseline = entries[0]?.[1];
  assert(baseline !== undefined && entries.every(([, inventory]) => inventory !== undefined
    && inventory.statementCount === baseline.statementCount
    && inventory.shapeDigests.join("\u0000") === baseline.shapeDigests.join("\u0000")), assertion);
}

function assertFixedSqlStatementCount(entries: readonly (readonly [string, SqlShapeInventory | undefined])[], assertion: string): void {
  const baseline = entries[0]?.[1];
  assert(baseline !== undefined && entries.every(([, inventory]) => inventory !== undefined
    && inventory.statementCount === baseline.statementCount), assertion);
}

export async function createRequest(
  owner: PostgresClientOwner,
  leases: RequestExecutionLeasePort,
  requestId: string,
  executionOwnerId: string,
  planSubscriptionId: string | null = "subscription_invocation",
  billingScopeRef = "user:user_invocation",
  leaseTtlSeconds = 3_600,
): Promise<void> {
  await owner.prisma.request_logs.create({ data: {
    id: requestId, api_key_id: "key_invocation", user_id: "user_invocation",
    team_id: billingScopeRef.startsWith("team:") ? billingScopeRef.slice("team:".length) : null,
    plan_id: "plan_invocation", plan_subscription_id: planSubscriptionId, entry_access_point_id: "ap_invocation",
    billing_scope_ref: billingScopeRef, provider_id: "provider_invocation", request_path: "/v1/responses", ingress_hostname: null,
    req_model: "model-invocation", tar_model: "model-invocation", ingress_plugins_json: "[]",
    pipeline_plugins_json: "{\"schemaVersion\":1,\"planRevision\":\"verify\",\"invocations\":[]}",
    status: "started", error_code: null, started_at: now, ended_at: null,
  } });
  await leases.acquire({ requestId, ownerId: executionOwnerId, leaseTtlSeconds });
  await leases.renew({ requestId, ownerId: executionOwnerId, leaseTtlSeconds });
}

export async function seed(owner: PostgresClientOwner): Promise<void> {
  await owner.prisma.user_controls.create({ data: {
    id: "user_invocation", team_id: null, email: "invocation@example.invalid", password_hash: "disabled",
    auth_version: 1, status: "enabled", admin_note: null, api_key_limit: 3,
    user_can_create_custom_provider: 0, user_can_create_access_point: 0, created_at: now, updated_at: now,
  } });
  await owner.prisma.user_controls.create({ data: {
    id: "team_owner_invocation", team_id: null, email: "invocation-team-owner@example.invalid", password_hash: "disabled",
    auth_version: 1, status: "enabled", admin_note: null, api_key_limit: 3,
    user_can_create_custom_provider: 0, user_can_create_access_point: 0, created_at: now, updated_at: now,
  } });
  await owner.prisma.teams.create({ data: {
    id: "team_invocation", owner_id: "team_owner_invocation", name: "Invocation Team", status: "enabled",
    team_owner_can_manage_member_api_key_limit: 0, team_owner_can_manage_member_credit: 0,
    team_owner_can_create_custom_provider: 0, team_owner_can_create_access_point: 0,
    invite_email_domain_pattern: null, created_at: now, updated_at: now,
  } });
  await owner.prisma.team_memberships.create({ data: {
    id: "membership_invocation", team_id: "team_invocation", user_id: "user_invocation",
    roles_json: "[\"viewer\"]", by_invite_link: null, created_at: now, updated_at: now,
  } });
  await owner.prisma.api_keys.create({ data: {
    id: "key_invocation", user_id: "user_invocation", name: "Invocation Key", key_hash: "hash_invocation",
    key_prefix: "fr_inv", key_value: "disabled", status: "enabled",
    expires_at: null, revoked_at: null, created_at: now, updated_at: now,
  } });
  await owner.prisma.providers.create({ data: {
    id: "provider_invocation", owner_id: "user_invocation", scope_ref: "global:", name: "Invocation Provider", kind: "openai-compatible",
    status: "enabled", base_url_resolver: "fixed:https://example.invalid", credential_resolver: "api-key:verify",
    models_resolver: "static:model-invocation", config_json: "{}", cpa_instance_id: "cpa_default", created_at: now, updated_at: now,
  } });
  await owner.prisma.provider_bindings.create({ data: {
    provider_id: "provider_invocation", auth_method: "api-key", credential_ownership: "linked",
    credential_refs_json: "[]", credential_preview: null, revision: 1, sync_status: "ready",
    error_code: null, created_at: now, updated_at: now,
  } });
  await owner.prisma.provider_models.create({ data: { id: "provider_model_invocation", provider_id: "provider_invocation", provider_model_name: "model-invocation", display_name: "Invocation Model", status: "enabled", created_at: now, updated_at: now } });
  await owner.prisma.accessPoint.create({ data: {
    id: "ap_invocation", ownerId: "user_invocation", scopeRef: "global:", name: "Invocation AP", description: null,
    apiFamily: "openai-responses", exposedModel: "model-invocation", targetModel: "model-invocation",
    routingRuleId: "direct", routingRuleBehaviorVersion: 1, routingRuleConfigJson: "{}", routingRevision: 1,
    legacyTargetType: "provider-model", legacyTargetId: null, legacyTargetProviderId: "provider_invocation",
    legacyTargetProviderModelName: "model-invocation", priority: 100, weight: 1, fallbackOrder: 100,
    status: "enabled", removedAt: null, createdAt: now, updatedAt: now,
  } });
  await owner.prisma.accessPointTarget.create({ data: {
    id: "edge_invocation", accessPointId: "ap_invocation", targetType: "provider-model", targetAccessPointId: null,
    targetProviderId: "provider_invocation", targetProviderModelName: "model-invocation", targetProviderModelId: "provider_model_invocation", position: 0,
    status: "enabled", removedAt: null, createdAt: now, updatedAt: now,
  } });
  await owner.prisma.access_point_prices.create({ data: {
    id: "price_invocation", access_point_id: "ap_invocation", input_per_1m: 1, cached_input_per_1m: 1,
    cache_write_per_1m: 1, output_per_1m: 1, input_price_units_per_1m: 1_000_000n,
    cached_input_price_units_per_1m: 1_000_000n, cache_write_price_units_per_1m: 1_000_000n,
    output_price_units_per_1m: 1_000_000n, status: "enabled", created_at: now, updated_at: now,
  } });
  await owner.prisma.access_point_price_tiers.create({ data: {
    id: "price_tier_invocation_long", access_point_price_id: "price_invocation", service_tier: "standard",
    tier_key: "long_context", min_input_tokens: 200n, max_input_tokens: null,
    input_per_1m: 2, cached_input_per_1m: 2, cache_write_per_1m: 2, output_per_1m: 2,
    input_price_units_per_1m: 2_000_000n, cached_input_price_units_per_1m: 2_000_000n,
    cache_write_price_units_per_1m: 2_000_000n, output_price_units_per_1m: 2_000_000n,
    status: "enabled", created_at: now, updated_at: now,
  } });
  await owner.prisma.provider_model_costs.create({ data: {
    id: "cost_invocation", provider_id: "provider_invocation", provider_model_name: "model-invocation",
    input_per_1m: 0.5, cached_input_per_1m: 0.5, cache_write_per_1m: 0.5, output_per_1m: 0.5,
    input_price_units_per_1m: 500_000n, cached_input_price_units_per_1m: 500_000n,
    cache_write_price_units_per_1m: 500_000n, output_price_units_per_1m: 500_000n,
    source: "verify", status: "enabled", created_at: now, updated_at: now,
  } });
  await owner.prisma.provider_model_cost_tiers.create({ data: {
    id: "cost_tier_invocation_long", provider_model_cost_id: "cost_invocation", service_tier: "standard",
    tier_key: "long_context", min_input_tokens: 200n, max_input_tokens: null,
    input_per_1m: 1, cached_input_per_1m: 1, cache_write_per_1m: 1, output_per_1m: 1,
    input_price_units_per_1m: 1_000_000n, cached_input_price_units_per_1m: 1_000_000n,
    cache_write_price_units_per_1m: 1_000_000n, output_price_units_per_1m: 1_000_000n,
    status: "enabled", created_at: now, updated_at: now,
  } });
  await owner.prisma.plans.create({ data: {
    id: "plan_invocation", owner_id: "user_invocation", scope_ref: "global:", name: "Invocation Plan", version: 1,
    description: null, admin_note: null, billing_mode: "paygo", purchase_amount: 0, purchase_amount_units: 0n,
    duration_seconds: 0, plan_status: "enabled", catalog_status: "unlisted", created_at: now, updated_at: now,
  } });
  await owner.prisma.plan_access_points.create({ data: {
    id: "plan_ap_invocation", plan_id: "plan_invocation", access_point_id: "ap_invocation", created_at: now,
  } });
  await owner.prisma.credit_accounts.create({ data: {
    id: "credit_invocation", scope_ref: "user:user_invocation", status: "active", balance_snap_units: 1_000_000_000n,
    balance_snap_ledger_event_id: null, balance_snap_updated_at: null, created_at: now, updated_at: now,
  } });
  await owner.prisma.plan_subscriptions.create({ data: {
    id: "subscription_invocation", plan_id: "plan_invocation", source: "verify", scope_ref: "user:user_invocation",
    purchased_by_user_id: "user_invocation", funding_account_id: "credit_invocation", origin_card_id: null,
    priority: 100, effective_start: now, effective_end: null,
    subscription_lifecycle: "active", created_at: now, updated_at: now,
  } });
  await owner.prisma.plan_subscriptions.create({ data: {
    id: "subscription_invocation_other", plan_id: "plan_invocation", source: "verify", scope_ref: "user:user_invocation",
    purchased_by_user_id: "user_invocation", funding_account_id: "credit_invocation", origin_card_id: null,
    priority: 90, effective_start: now, effective_end: null,
    subscription_lifecycle: "active", created_at: now, updated_at: now,
  } });
  await owner.prisma.plan_subscriptions.create({ data: {
    id: "subscription_invocation_release", plan_id: "plan_invocation", source: "verify", scope_ref: "user:user_invocation",
    purchased_by_user_id: "user_invocation", funding_account_id: "credit_invocation", origin_card_id: null,
    priority: 80, effective_start: now, effective_end: null,
    subscription_lifecycle: "active", created_at: now, updated_at: now,
  } });
  await owner.prisma.plan_subscriptions.create({ data: {
    id: "subscription_invocation_foreign_user", plan_id: "plan_invocation", source: "verify", scope_ref: "user:team_owner_invocation",
    purchased_by_user_id: "team_owner_invocation", funding_account_id: null, origin_card_id: null,
    priority: 70, effective_start: now, effective_end: null,
    subscription_lifecycle: "active", created_at: now, updated_at: now,
  } });
  await owner.prisma.plan_subscriptions.create({ data: {
    id: "subscription_invocation_team", plan_id: "plan_invocation", source: "verify", scope_ref: "team:team_invocation",
    purchased_by_user_id: "team_owner_invocation", funding_account_id: null, origin_card_id: null,
    priority: 60, effective_start: now, effective_end: null,
    subscription_lifecycle: "active", created_at: now, updated_at: now,
  } });
}

async function expectRelay(code: string, callback: () => Promise<unknown>): Promise<void> {
  try { await callback(); } catch (error) { if (error instanceof RelayError && error.code === code) return; throw error; }
  throw new Error(`expected_relay_error:${code}`);
}

async function expectFailure(callback: () => Promise<unknown>): Promise<void> {
  try { await callback(); } catch { return; }
  throw new Error("expected_failure");
}

function assert(condition: boolean, name: string): asserts condition { if (!condition) throw new Error(`provider_invocation_assertion_failed:${name}`); }

async function waitForTcpPostgres(owner: PostgresClientOwner): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { await owner.health(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error("provider_invocation_postgres_tcp_not_ready");
}

function run(
  command: string,
  args: string[],
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: PostgresVerificationRuntime,
): string {
  const result = spawnSync(command, args, { cwd: packageRoot, env, input, encoding: "utf8", maxBuffer });
  if (result.status !== 0) {
    const detail = runtime?.redact([result.stdout, result.stderr].filter(Boolean).join("\n").trim()) ?? "";
    throw new Error(`${command}_failed:${result.status ?? "signal"}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout;
}
