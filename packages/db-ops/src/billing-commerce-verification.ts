import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "@frely/core";
import { AuthorityEntitlementApplicationService } from "@frely/application/application-internal";
import { createBillingCommerceVerificationServices } from "@frely/application/internal/operations";
import { PostgresClientOwner } from "@frely/postgres/server";
import { PostgresVerificationRuntime } from "./postgres-verification-runtime.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const postgresPackageRoot = join(packageRoot, "..", "postgres");
const prismaConfigPath = join(postgresPackageRoot, "prisma.config.ts");
const prismaBinPath = join(postgresPackageRoot, "node_modules", ".bin", "prisma");
const migrationsRoot = join(postgresPackageRoot, "prisma", "migrations");
const takeoverCheckpoint = "20260824004000_identity_migration_snapshot_consistency";
const migrationAnchor = "20260824005000_modernization_04_billing_kernel_closure";
const takeoverCheckpointChecksum = "92e382a0e3efb0fce5cb8e59c65e821cac9c1639c5961c125399fea9cc0f8831";
const migrationAnchorChecksum = "529d9fc18c0de6340f7a6fbd815eb1dfd0cce6b55ba851a675e7414cbd16b893";
const image = process.env.FRIDAY_RELAY_BILLING_COMMERCE_POSTGRES_IMAGE ?? "postgres:16-alpine";
const user = "friday_billing_commerce";
const password = "friday_billing_commerce_local_only";
const freshDatabase = "friday_billing_commerce_fresh";
const takeoverDatabase = "friday_billing_commerce_takeover";
const now = "2026-08-24T12:00:00.000Z";
const maxBuffer = 32 * 1024 * 1024;
const publishedHistoryChecksums = new Map<string, string>([
  ["20260824000000_repair_provider_attempt_mutable_fields", "79e2e53a39d00cd0536b0a6b2b36f193f13395a9c36dd3480dcf2d6039b091ca"],
  ["20260824001000_repair_provider_attempt_transition_function", "cc455e6eb4380926100eba76772f102d7dc823d3c2c520a83815e9699756bbf1"],
  ["20260824001100_provider_model_stable_routing_reference", "fb33b0aca09823a74fae8abcd3569232021320ad7b533472e1f90610b3a10104"],
  ["20260824001200_request_execution_stable_references", "f34f16d409d1ab3af9ed22d83b3f6a1d030df6b1d725b6fdc11aa8919006afa2"],
  ["20260824001300_reassert_provider_attempt_mutable_fields", "79e2e53a39d00cd0536b0a6b2b36f193f13395a9c36dd3480dcf2d6039b091ca"],
  ["20260824001400_reassert_provider_attempt_transition_function", "cc455e6eb4380926100eba76772f102d7dc823d3c2c520a83815e9699756bbf1"],
  ["20260824002000_add_cpa_basic_provider_attempt_contract", "e07ea467831dc7ec76a59073c143c87ae238abc2423d1579aa43408128e0ea74"],
  ["20260824002100_scope_provider_attempt_transition_trigger", "e8a032184cc4d3e2c86dbb7006f5d959fab57030c9bc45d209be48157984c2a3"],
]);

type Migration = { name: string; sql: string; checksum: string };
type MatrixCheckpoint = {
  protectedBinding: true;
  cpaBasicCompatibilityFixtureClaimless: true;
  creditLockOrder: true;
  creditCardPlanTopupStripe: true;
  authorityCommerce: true;
  servicePaidPendingBlockedRetry: true;
  concurrentIdempotency: true;
  rollbackAtomic: true;
  settlementIdempotent: true;
  appendOnlyFacts: true;
  creditLedgerFacts: number;
  stripeInboxFacts: number;
};

async function main(): Promise<void> {
  const migrations = await loadMigrations();
  const migrationHead = migrations.at(-1)?.name;
  assert(migrationHead !== undefined, "migration_lineage_empty");
  assert(migrations.find((migration) => migration.name === takeoverCheckpoint)?.checksum === takeoverCheckpointChecksum, "takeover_checkpoint_checksum_invalid");
  assert(migrations.find((migration) => migration.name === migrationAnchor)?.checksum === migrationAnchorChecksum, "migration_anchor_checksum_invalid");
  const checkpointIndex = migrations.findIndex((migration) => migration.name === takeoverCheckpoint);
  const anchorIndex = migrations.findIndex((migration) => migration.name === migrationAnchor);
  assert(checkpointIndex >= 0 && anchorIndex === checkpointIndex + 1, "takeover_checkpoint_order_invalid");
  const migrationSuffix = migrations.slice(anchorIndex + 1).map((migration) => migration.name);

  const runtime = await PostgresVerificationRuntime.start({
    verifier: "billing_commerce",
    databases: [freshDatabase, takeoverDatabase],
    docker: { image, user, password, containerPrefix: "friday-relay-billing-commerce" },
  });
  let primaryFailure: unknown;
  try {
    const freshUrl = runtime.connectionString(freshDatabase);
    prismaDeploy(freshUrl, runtime);
    assertExactMigrationHistory(runtime, freshDatabase, migrations);
    const freshHistoryBeforeNoop = migrationHistorySnapshot(runtime, freshDatabase);
    prismaDeploy(freshUrl, runtime);
    assert(migrationHistorySnapshot(runtime, freshDatabase) === freshHistoryBeforeNoop, "fresh_migration_history_rewritten");

    const prefix = migrations.slice(0, checkpointIndex + 1);
    for (const migration of prefix) runtime.executeSql(takeoverDatabase, migration.sql);
    runtime.executeSql(takeoverDatabase, prismaHistoryTableSql());
    for (const [index, migration] of prefix.entries()) runtime.executeSql(takeoverDatabase, successfulHistorySql(migration, index));
    runtime.executeSql(takeoverDatabase, historicalCompatibilityFixtureSql());
    const takeoverHistoricalBefore = historicalCompatibilitySnapshot(runtime, takeoverDatabase, false);
    const takeoverHistoryBeforeDeploy = migrationHistorySnapshot(runtime, takeoverDatabase);
    prismaDeploy(runtime.connectionString(takeoverDatabase), runtime);
    assertExactMigrationHistory(runtime, takeoverDatabase, migrations);
    assert(historicalCompatibilitySnapshot(runtime, takeoverDatabase, true) === takeoverHistoricalBefore, "takeover_historical_facts_rewritten");
    assert(migrationHistorySnapshot(runtime, takeoverDatabase).startsWith(takeoverHistoryBeforeDeploy), "takeover_migration_prefix_rewritten");
    const takeoverHistoryBeforeNoop = migrationHistorySnapshot(runtime, takeoverDatabase);
    prismaDeploy(runtime.connectionString(takeoverDatabase), runtime);
    assert(migrationHistorySnapshot(runtime, takeoverDatabase) === takeoverHistoryBeforeNoop, "takeover_migration_history_rewritten");

    const fresh = await runMatrix(runtime, freshDatabase);
    const takeover = await runMatrix(runtime, takeoverDatabase);
    assert(JSON.stringify(fresh) === JSON.stringify(takeover), "fresh_takeover_behavior_parity_failed");

    process.stdout.write(`${JSON.stringify({
      mode: runtime.mode,
      migrationHead,
      migrationCount: migrations.length,
      migrationAnchor: {
        name: migrationAnchor,
        checksum: migrationAnchorChecksum,
        immediatelyAfter: takeoverCheckpoint,
      },
      migrationSuffix,
      fresh: {
        fullMigration: true,
        exactCurrentLineage: true,
        migrationHistoryNonRewrite: true,
        matrix: fresh,
      },
      takeover: {
        prefix: takeoverCheckpoint,
        exactCurrentSuffixDeployed: true,
        historicalCompatibilityPreserved: true,
        migrationHistoryNonRewrite: true,
        matrix: takeover,
      },
      behaviorParity: true,
      stage1: {
        databaseCompatibilityFixture: "cpa-basic@1",
        claimlessRow: true,
        productionAdmissionEvidence: "provider-invocation-verifier-required",
      },
      stage2: {
        protectedPreparationBinding: "schema-enforced",
        productionActivationEvidence: "billing-commerce-boundary-gate-required",
      },
      composedEvidence: {
        providerInvocationVerifierRequired: true,
        takeoverVerifierRequired: true,
        billingCommerceBoundaryGateRequired: true,
      },
    })}\n`);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await runtime.cleanup();
    } catch (cleanupError) {
      if (primaryFailure) process.stderr.write("billing_commerce_verification_cleanup_failed\n");
      else throw cleanupError;
    }
  }
}

