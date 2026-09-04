import { appendFile, readFile, writeFile } from "node:fs/promises";
import { RelayError } from "@frely/core";
import type { RequestExecutionCommands } from "@frely/application/runtime";
import { createProviderInvocationVerificationCommands, createRequestExecutionApplicationCapabilities } from "@frely/application/internal/verification";
import { PostgresClientOwner } from "@frely/postgres/server";
import { assertRequestExecutionLeaseFreshForDispatch } from "@frely/request-execution";
import type { RequestExecutionLeasePort } from "@frely/request-execution/server";
import { createRequestExecutionLeaseCommands } from "@frely/request-execution/application-internal";
import {
  cpaBasicAdmission,
  createRequest,
  seed,
  usage,
} from "./provider-invocation-verification.js";

const requestId = "req_mod05_owner_loss";
const attemptId = "attempt_mod05_owner_loss";
const ownerA = "owner_mod05_a";
const ownerB = "owner_mod05_b";
const dispatchJournal = requireEnvironment("FRIDAY_RELAY_MOD05_DISPATCH_JOURNAL");
const ownerAReadyMarker = requireEnvironment("FRIDAY_RELAY_MOD05_OWNER_A_READY_MARKER");
const ownerBTakeoverMarker = requireEnvironment("FRIDAY_RELAY_MOD05_OWNER_B_TAKEOVER_MARKER");
const ownerAStaleMarker = requireEnvironment("FRIDAY_RELAY_MOD05_OWNER_A_STALE_MARKER");

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action !== "admit" && action !== "takeover") throw new Error("mod05_owner_loss_action_invalid");
  const owner = new PostgresClientOwner({
    connectionString: requireEnvironment("FRIDAY_RELAY_PG_CONNECTION_STRING"),
    max: 4,
  });
  try {
    if (action === "admit") await admitBeforeOwnerLoss(owner);
    else await proveTakeoverFailsClosed(owner);
  } finally {
    await owner.close();
  }
}

async function admitBeforeOwnerLoss(owner: PostgresClientOwner): Promise<void> {
  const leases = createRequestExecutionLeaseCommands(owner);
  const service = createRequestExecutionApplicationCapabilities(owner).commands;
  await seed(owner);
  await createRequest(owner, leases, requestId, ownerA, "subscription_invocation", "user:user_invocation", 5);
  const admitted = await service.admitCpaBasic(cpaBasicAdmission(
    requestId,
    attemptId,
    "candidate_mod05_owner_loss",
    ownerA,
  ));
  const [attempt, execution, lease] = await Promise.all([
    owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: admitted.providerAttemptId } }),
    owner.prisma.request_executions.findUniqueOrThrow({ where: { request_id: requestId } }),
    owner.prisma.request_execution_leases.findUniqueOrThrow({ where: { request_id: requestId } }),
  ]);
  assert(attempt.execution_owner_id === ownerA && execution.owner_id === ownerA && lease.owner_id === ownerA,
    "admission_freezes_same_owner");
  assert(attempt.cost_exposure === "not_started" && attempt.outcome === "pending", "admission_stops_before_dispatch");
  await service.assertDispatchOwnership(attemptId, requestId, ownerA);
  const assertedAttempt = await owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: attemptId } });
  assert(assertedAttempt.cost_exposure === "accruing" && assertedAttempt.outcome === "pending",
    "owner_a_commits_dispatch_assertion_before_pause");
  await writeFile(ownerAReadyMarker, `${JSON.stringify({ requestId, attemptId, owner: ownerA, leaseUntil: lease.lease_until })}\n`, { encoding: "utf8" });
  process.stdout.write(`${JSON.stringify({ phase: "dispatch_asserted", requestId, attemptId, owner: ownerA })}\n`);
  await waitForMarker(ownerBTakeoverMarker, "mod05_owner_b_takeover_marker_timeout");
  try {
    assertRequestExecutionLeaseFreshForDispatch(lease.lease_until);
  } catch (error) {
    if (!(error instanceof RelayError) || error.code !== "request_execution_lease_lost") throw error;
    await writeFile(ownerAStaleMarker, `${JSON.stringify({ requestId, attemptId, owner: ownerA, dispatches: 0 })}\n`, { encoding: "utf8" });
    process.stdout.write(`${JSON.stringify({ phase: "stale_owner_rejected", requestId, attemptId, owner: ownerA, dispatches: 0 })}\n`);
    return;
  }
  throw new Error("mod05_stale_owner_dispatch_permit_remained_fresh");
}