async function runMatrix(runtime: PostgresVerificationRuntime, database: string): Promise<MatrixCheckpoint> {
  const connectionString = runtime.connectionString(database);
  const owner = new PostgresClientOwner({ connectionString, max: 8 });
  const concurrentOwner = new PostgresClientOwner({ connectionString, max: 4 });
  try {
    await waitForPostgres(owner);
    await seedMatrix(owner);
    const services = createBillingCommerceVerificationServices(owner);
    const concurrentServices = createBillingCommerceVerificationServices(concurrentOwner);
    const commands = services.commands;
    const queries = services.queries;
    const application = services.application;
    const concurrentCommands = concurrentServices.commands;
    const authority = new AuthorityEntitlementApplicationService(owner);

    await verifyPreparationBinding(owner);

    const initialGrant = await commands.createAdminCreditLedgerEvent({
      scopeRef: "user:buyer_verify", eventType: "grant", amountUnits: 50_000_000,
      actorUserId: "owner_verify", reason: "billing-commerce verification grant",
    });
    const peerGrant = await commands.createAdminCreditLedgerEvent({
      scopeRef: "user:peer_verify", eventType: "grant", amountUnits: 5_000_000,
      actorUserId: "owner_verify", reason: "billing-commerce lock-order verification grant",
    });
    assert(initialGrant.account.balanceSnapUnits === 50_000_000 && peerGrant.account.balanceSnapUnits === 5_000_000, "credit_grant_invalid");
    await verifyCreditLockOrder({
      runtime,
      database,
      connectionString,
      owner,
      accountIds: [initialGrant.account.id, peerGrant.account.id],
      transferLeft: () => commands.transferCredit({
        fromAccountId: initialGrant.account.id,
        toAccountId: peerGrant.account.id,
        amountUnits: 100_000,
        actorUserId: "buyer_verify",
        transferId: "transfer_lock_order_left",
      }),
      transferRight: () => concurrentCommands.transferCredit({
        fromAccountId: peerGrant.account.id,
        toAccountId: initialGrant.account.id,
        amountUnits: 100_000,
        actorUserId: "peer_verify",
        transferId: "transfer_lock_order_right",
      }),
    });

    const creditProduct = await commands.createCreditProduct({
      code: "verify_credit", displayName: "Verification Credit", creditedAmountUnits: 3_000_000,
    });
    const grantedCard = await commands.grantAdminCard({
      cardType: "credit", senderUserId: "owner_verify", recipientUserId: "buyer_verify",
      creditProductId: creditProduct.id, referenceCode: "VERIFY-CREDIT", note: "verification",
    });
    const usedCreditCard = await application.useCard({ cardId: grantedCard.card.id, ownerUserId: "buyer_verify" });
    assert(usedCreditCard.cardType === "credit" && usedCreditCard.ledgerEvent.amountUnits === 3_000_000, "credit_card_use_invalid");

    const planPurchase = await application.purchasePlanCard({ planId: "plan_verify", buyerUserId: "buyer_verify", useImmediately: true });
    assert(planPurchase.subscription !== null && planPurchase.card.usedAt !== null && planPurchase.ledgerEvent.amountUnits === -2_000_000, "plan_card_purchase_invalid");

    const stripeChannel = await commands.createPaymentChannel({
      code: "verify_stripe", displayName: "Verification Stripe", paymentNetwork: "stripe", paymentAsset: "USD",
      settlementMode: "stripe_checkout", recipientIdentifierType: "other_account", transactionReferenceType: "order_id",
      recipientIdentifier: "verification-merchant", recipientIdentifierDisplay: "Verification merchant", createdByUserId: "owner_verify",
    });
    await commands.setPaymentChannelStatus(stripeChannel.id, "enabled");
    const stripeListing = await commands.createCreditProductListing({ productId: creditProduct.id, paymentChannelId: stripeChannel.id, priceAmountUnits: 5_000_000 });
    const stripeTopup = await commands.createUserCreditTopup({ userId: "buyer_verify", productListingId: stripeListing.id, idempotencyKey: "verify-stripe-topup", useImmediately: true });
    await commands.attachStripeCheckoutSession({ topupId: stripeTopup.id, checkoutSessionId: "cs_test_verify_topup" });
    const stripeCompleted = await application.completeStripeCreditTopup({
      topupId: stripeTopup.id, checkoutSessionId: "cs_test_verify_topup", paymentIntentId: "pi_test_verify_topup",
      amountUnits: 5_000_000, currency: "USD",
      webhookEvent: { eventId: "evt_verify_topup", eventType: "checkout.session.completed", livemode: false },
    });
    assert(stripeCompleted.topup.status === "fulfilled" && stripeCompleted.replayed === false && stripeCompleted.card?.usedAt !== null, "stripe_topup_invalid");
    const stripeReplay = await application.completeStripeCreditTopup({
      topupId: stripeTopup.id, checkoutSessionId: "cs_test_verify_topup", paymentIntentId: "pi_test_verify_topup",
      amountUnits: 5_000_000, currency: "USD",
      webhookEvent: { eventId: "evt_verify_topup", eventType: "checkout.session.completed", livemode: false },
    });
    assert(stripeReplay.replayed, "stripe_topup_not_idempotent");
    const failedStripeTopup = await commands.createUserCreditTopup({ userId: "buyer_verify", productListingId: stripeListing.id, idempotencyKey: "verify-stripe-failed-topup", useImmediately: true });
    await commands.attachStripeCheckoutSession({ topupId: failedStripeTopup.id, checkoutSessionId: "cs_test_verify_failed_topup" });
    const failedTerminal = await commands.recordStripeCreditTopupTerminal({
      topupId: failedStripeTopup.id, checkoutSessionId: "cs_test_verify_failed_topup", status: "payment_failed",
      webhookEvent: { eventId: "evt_verify_topup_failed", eventType: "checkout.session.async_payment_failed", livemode: false },
    });
    assert(failedTerminal.status === "payment_failed" && failedTerminal.paymentFailedAt !== null && failedTerminal.cardId === null && failedTerminal.ledgerEventId === null, "stripe_topup_failure_terminal_invalid");
    const failedReplay = await commands.recordStripeCreditTopupTerminal({
      topupId: failedStripeTopup.id, checkoutSessionId: "cs_test_verify_failed_topup", status: "payment_failed",
      webhookEvent: { eventId: "evt_verify_topup_failed", eventType: "checkout.session.async_payment_failed", livemode: false },
    });
    assert(failedReplay.id === failedTerminal.id && (await queries.getStripeWebhookEvent("evt_verify_topup_failed"))?.status === "succeeded", "stripe_topup_failure_replay_invalid");
    const failedPaidReplay = await application.completeStripeCreditTopup({
      topupId: failedStripeTopup.id, checkoutSessionId: "cs_test_verify_failed_topup", paymentIntentId: "pi_test_verify_failed_topup",
      amountUnits: 5_000_000, currency: "USD",
      webhookEvent: { eventId: "evt_verify_topup_failed_paid", eventType: "checkout.session.completed", livemode: false },
    });
    assert(failedPaidReplay.replayed && failedPaidReplay.topup.status === "payment_failed" && failedPaidReplay.card === null && failedPaidReplay.ledgerEvent === null, "stripe_topup_failed_success_reopen_invalid");
    const expiredStripeTopup = await commands.createUserCreditTopup({ userId: "buyer_verify", productListingId: stripeListing.id, idempotencyKey: "verify-stripe-expired-topup", useImmediately: true });
    await commands.attachStripeCheckoutSession({ topupId: expiredStripeTopup.id, checkoutSessionId: "cs_test_verify_expired_topup" });
    const expiredTerminal = await commands.recordStripeCreditTopupTerminal({
      topupId: expiredStripeTopup.id, checkoutSessionId: "cs_test_verify_expired_topup", status: "expired",
      webhookEvent: { eventId: "evt_verify_topup_expired", eventType: "checkout.session.expired", livemode: false },
    });
    assert(expiredTerminal.status === "expired" && expiredTerminal.expiredAt !== null && expiredTerminal.cardId === null && expiredTerminal.ledgerEventId === null, "stripe_topup_expiry_terminal_invalid");
    const expiredPaidReplay = await application.completeStripeCreditTopup({
      topupId: expiredStripeTopup.id, checkoutSessionId: "cs_test_verify_expired_topup", paymentIntentId: "pi_test_verify_expired_topup",
      amountUnits: 5_000_000, currency: "USD",
      webhookEvent: { eventId: "evt_verify_topup_expired_paid", eventType: "checkout.session.completed", livemode: false },
    });
    assert(expiredPaidReplay.replayed && expiredPaidReplay.topup.status === "expired" && expiredPaidReplay.card === null && expiredPaidReplay.ledgerEvent === null, "stripe_topup_expired_success_reopen_invalid");
    await commands.recordStripeWebhookIgnored({ eventId: "evt_verify_ignored", eventType: "customer.updated", livemode: false, reason: "unsupported_event" });
    assert((await queries.getStripeWebhookEvent("evt_verify_ignored"))?.status === "ignored", "stripe_inbox_ignored_invalid");

    const authorityProduct = await authority.createAuthorityProductVersion({
      code: "verify_team_unit", displayName: "Verification Team Unit", effectCode: "team_create_unit", grantUnits: 1,
      purchaseAmountUnits: 1_000_000n, grantDurationSeconds: 86_400, maxLifetimePurchasesPerUser: 10,
      maxUnconsumedUnitsPerUser: 10, maxCurrentOwnedTeams: 10, maxLifetimeCreatedTeams: 10,
      refundMode: "none", refundDeadlineSeconds: null, settlementHoldSeconds: 120,
      sellerScopeRef: "global:", actorOwnerUserId: "owner_verify",
    });
    await authority.listAuthorityProductVersion(authorityProduct.id, "owner_verify");
    const authorityPurchase = await authority.purchaseTeamCreationProduct({
      buyerUserId: "buyer_verify", productId: authorityProduct.id, idempotencyKey: "verify-authority-purchase",
    });
    const authorityReplay = await authority.purchaseTeamCreationProduct({
      buyerUserId: "buyer_verify", productId: authorityProduct.id, idempotencyKey: "verify-authority-purchase",
    });
    assert(!authorityPurchase.replayed && authorityReplay.replayed && authorityReplay.purchase.id === authorityPurchase.purchase.id, "authority_purchase_idempotency_invalid");

    const manualChannel = await commands.createPaymentChannel({
      code: "verify_manual", displayName: "Verification Manual", paymentNetwork: "bank", paymentAsset: "USD",
      settlementMode: "manual_review", recipientIdentifierType: "other_account", transactionReferenceType: "trade_number",
      recipientIdentifier: "verification-account", recipientIdentifierDisplay: "Verification account", createdByUserId: "owner_verify",
    });
    await commands.setPaymentChannelStatus(manualChannel.id, "enabled");
    const serviceProduct = await commands.createServiceProduct({
      code: "verify_partner", displayName: "Verification Partner", fulfillmentEffect: "partner_team_annual",
      durationSeconds: 31_536_000, partnerPlanId: "plan_verify", createdByUserId: "owner_verify",
    });
    const serviceListing = await commands.createServiceProductListing({
      productId: serviceProduct.id, paymentChannelId: manualChannel.id, priceAmountUnits: 8_000_000, createdByUserId: "owner_verify",
    });
    const serviceInput = {
      buyerUserId: "buyer_verify", productListingId: serviceListing.id,
      purchaseIntent: "new" as const, targetPartnerTeamId: null, idempotencyKey: "verify-service-order",
    };
    const [serviceLeft, serviceRight] = await Promise.all([
      commands.createServiceOrder(serviceInput),
      concurrentCommands.createServiceOrder(serviceInput),
    ]);
    assert(serviceLeft.id === serviceRight.id, "service_order_concurrent_idempotency_invalid");
    await pollUntil(async () => await owner.prisma.service_orders.count({ where: { id: serviceLeft.id } }) === 1, "service_order_concurrent_visibility_timeout");
    await commands.submitServiceOrderPayment({ orderId: serviceLeft.id, buyerUserId: "buyer_verify", transactionReference: "VERIFY-TXN-0001" });
    const paid = await commands.approveServiceOrder({ orderId: serviceLeft.id, ownerUserId: "owner_verify", confirmedReceivedAmountUnits: 8_000_000, reviewNote: "verified" });
    assert(paid.order.status === "paid" && paid.fulfillment.status === "pending" && paid.fulfillment.targetId === null, "service_paid_pending_invalid");

    runtime.executeSql(database, failPartnerAllocationTriggerSql());
    try {
      await expectRelay("service_fulfillment_blocked", () => application.retryServiceOrderFulfillment({ orderId: serviceLeft.id, ownerUserId: "owner_verify" }));
    } finally {
      runtime.executeSql(database, dropPartnerAllocationTriggerSql());
    }
    const blockedOrder = await queries.getServiceOrder(serviceLeft.id);
    const blockedFulfillment = (await queries.listServiceFulfillments()).find((item) => item.orderId === serviceLeft.id);
    assert(blockedOrder?.status === "paid" && blockedFulfillment?.status === "blocked" && blockedFulfillment.errorCode === "service_fulfillment_failed", "service_blocked_preserves_paid_invalid");
    const fulfilled = await application.retryServiceOrderFulfillment({ orderId: serviceLeft.id, ownerUserId: "owner_verify" });
    const fulfilledReplay = await application.retryServiceOrderFulfillment({ orderId: serviceLeft.id, ownerUserId: "owner_verify" });
    assert(fulfilled.order.status === "fulfilled" && fulfilled.fulfillment.status === "fulfilled" && fulfilledReplay.fulfillment.id === fulfilled.fulfillment.id, "service_explicit_retry_invalid");

    const rollbackCount = await owner.prisma.service_orders.count();
    runtime.executeSql(database, failAuditTriggerSql());
    try {
      await expectFailure(() => commands.createServiceOrder({ ...serviceInput, idempotencyKey: "verify-service-rollback" }));
    } finally {
      runtime.executeSql(database, dropAuditTriggerSql());
    }
    assert(await owner.prisma.service_orders.count() === rollbackCount, "service_order_audit_failure_not_rolled_back");

    const latestSettlementWindow = await owner.prisma.seller_settlement_windows.findFirst({
      where: { status: "open" },
      orderBy: { release_at: "desc" },
      select: { release_at: true },
    });
    assert(latestSettlementWindow !== null, "seller_settlement_window_missing");
    const settlementCutoff = addSeconds(latestSettlementWindow.release_at, 1);
    const released = await commands.releaseDueSellerSettlements(settlementCutoff);
    const releaseReplay = await commands.releaseDueSellerSettlements(settlementCutoff);
    assert(released.releasedWindows >= 2 && released.releasedUnits > 0 && releaseReplay.releasedWindows === 0 && releaseReplay.releasedUnits === 0, "seller_settlement_idempotency_invalid");

    const ledgerId = requireSafeIdentifier(initialGrant.ledgerEvent.id);
    const authorityPurchaseId = requireSafeIdentifier(authorityPurchase.purchase.id);
    const settlementId = requireSafeIdentifier((await owner.prisma.seller_settlement_events.findFirstOrThrow({ where: { event_type: "revenue" }, orderBy: { id: "asc" } })).id);
    expectSqlFailure(runtime, database, `UPDATE "credit_ledger_events" SET "reason" = 'rewrite' WHERE "id" = '${ledgerId}'`, "append-only");
    expectSqlFailure(runtime, database, `DELETE FROM "authority_purchases" WHERE "id" = '${authorityPurchaseId}'`, "append-only");
    expectSqlFailure(runtime, database, `DELETE FROM "seller_settlement_events" WHERE "id" = '${settlementId}'`, "append-only");

    const creditLedgerFacts = await owner.prisma.credit_ledger_events.count();
    const stripeInboxFacts = await owner.prisma.stripe_webhook_events.count();
    assert(creditLedgerFacts >= 8 && stripeInboxFacts === 6, "representative_fact_counts_invalid");
    return {
      protectedBinding: true,
      cpaBasicCompatibilityFixtureClaimless: true,
      creditLockOrder: true,
      creditCardPlanTopupStripe: true,
      authorityCommerce: true,
      servicePaidPendingBlockedRetry: true,
      concurrentIdempotency: true,
      rollbackAtomic: true,
      settlementIdempotent: true,
      appendOnlyFacts: true,
      creditLedgerFacts,
      stripeInboxFacts,
    };
  } finally {
    await Promise.all([owner.close().catch(() => undefined), concurrentOwner.close().catch(() => undefined)]);
  }
}

async function verifyCreditLockOrder(input: {
  runtime: PostgresVerificationRuntime;
  database: string;
  connectionString: string;
  owner: PostgresClientOwner;
  accountIds: [string, string];
  transferLeft: () => Promise<unknown>;
  transferRight: () => Promise<unknown>;
}): Promise<void> {
  const [firstAccountId] = [...input.accountIds].sort();
  assert(firstAccountId !== undefined, "credit_lock_order_account_missing");
  const before = await input.owner.prisma.credit_accounts.findMany({
    where: { id: { in: input.accountIds } },
    orderBy: { id: "asc" },
    select: { id: true, balance_snap_units: true },
  });
  assert(before.length === 2, "credit_lock_order_accounts_missing");
  const lockOwner = new PostgresClientOwner({ connectionString: input.connectionString, max: 2 });
  let releaseBlocker: (() => void) | undefined;
  let markBlockerReady: (() => void) | undefined;
  const blockerRelease = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const blockerReady = new Promise<void>((resolve) => { markBlockerReady = resolve; });
  const blocker = lockOwner.withPrismaTransaction(async (transaction) => {
    await transaction.$queryRawUnsafe(`SELECT "id" FROM "credit_accounts" WHERE "id" = $1 FOR UPDATE`, firstAccountId);
    markBlockerReady?.();
    await blockerRelease;
  });
  await blockerReady;
  const deadlocksBefore = Number(input.runtime.queryScalar(input.database, `SELECT "deadlocks"::text FROM "pg_stat_database" WHERE "datname" = current_database()`));
  const transfers = Promise.all([input.transferLeft(), input.transferRight()]);
  let waitFailure: unknown;
  try {
    await pollUntil(async () => Number(input.runtime.queryScalar(input.database, `
      SELECT count(*)::text FROM "pg_stat_activity"
      WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'
    `)) >= 2, "credit_lock_order_contention_missing");
  } catch (error) {
    waitFailure = error;
  } finally {
    releaseBlocker?.();
  }
  try {
    await blocker;
    await transfers;
  } finally {
    await lockOwner.close().catch(() => undefined);
  }
  if (waitFailure) throw waitFailure;
  const deadlocksAfter = Number(input.runtime.queryScalar(input.database, `SELECT "deadlocks"::text FROM "pg_stat_database" WHERE "datname" = current_database()`));
  const after = await input.owner.prisma.credit_accounts.findMany({
    where: { id: { in: input.accountIds } },
    orderBy: { id: "asc" },
    select: { id: true, balance_snap_units: true },
  });
  assert(Number.isSafeInteger(deadlocksBefore) && deadlocksAfter === deadlocksBefore, "credit_lock_order_deadlock_detected");
  assert(after.length === before.length && after.every((account, index) => (
    account.id === before[index]?.id && account.balance_snap_units === before[index]?.balance_snap_units
  )), "credit_lock_order_balance_not_conserved");
}