async function proveTakeoverFailsClosed(owner: PostgresClientOwner): Promise<void> {
  const leases = createRequestExecutionLeaseCommands(owner);
  const requestExecution = createRequestExecutionApplicationCapabilities(owner);
  const service = requestExecution.commands;
  const serviceQueries = requestExecution.queries;
  const verificationCommands = createProviderInvocationVerificationCommands(owner);
  await acquireAfterExpiry(leases);
  await leases.renew({ requestId, ownerId: ownerB, leaseTtlSeconds: 30 });

  await expectRelay("provider_invocation_ownership_lost", () => guardedDispatch(service, attemptId, requestId, ownerB));
  await expectRelay("provider_invocation_ownership_lost", () => guardedDispatch(service, attemptId, requestId, ownerB));
  await expectRelay("request_execution_conflict", () => service.admitCpaBasic(cpaBasicAdmission(
    requestId,
    "attempt_mod05_owner_loss_fallback",
    "candidate_mod05_owner_loss_fallback",
    ownerB,
    1,
  )));

  const [attempt, execution, attemptCount, billingBefore] = await Promise.all([
    owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: attemptId } }),
    owner.prisma.request_executions.findUniqueOrThrow({ where: { request_id: requestId } }),
    owner.prisma.request_provider_attempts.count({ where: { request_id: requestId } }),
    owner.prisma.billing_events.count({ where: { request_id: requestId } }),
  ]);
  assert(attemptCount === 1, "owner_loss_creates_no_fallback_attempt");
  assert(attempt.execution_owner_id === ownerA && attempt.cost_exposure === "accruing"
    && attempt.final_usage_evidence === "pending" && attempt.usage_settled === 0
    && attempt.reconciliation_reason === "execution_ownership_lost", "owner_loss_is_pending_reconciliation");
  assert(execution.status === "failed" && execution.terminal_error_code === "execution_ownership_lost",
    "owner_loss_terminal_arbitration");
  assert(billingBefore === 0, "owner_loss_does_not_finalize_billing");
  await writeFile(ownerBTakeoverMarker, `${JSON.stringify({ requestId, attemptId, owner: ownerB })}\n`, { encoding: "utf8" });
  await waitForMarker(ownerAStaleMarker, "mod05_stale_owner_result_timeout");

  await verificationCommands.finishRequestLog(requestId, "failed", "execution_ownership_lost");
  assert((await serviceQueries.listUnresolved()).some((row) => row.providerAttemptId === attemptId),
    "owner_loss_is_visible_to_reconciliation");
  const settlement = await service.reconcileFinalUsage({
    providerAttemptId: attemptId,
    outcome: "failed",
    failureClass: "non_retryable",
    usage: usage(0n, 0n),
    evidenceKind: "provider_billing_record",
    evidenceRef: "billing/verification/mod05-owner-loss",
    audit: { actor: { actorType: "user", actorId: "user_invocation" }, requestId: "req_mod05_owner_reconcile" },
  });
  assert(settlement.actualChargeUnits === 0n && settlement.postingLedgerEventId === null,
    "billing_owned_zero_finalization");
  const [finalAttempt, billingCount, usageCount, auditCount, ledgerCount] = await Promise.all([
    owner.prisma.request_provider_attempts.findUniqueOrThrow({ where: { id: attemptId } }),
    owner.prisma.billing_events.count({ where: { request_id: requestId } }),
    owner.prisma.provider_invocation_usage_facts.count({ where: { provider_attempt_id: attemptId } }),
    owner.prisma.audit_logs.count({ where: { request_id: "req_mod05_owner_reconcile" } }),
    owner.prisma.credit_ledger_events.count({ where: { provider_attempt_id: attemptId } }),
  ]);
  assert(finalAttempt.usage_settled === 1 && finalAttempt.final_usage_evidence === "final"
    && finalAttempt.cost_exposure === "stopped" && finalAttempt.reconciliation_reason === null,
  "reconciliation_converges_to_final");
  assert(billingCount === 1 && usageCount === 1 && auditCount === 1 && ledgerCount === 0,
    "reconciliation_commits_unique_billing_and_audit_facts");
  assert(!(await serviceQueries.listUnresolved()).some((row) => row.providerAttemptId === attemptId),
    "final_attempt_leaves_reconciliation");

  await proveJournalControl(owner, leases, service);
  process.stdout.write(`${JSON.stringify({
    phase: "takeover_verified",
    requestId,
    attemptId,
    originalOwner: ownerA,
    takeoverOwner: ownerB,
    lostRequestDispatches: 0,
    fallbackAttempts: 0,
    billingFacts: billingCount,
    usageFacts: usageCount,
  })}\n`);
}