async function seedMatrix(owner: PostgresClientOwner): Promise<void> {
  await owner.prisma.user_controls.createMany({ data: [
    userData("owner_verify", "owner-verify@example.invalid"),
    userData("buyer_verify", "buyer-verify@example.invalid"),
    userData("peer_verify", "peer-verify@example.invalid"),
  ] });
  await owner.prisma.api_keys.create({ data: {
    id: "key_verify", user_id: "buyer_verify", name: "Verification key", key_hash: "verify_hash", key_prefix: "fr_verify",
    key_value: "disabled", status: "enabled", expires_at: null, revoked_at: null, created_at: now, updated_at: now,
  } });
  await owner.prisma.providers.create({ data: {
    id: "provider_verify", owner_id: "owner_verify", scope_ref: "global:", name: "Verification Provider", kind: "verification",
    status: "enabled", base_url_resolver: "fixed:https://example.invalid", credential_resolver: "api-key:verification",
    models_resolver: "static:verify-model", config_json: "{}", cpa_instance_id: "cpa_default", created_at: now, updated_at: now,
  } });
  await owner.prisma.provider_models.create({ data: {
    id: "provider_model_verify", provider_id: "provider_verify", provider_model_name: "verify-model",
    display_name: "Verification model", status: "enabled", created_at: now, updated_at: now,
  } });
  await owner.prisma.accessPoint.create({ data: {
    id: "ap_verify", ownerId: "owner_verify", scopeRef: "global:", name: "Verification AccessPoint", description: null,
    apiFamily: "openai-responses", exposedModel: "verify-model", targetModel: "verify-model", routingRuleId: "direct",
    routingRuleBehaviorVersion: 1, routingRuleConfigJson: "{}", routingRevision: 1, legacyTargetType: "provider-model",
    legacyTargetId: null, legacyTargetProviderId: "provider_verify", legacyTargetProviderModelName: "verify-model",
    priority: 100, weight: 1, fallbackOrder: 100, status: "enabled", removedAt: null, createdAt: now, updatedAt: now,
  } });
  await owner.prisma.accessPointTarget.create({ data: {
    id: "edge_verify", accessPointId: "ap_verify", targetType: "provider-model", targetAccessPointId: null,
    targetProviderId: "provider_verify", targetProviderModelName: "verify-model", targetProviderModelId: "provider_model_verify",
    position: 0, status: "enabled", removedAt: null, createdAt: now, updatedAt: now,
  } });
  await owner.prisma.plans.create({ data: {
    id: "plan_verify", owner_id: "owner_verify", scope_ref: "global:", name: "Verification Plan", version: 1,
    description: null, admin_note: null, billing_mode: "prepaid", purchase_amount: 2, purchase_amount_units: 2_000_000n,
    duration_seconds: 31_536_000, plan_status: "enabled", catalog_status: "listed", created_at: now, updated_at: now,
  } });
  await owner.prisma.plan_access_points.create({ data: { id: "plan_ap_verify", plan_id: "plan_verify", access_point_id: "ap_verify", created_at: now } });
  await owner.prisma.credit_accounts.create({ data: {
    id: "credit_binding_verify", scope_ref: "user:binding_verify", status: "active", balance_snap_units: 1_000n,
    balance_snap_ledger_event_id: null, balance_snap_updated_at: null, created_at: now, updated_at: now,
  } });
  await owner.prisma.plan_subscriptions.create({ data: {
    id: "subscription_binding_verify", plan_id: "plan_verify", source: "verification", scope_ref: "user:buyer_verify",
    purchased_by_user_id: "buyer_verify", funding_account_id: null, origin_card_id: null, priority: 100,
    effective_start: now, effective_end: addSeconds(now, 86_400), subscription_lifecycle: "active", created_at: now, updated_at: now,
  } });
  for (const id of ["req_binding_verify", "req_cpa_basic_verify", "req_cpa_basic_bound_verify"]) {
    await owner.prisma.request_logs.create({ data: {
      id, api_key_id: "key_verify", user_id: "buyer_verify", team_id: null, plan_id: "plan_verify",
      plan_subscription_id: "subscription_binding_verify", entry_access_point_id: "ap_verify", billing_scope_ref: "user:buyer_verify",
      provider_id: "provider_verify", request_path: "/v1/responses", ingress_hostname: null, req_model: "verify-model",
      tar_model: "verify-model", ingress_plugins_json: "[]", pipeline_plugins_json: "{\"schemaVersion\":1,\"planRevision\":\"verify\",\"invocations\":[]}",
      status: "started", error_code: null, started_at: now, ended_at: null,
    } });
  }
  await owner.prisma.request_executions.create({ data: {
    request_id: "req_binding_verify", status: "running", owner_id: "owner_attempt_binding_verify",
    attempt_count: 1, output_committed: 0, terminal_error_code: null, started_at: now,
    ended_at: null, selected_plan_subscription_id: "subscription_binding_verify",
  } });
}

async function verifyPreparationBinding(owner: PostgresClientOwner): Promise<void> {
  await expectFailure(() => owner.prisma.request_provider_attempts.create({ data: protectedAttemptData("attempt_missing_binding", "req_binding_verify", null) }));
  const protectedAttempt = await owner.prisma.request_provider_attempts.create({ data: protectedAttemptData("attempt_binding_verify", "req_binding_verify", {
    preparation_evidence_id: "evidence:verify", preparation_evidence_version: 1, prepared_payload_id: "payload:verify",
  }) });
  await expectFailure(() => owner.prisma.budget_claims.create({ data: {
    provider_attempt_id: protectedAttempt.id, request_id: protectedAttempt.request_id, plan_id: "plan_verify",
    plan_subscription_id: "subscription_binding_verify", api_key_id: "key_verify", user_id: "buyer_verify",
    max_total_tokens: 12n, max_charge_units: 10n, created_at: addSeconds(now, 1),
  } }));
  await owner.prisma.budget_claims.create({ data: {
    provider_attempt_id: protectedAttempt.id, request_id: protectedAttempt.request_id, plan_id: "plan_verify",
    plan_subscription_id: "subscription_binding_verify", api_key_id: "key_verify", user_id: "buyer_verify",
    max_total_tokens: 12n, max_charge_units: 10n, created_at: now,
  } });
  await expectFailure(() => owner.prisma.usage_reservations.create({ data: reservationData(protectedAttempt.id, { prepared_payload_id: "payload:mismatch" }) }));
  await owner.prisma.usage_reservations.create({ data: reservationData(protectedAttempt.id) });
  await expectFailure(() => owner.prisma.budget_claims.update({ where: { provider_attempt_id: protectedAttempt.id }, data: { max_charge_units: 11n } }));
  await expectFailure(() => owner.prisma.usage_reservations.delete({ where: { provider_attempt_id: protectedAttempt.id } }));

  const cpaBasic = await owner.prisma.request_provider_attempts.create({ data: cpaBasicAttemptData("attempt_cpa_basic_verify", "req_cpa_basic_verify", null) });
  await expectFailure(() => owner.prisma.request_provider_attempts.create({ data: cpaBasicAttemptData("attempt_cpa_basic_bound_verify", "req_cpa_basic_bound_verify", {
    preparation_evidence_id: "evidence:forbidden", preparation_evidence_version: 1, prepared_payload_id: "payload:forbidden",
  }) }));
  assert(await owner.prisma.budget_claims.count({ where: { provider_attempt_id: cpaBasic.id } }) === 0, "cpa_basic_claim_created");
  assert(await owner.prisma.usage_reservations.count({ where: { provider_attempt_id: cpaBasic.id } }) === 0, "cpa_basic_reservation_created");
}