async function proveJournalControl(
  owner: PostgresClientOwner,
  leases: RequestExecutionLeasePort,
  service: RequestExecutionCommands,
): Promise<void> {
  const controlRequestId = "req_mod05_dispatch_control";
  const controlAttemptId = "attempt_mod05_dispatch_control";
  const controlOwner = "owner_mod05_control";
  await createRequest(owner, leases, controlRequestId, controlOwner);
  await service.admitCpaBasic(cpaBasicAdmission(
    controlRequestId,
    controlAttemptId,
    "candidate_mod05_dispatch_control",
    controlOwner,
  ));
  const controlLease = await leases.renew({ requestId: controlRequestId, ownerId: controlOwner, leaseTtlSeconds: 30 });
  await guardedDispatch(service, controlAttemptId, controlRequestId, controlOwner, controlLease.leaseUntil);
  await service.settleCpaBasicLive({
    providerAttemptId: controlAttemptId,
    outcome: "succeeded",
    outputCommitted: true,
    usage: usage(0n, 0n),
    requestTerminalStatus: "succeeded",
  });
}

async function guardedDispatch(
  service: RequestExecutionCommands,
  providerAttemptId: string,
  guardedRequestId: string,
  executionOwnerId: string,
  leaseUntil?: string,
): Promise<void> {
  await service.assertDispatchOwnership(providerAttemptId, guardedRequestId, executionOwnerId);
  if (leaseUntil) assertRequestExecutionLeaseFreshForDispatch(leaseUntil);
  await appendFile(dispatchJournal, `${JSON.stringify({ requestId: guardedRequestId, providerAttemptId })}\n`, { encoding: "utf8" });
}

async function waitForMarker(path: string, code: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await readFile(path, "utf8")).trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(code);
}

async function acquireAfterExpiry(leases: RequestExecutionLeasePort): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await leases.acquire({ requestId, ownerId: ownerB, leaseTtlSeconds: 30 });
      return;
    } catch (error) {
      if (!(error instanceof RelayError) || error.code !== "request_execution_lease_conflict") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("mod05_owner_loss_lease_expiry_timeout");
}

async function expectRelay(code: string, callback: () => Promise<unknown>): Promise<void> {
  try {
    await callback();
  } catch (error) {
    if (error instanceof RelayError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected_relay_error:${code}`);
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`mod05_owner_loss_environment_missing:${name}`);
  return value;
}

function assert(condition: boolean, name: string): asserts condition {
  if (!condition) throw new Error(`mod05_owner_loss_assertion_failed:${name}`);
}

await main();