function protectedAttemptData(id: string, requestId: string, binding: { preparation_evidence_id: string; preparation_evidence_version: number; prepared_payload_id: string } | null) {
  return {
    id, request_id: requestId, attempt_index: 0, selector_access_point_id: "ap_verify", selector_id: "direct",
    selector_behavior_version: 1, routing_revision: 1, candidate_id: `candidate_${id}`, selector_target_edge_id: "edge_verify",
    path_target_edge_ids_json: "[\"edge_verify\"]", access_point_chain_ids_json: "[\"ap_verify\"]",
    provider_id: "provider_verify", provider_model_id: "provider_model_verify", provider_model_name: "verify-model",
    outcome: "pending", failure_class: null, output_committed: 0, trusted_usage_source: null, started_at: now, ended_at: null,
    execution_owner_id: `owner_${id}`, admission_lease_until: addSeconds(now, 3_600), cost_exposure: "not_started",
    final_usage_evidence: "pending", usage_settled: 0, reconciliation_reason: null, invocation_contract: "protected@1",
    plan_subscription_id: null, api_key_id: null, user_id: null, usage_charge_account_id: null, require_service_tier: 0,
    billable_price_profile_json: null, provider_cost_profile_json: null, access_point_price_profiles_json: null,
    billable_price_source: "access_point", billable_price_id: "price_verify", billable_price_tier_key: "standard",
    billable_price_snapshot_json: "{}", routing_revisions_json: "[{\"accessPointId\":\"ap_verify\",\"routingRevision\":1}]",
    input_tokens: 5n, max_output_tokens: 7n, tokenizer_id: "cpa-tokenizer", tokenizer_version: 1,
    preparation_evidence_id: binding?.preparation_evidence_id ?? null,
    preparation_evidence_version: binding?.preparation_evidence_version ?? null,
    prepared_payload_id: binding?.prepared_payload_id ?? null,
    requested_service_tier: "standard", billing_scope_ref: "user:buyer_verify", plan_seller_scope_ref: "global:",
    plan_billing_mode: "prepaid", subscription_effective_start: now, provider_owner_scope_ref: "global:",
    provider_model_cost_id: "cost_verify", provider_cost_tier_key: "standard", provider_cost_snapshot_json: "{}",
    access_point_price_snapshots_json: "[]",
  };
}

function cpaBasicAttemptData(id: string, requestId: string, binding: { preparation_evidence_id: string; preparation_evidence_version: number; prepared_payload_id: string } | null) {
  return {
    ...protectedAttemptData(id, requestId, binding), invocation_contract: "cpa-basic@1",
    plan_subscription_id: "subscription_binding_verify", api_key_id: "key_verify", user_id: "buyer_verify", usage_charge_account_id: null,
    billable_price_profile_json: "{}", provider_cost_profile_json: "{}", access_point_price_profiles_json: "[{}]",
    billable_price_tier_key: null, billable_price_snapshot_json: null, input_tokens: null, max_output_tokens: null,
    tokenizer_id: null, tokenizer_version: null, provider_cost_tier_key: null, provider_cost_snapshot_json: null,
    access_point_price_snapshots_json: null,
  };
}

function reservationData(providerAttemptId: string, override: { prepared_payload_id?: string } = {}) {
  return {
    id: "reservation_binding_verify", provider_attempt_id: providerAttemptId, request_id: "req_binding_verify",
    credit_account_id: "credit_binding_verify", plan_subscription_id: "subscription_binding_verify", user_id: "buyer_verify",
    status: "active", reservation_units: 10n, held_units: 10n, input_tokens: 5n, max_output_tokens: 7n,
    tokenizer_id: "cpa-tokenizer", tokenizer_version: 1, preparation_evidence_id: "evidence:verify",
    preparation_evidence_version: 1, prepared_payload_id: override.prepared_payload_id ?? "payload:verify", service_tier: "standard",
    billable_price_source: "access_point", billable_price_id: "price_verify", billable_price_tier_key: "standard",
    price_snapshot_json: "{}", posting_ledger_event_id: null, created_at: now, updated_at: now,
  };
}

function historicalCompatibilityFixtureSql(): string {
  return `
    SET session_replication_role = replica;
    INSERT INTO "request_provider_attempts" (
      "id", "request_id", "attempt_index", "selector_access_point_id", "selector_id", "selector_behavior_version",
      "routing_revision", "candidate_id", "selector_target_edge_id", "path_target_edge_ids_json", "access_point_chain_ids_json",
      "provider_id", "provider_model_id", "provider_model_name", "outcome", "failure_class", "output_committed",
      "trusted_usage_source", "started_at", "ended_at", "execution_owner_id", "admission_lease_until", "cost_exposure",
      "final_usage_evidence", "usage_settled", "reconciliation_reason", "invocation_contract", "plan_subscription_id",
      "api_key_id", "user_id", "usage_charge_account_id", "require_service_tier", "billable_price_profile_json",
      "provider_cost_profile_json", "access_point_price_profiles_json", "billable_price_source", "billable_price_id",
      "billable_price_tier_key", "billable_price_snapshot_json", "routing_revisions_json", "input_tokens", "max_output_tokens",
      "tokenizer_id", "tokenizer_version", "requested_service_tier", "billing_scope_ref", "plan_seller_scope_ref",
      "plan_billing_mode", "subscription_effective_start", "provider_owner_scope_ref", "provider_model_cost_id",
      "provider_cost_tier_key", "provider_cost_snapshot_json", "access_point_price_snapshots_json"
    ) VALUES (
      'attempt_historical_mod04', 'request_historical_mod04', 0, 'ap_historical_mod04', 'direct', 1,
      1, 'candidate_historical_mod04', 'edge_historical_mod04', '[]', '[]',
      'provider_historical_mod04', 'provider_model_historical_mod04', 'historical-model', 'pending', NULL, 0,
      NULL, '${now}', NULL, 'owner_historical_mod04', '${addSeconds(now, 3600)}', 'not_started',
      'pending', 0, NULL, 'protected@1', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL,
      'access_point', 'price_historical_mod04', 'standard', '{}', '[]', 0, 0, 'historical-tokenizer', 1,
      'standard', 'global:', 'global:', 'prepaid', '${now}', 'global:', 'cost_historical_mod04', 'standard', '{}', '[]'
    );
    INSERT INTO "budget_claims" VALUES (
      'attempt_historical_mod04', 'request_historical_mod04', 'plan_historical_mod04', 'subscription_historical_mod04',
      'key_historical_mod04', 'user_historical_mod04', 1, 0, '${now}'
    );
    INSERT INTO "usage_reservations" (
      "id", "provider_attempt_id", "request_id", "credit_account_id", "plan_subscription_id", "user_id", "status",
      "reservation_units", "held_units", "input_tokens", "max_output_tokens", "tokenizer_id", "tokenizer_version",
      "service_tier", "billable_price_source", "billable_price_id", "billable_price_tier_key", "price_snapshot_json",
      "posting_ledger_event_id", "created_at", "updated_at"
    ) VALUES (
      'reservation_historical_mod04', 'attempt_historical_mod04', 'request_historical_mod04', 'credit_historical_mod04',
      'subscription_historical_mod04', 'user_historical_mod04', 'active', 0, 0, 0, 0, 'historical-tokenizer', 1,
      'standard', 'access_point', 'price_historical_mod04', 'standard', '{}', NULL, '${now}', '${now}'
    );
    SET session_replication_role = origin;
  `;
}

function historicalCompatibilitySnapshot(runtime: PostgresVerificationRuntime, database: string, migrated: boolean): string {
  const attempt = migrated
    ? `to_jsonb(attempt) - ARRAY['preparation_evidence_id','preparation_evidence_version','prepared_payload_id','failure_reason']`
    : "to_jsonb(attempt)";
  const reservation = migrated
    ? `to_jsonb(reservation) - ARRAY['preparation_evidence_id','preparation_evidence_version','prepared_payload_id']`
    : "to_jsonb(reservation)";
  return runtime.queryScalar(database, `
    SELECT jsonb_build_object(
      'attempt', ${attempt},
      'claim', to_jsonb(claim),
      'reservation', ${reservation}
    )::text
    FROM "request_provider_attempts" attempt
    JOIN "budget_claims" claim ON claim."provider_attempt_id" = attempt."id"
    JOIN "usage_reservations" reservation ON reservation."provider_attempt_id" = attempt."id"
    WHERE attempt."id" = 'attempt_historical_mod04'
  `);
}

async function loadMigrations(): Promise<Migration[]> {
  const names = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(join(migrationsRoot, name, "migration.sql"), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

function prismaDeploy(connectionString: string, runtime: PostgresVerificationRuntime): void {
  const result = spawnSync("bun", [prismaBinPath, "migrate", "deploy", "--config", prismaConfigPath], {
    cwd: packageRoot,
    env: { ...process.env, FRIDAY_RELAY_PG_CONNECTION_STRING: connectionString },
    encoding: "utf8",
    maxBuffer,
  });
  if (result.status !== 0) {
    const detail = runtime.redact([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
    throw new Error(`billing_commerce_prisma_deploy_failed:${result.status ?? "signal"}${detail ? `\n${detail}` : ""}`);
  }
}

function assertExactMigrationHistory(runtime: PostgresVerificationRuntime, database: string, migrations: readonly Migration[]): void {
  const rows = runtime.queryScalar(database, `
    SELECT string_agg("migration_name" || ':' || "checksum", E'\\n' ORDER BY "migration_name")
    FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
  `);
  const expected = migrations.map((migration) => `${migration.name}:${publishedHistoryChecksums.get(migration.name) ?? migration.checksum}`).join("\n");
  assert(rows === expected, "exact_migration_history_invalid");
  const anchor = runtime.queryScalar(database, `SELECT "checksum" FROM "_prisma_migrations" WHERE "migration_name" = '${migrationAnchor}' AND "finished_at" IS NOT NULL`);
  assert(anchor === migrationAnchorChecksum, "migration_anchor_history_checksum_invalid");
  const migrationHead = migrations.at(-1);
  assert(migrationHead !== undefined, "migration_lineage_empty");
  const head = runtime.queryScalar(database, `SELECT "checksum" FROM "_prisma_migrations" WHERE "migration_name" = '${migrationHead.name}' AND "finished_at" IS NOT NULL`);
  assert(head === (publishedHistoryChecksums.get(migrationHead.name) ?? migrationHead.checksum), "migration_head_history_checksum_invalid");
}

function migrationHistorySnapshot(runtime: PostgresVerificationRuntime, database: string): string {
  return runtime.queryScalar(database, `
    SELECT string_agg(to_jsonb(migration)::text, E'\\n' ORDER BY "migration_name")
    FROM "_prisma_migrations" migration WHERE "rolled_back_at" IS NULL
  `);
}

function prismaHistoryTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" varchar(36) PRIMARY KEY NOT NULL, "checksum" varchar(64) NOT NULL, "finished_at" timestamptz,
    "migration_name" varchar(255) NOT NULL, "logs" text, "rolled_back_at" timestamptz,
    "started_at" timestamptz NOT NULL DEFAULT now(), "applied_steps_count" integer NOT NULL DEFAULT 0
  )`;
}

function successfulHistorySql(migration: Migration, index: number): string {
  const minute = String(index).padStart(2, "0");
  const idSuffix = String(index + 1).padStart(12, "0");
  const checksum = publishedHistoryChecksums.get(migration.name) ?? migration.checksum;
  return `INSERT INTO "_prisma_migrations" (
    "id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count"
  ) VALUES (
    '00000000-0000-4000-8000-${idSuffix}', '${checksum}', '2026-08-24T00:${minute}:00.000Z',
    '${migration.name}', NULL, NULL, '2026-08-24T00:${minute}:00.000Z', 1
  )`;
}

function failPartnerAllocationTriggerSql(): string {
  return `
    CREATE OR REPLACE FUNCTION "verification_block_partner_allocation"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'verification partner allocation blocked'; END $$;
    CREATE TRIGGER "verification_block_partner_allocation" BEFORE INSERT ON "partner_team_creation_allocations"
    FOR EACH ROW EXECUTE FUNCTION "verification_block_partner_allocation"();
  `;
}
function dropPartnerAllocationTriggerSql(): string {
  return `DROP TRIGGER IF EXISTS "verification_block_partner_allocation" ON "partner_team_creation_allocations";
    DROP FUNCTION IF EXISTS "verification_block_partner_allocation"()`;
}
function failAuditTriggerSql(): string {
  return `
    CREATE OR REPLACE FUNCTION "verification_block_audit_append"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'verification audit append blocked'; END $$;
    CREATE TRIGGER "verification_block_audit_append" BEFORE INSERT ON "audit_logs"
    FOR EACH ROW EXECUTE FUNCTION "verification_block_audit_append"();
  `;
}
function dropAuditTriggerSql(): string {
  return `DROP TRIGGER IF EXISTS "verification_block_audit_append" ON "audit_logs";
    DROP FUNCTION IF EXISTS "verification_block_audit_append"()`;
}

function expectSqlFailure(runtime: PostgresVerificationRuntime, database: string, sql: string, expected: string): void {
  const result = runtime.psqlResult(database, ["-v", "ON_ERROR_STOP=1", "-c", sql]);
  const detail = runtime.redact([result.stdout, result.stderr].filter(Boolean).join("\n"));
  assert(result.status !== 0 && detail.includes(expected), "expected_physical_rejection_missing");
}

async function expectRelay(code: string, callback: () => Promise<unknown>): Promise<void> {
  try {
    await callback();
  } catch (error) {
    if (error instanceof RelayError && error.code === code) return;
    throw error;
  }
  throw new Error(`billing_commerce_expected_relay_error:${code}`);
}

async function expectFailure(callback: () => Promise<unknown>): Promise<void> {
  try {
    await callback();
  } catch {
    return;
  }
  throw new Error("billing_commerce_expected_failure");
}

async function pollUntil(predicate: () => Promise<boolean>, errorCode: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(errorCode);
}

async function waitForPostgres(owner: PostgresClientOwner): Promise<void> {
  await pollUntil(async () => {
    try {
      await owner.health();
      return true;
    } catch {
      return false;
    }
  }, "billing_commerce_postgres_not_ready");
}

function userData(id: string, email: string) {
  return {
    id, team_id: null, email, password_hash: "disabled", auth_version: 1, status: "enabled", admin_note: null,
    api_key_limit: 3, user_can_create_custom_provider: 0, user_can_create_access_point: 0, created_at: now, updated_at: now,
  };
}
function addSeconds(value: string, seconds: number): string { return new Date(Date.parse(value) + seconds * 1_000).toISOString(); }
function requireSafeIdentifier(value: string): string {
  assert(/^[a-z0-9_-]+$/u.test(value), "unsafe_fixture_identifier");
  return value;
}
function assert(condition: boolean, name: string): asserts condition {
  if (!condition) throw new Error(`billing_commerce_assertion_failed:${name}`);
}

await main();
