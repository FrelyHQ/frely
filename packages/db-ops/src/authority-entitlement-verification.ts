import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorityEntitlementApplicationService } from "@frely/application/application-internal";
import { createAuthorityContext } from "@frely/authority/application-internal";
import type { AuthorityCommands, AuthorityQueries } from "@frely/authority/server";
import { RelayError } from "@frely/core";
import { PostgresClientOwner } from "@frely/postgres/server";
import { PostgresVerificationRuntime } from "./postgres-verification-runtime.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const postgresPackageRoot = join(packageRoot, "..", "postgres");
const prismaConfigPath = join(postgresPackageRoot, "prisma.config.ts");
const prismaBinPath = join(postgresPackageRoot, "node_modules", ".bin", "prisma");
const image = process.env.FRIDAY_RELAY_AUTHORITY_ENTITLEMENT_POSTGRES_IMAGE ?? "postgres:16-alpine";
const user = "friday_authority_entitlement";
const password = "friday_authority_entitlement_local_only";
const database = "friday_authority_entitlement";
const maximumCommandOutputBytes = 32 * 1024 * 1024;
const fixtureAt = "2000-01-01T00:00:00.000Z";
const invalidRequestId = "invalid request id";

const userIds = {
  bootstrapA: "verify_owner_a",
  bootstrapB: "verify_owner_b",
  nextOwner: "verify_owner_next",
  disabledOwner: "verify_owner_disabled",
  primaryBuyer: "verify_buyer_primary",
  raceBuyer: "verify_buyer_race",
  cancelBuyer: "verify_buyer_cancel",
  refundBuyer: "verify_buyer_refund",
  refundRollbackBuyer: "verify_buyer_refund_rollback",
  purchaseRollbackBuyer: "verify_buyer_purchase_rollback",
  teamRollbackBuyer: "verify_buyer_team_rollback",
  providerBuyer: "verify_buyer_provider",
  providerRollbackBuyer: "verify_buyer_provider_rollback",
  planBuyer: "verify_buyer_plan",
  fundedRollbackBuyer: "verify_buyer_funded_rollback",
} as const;

const teamIds = {
  providerPurchase: "verify_team_provider_purchase",
  providerPurchaseRollback: "verify_team_provider_purchase_rollback",
  providerAdmin: "verify_team_provider_admin",
  providerAdminRollback: "verify_team_provider_admin_rollback",
  providerNone: "verify_team_provider_none",
  providerPermanent: "verify_team_provider_permanent",
  partner: "verify_team_partner",
} as const;

interface VerificationSection {
  readonly passed: true;
  readonly checks: readonly string[];
}

async function main(): Promise<void> {
  const runtime = await PostgresVerificationRuntime.start({
    verifier: "authority_entitlement",
    databases: [database],
    docker: { image, user, password, containerPrefix: "friday-relay-authority-entitlement" },
  });
  let owner: PostgresClientOwner | undefined;
  let report: object | undefined;
  try {
    const connectionString = runtime.connectionString(database);
    run("bun", [prismaBinPath, "migrate", "deploy", "--config", prismaConfigPath], undefined, {
      ...process.env,
      FRIDAY_RELAY_PG_CONNECTION_STRING: connectionString,
    }, runtime);
    owner = new PostgresClientOwner({
      connectionString,
      max: 16,
      applicationName: "friday-relay-authority-entitlement-verification",
      lockTimeoutMillis: 10_000,
    });
    await owner.health();
    await seedDeterministicFixtures(owner);

    const authorityCapabilities = createAuthorityContext(owner);
    const authority = authorityCapabilities.commands as AuthorityCommands;
    const authorityQueries = authorityCapabilities.queries as AuthorityQueries;
    const application = new AuthorityEntitlementApplicationService(owner);
    const bootstrap = await verifyBootstrapHandoverAndOwnerCancellation(owner, authority, authorityQueries, application);
    const products = await createVerificationProducts(application, bootstrap.currentOwnerUserId);
    const grantAndQuota = await verifyGrantQuotaUseAndApplicationPurchase(owner, authority, application, products);
    const planSubscription = await verifyPlanAndSubscription(owner, application, bootstrap.currentOwnerUserId);
    const providerPartner = await verifyTeamProviderAndPartnerDecisions(
      owner,
      application,
      products.providerProductId,
      bootstrap.currentOwnerUserId,
    );
    const refund = await verifyRefundApplicationTransaction(
      owner,
      application,
      products.teamCreateProductId,
      bootstrap.currentOwnerUserId,
    );
    const personalProviderSlots = await verifyPersonalProviderSlots(owner, application, products.personalProviderProductId);
    const rollback = await verifyRollbackAtomicity(
      owner,
      application,
      products.rollbackProductId,
      products.teamCreateProductId,
      products.providerProductId,
      bootstrap.currentOwnerUserId,
    );
    const physical = await verifyPhysicalConstraintsAndAppendOnlyTriggers(
      owner,
      grantAndQuota.purchaseId,
      grantAndQuota.grantId,
      grantAndQuota.quotaId,
      grantAndQuota.useId,
    );
    const compatibility = await verifyCompatibilityOnlyDecisions(owner, application);
    const audit = await verifyAuditPostconditions(owner);

    report = {
      verifier: "authority_entitlement",
      runtimeMode: runtime.mode,
      migration: "deployed",
      evidence: {
        grantUniquenessAndIdempotency: section([
          "bootstrap_concurrent_single_winner",
          "bootstrap_exact_replay",
          "second_owner_domain_rejection",
          "purchase_grant_quota_exact_replay",
          "purchase_changed_product_idempotency_conflict_without_extra_purchase_grant_quota",
          "purchase_financial_and_authority_single_facts",
          "direct_grant_quota_unique_facts_rejected",
        ]),
        quotaAndUse: section([
          "team_create_exact_replay",
          "team_create_changed_request_conflict",
          "one_unit_real_concurrent_race_exact_domain_loser",
          "used_purchased_grant_refund_rejected_without_refund_or_reversal",
          "canceled_purchased_grant_consumption_rejected_without_use_or_team",
          "quota_use_update_delete_rejected",
          "no_used_count_copy",
        ]),
        bootstrapHandoverAndCancellation: bootstrap.section,
        planAndSubscription: planSubscription,
        teamProviderAndPartnerDecisions: providerPartner,
        personalProviderSlots,
        applicationTransactions: section([
          "purchase_late_quota_failure_full_rollback",
          "team_provider_purchase_late_audit_failure_full_rollback",
          "refund_late_settlement_failure_full_rollback",
          "team_create_late_audit_failure_full_rollback",
          "admin_team_provider_invalid_audit_full_rollback",
          "funded_subscription_late_second_settlement_failure_full_rollback",
          "replayed_workflows_single_persisted_result",
        ]),
        rollbackAndAuditAtomicity: rollback,
        compatibilityDecisionShapesAndSelectedState: compatibility,
      },
      postconditions: {
        grantQuotaUse: grantAndQuota.section,
        refund,
        physical,
        audit,
      },
    } as const;
  } finally {
    const completionErrors: unknown[] = [];
    try {
      await owner?.close();
    } catch (error) {
      completionErrors.push(error);
    }
    try {
      await runtime.cleanup();
    } catch (error) {
      completionErrors.push(error);
    }
    if (completionErrors.length === 1) throw completionErrors[0];
    if (completionErrors.length > 1) throw new AggregateError(completionErrors, "authority_entitlement_runtime_completion_failed");
  }
  assert(report !== undefined, "verification_report_missing_after_runtime_completion");
  const completedReport = {
    ...report,
    runtimePostconditions: {
      ownerCloseCompleted: true,
      runtimeCleanupCompleted: true,
      outputForbiddenSecretPatternsAbsent: true,
    },
  } as const;
  const output = JSON.stringify(completedReport);
  assertForbiddenSecretPatternsAbsent(output, "verification_output_forbidden_secret_patterns_absent");
  process.stdout.write(`${output}\n`);
}

async function verifyBootstrapHandoverAndOwnerCancellation(
  owner: PostgresClientOwner,
  authority: AuthorityCommands,
  authorityQueries: Pick<AuthorityQueries, "activeBootstrapPlatformOwnerUserId">,
  application: AuthorityEntitlementApplicationService,
): Promise<{ currentOwnerUserId: string; section: VerificationSection }> {
  const attempts = await Promise.allSettled([
    authority.ensureBootstrapOwner(userIds.bootstrapA),
    authority.ensureBootstrapOwner(userIds.bootstrapB),
  ]);
  const fulfilled = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<AuthorityCommands["ensureBootstrapOwner"]>>> => result.status === "fulfilled");
  const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(fulfilled.length === 1 && rejected.length === 1, "bootstrap_concurrency_one_winner");
  assert(fulfilled[0]!.value.created, "bootstrap_concurrency_created");
  assertExpectedBootstrapRaceRejection(rejected[0]!.reason);
  const winningUserId = fulfilled[0]!.value.grant.beneficiaryUserId;
  const losingUserId = winningUserId === userIds.bootstrapA ? userIds.bootstrapB : userIds.bootstrapA;

  const replay = await authority.ensureBootstrapOwner(winningUserId);
  assert(!replay.created && replay.grant.id === fulfilled[0]!.value.grant.id, "bootstrap_exact_replay");
  await expectRelay("platform_owner_already_exists", () => authority.ensureBootstrapOwner(losingUserId));
  assert(await activeBootstrapOwnerCount(owner) === 1, "bootstrap_exactly_one_active_owner");

  const handover = await application.handoverPlatformOwner({
    currentOwnerUserId: winningUserId,
    nextOwnerUserId: userIds.nextOwner,
    actorUserId: winningUserId,
  });
  assert(handover.previousGrant.lifecycle === "canceled" && handover.previousGrant.cancelReasonCode === "owner_handover", "handover_previous_owner_canceled");
  assert(handover.nextGrant.lifecycle === "active" && handover.nextGrant.beneficiaryUserId === userIds.nextOwner, "handover_next_owner_active");
  assert(await activeBootstrapOwnerCount(owner) === 1, "handover_exactly_one_active_owner");
  assert(await authorityQueries.activeBootstrapPlatformOwnerUserId() === userIds.nextOwner, "handover_owner_query_readback");

  const invalidBefore = await owner.prisma.authority_grants.findMany({
    where: { role_domain: "platform", role_code: "owner", source_kind: "system_bootstrap" },
    orderBy: { id: "asc" },
  });
  const invalidAuditBefore = await owner.prisma.audit_logs.count({ where: { action: "platform_owner.handover" } });
  await expectRelay("platform_owner_handover_target_invalid", () => application.handoverPlatformOwner({
    currentOwnerUserId: userIds.nextOwner,
    nextOwnerUserId: userIds.disabledOwner,
    actorUserId: userIds.nextOwner,
  }));
  const invalidAfter = await owner.prisma.authority_grants.findMany({
    where: { role_domain: "platform", role_code: "owner", source_kind: "system_bootstrap" },
    orderBy: { id: "asc" },
  });
  assert(JSON.stringify(invalidAfter) === JSON.stringify(invalidBefore), "handover_invalid_target_rolls_back_grants");
  assert(await owner.prisma.audit_logs.count({ where: { action: "platform_owner.handover" } }) === invalidAuditBefore, "handover_invalid_target_no_audit");
  assert(await activeBootstrapOwnerCount(owner) === 1, "handover_invalid_target_preserves_owner");

  const auditFailureGrantsBefore = await owner.prisma.authority_grants.findMany({
    where: { role_domain: "platform", role_code: "owner", source_kind: "system_bootstrap" },
    orderBy: { id: "asc" },
  });
  const auditFailureActiveOwnerBefore = await authorityQueries.activeBootstrapPlatformOwnerUserId();
  const auditFailureCountBefore = await owner.prisma.audit_logs.count({ where: { action: "platform_owner.handover" } });
  await withScopedInsertFailure(owner, {
    suffix: "platform_owner_handover_audit",
    table: "audit_logs",
    when: `NEW."action" = 'platform_owner.handover' AND NEW."actor_id" = '${safeSqlLiteral(userIds.nextOwner)}'`,
  }, () => expectFailure(() => application.handoverPlatformOwner({
    currentOwnerUserId: userIds.nextOwner,
    nextOwnerUserId: losingUserId,
    actorUserId: userIds.nextOwner,
  })));
  const auditFailureGrantsAfter = await owner.prisma.authority_grants.findMany({
    where: { role_domain: "platform", role_code: "owner", source_kind: "system_bootstrap" },
    orderBy: { id: "asc" },
  });
  assert(JSON.stringify(auditFailureGrantsAfter) === JSON.stringify(auditFailureGrantsBefore), "handover_late_audit_failure_preserves_grant_set");
  assert(await authorityQueries.activeBootstrapPlatformOwnerUserId() === auditFailureActiveOwnerBefore, "handover_late_audit_failure_preserves_active_owner");
  assert(await activeBootstrapOwnerCount(owner) === 1, "handover_late_audit_failure_preserves_single_active_owner");
  assert(await owner.prisma.audit_logs.count({ where: { action: "platform_owner.handover" } }) === auditFailureCountBefore, "handover_late_audit_failure_no_audit");

  await expectRelay("authority_owner_cancel_blocked", () => authority.cancelGrant({
    grantId: handover.nextGrant.id,
    actorOwnerUserId: userIds.nextOwner,
    reasonCode: "security_response",
    requestId: "req_verify_bootstrap_cancel_blocked",
  }));

  return {
    currentOwnerUserId: userIds.nextOwner,
    section: section([
      "enabled_target_handover",
      "old_owner_canceled_owner_handover",
      "single_new_active_owner",
      "invalid_target_full_rollback",
      "late_handover_audit_failure_preserves_grant_set_and_active_owner",
      "purchased_grant_one_way_cancellation",
      "bootstrap_ordinary_cancellation_blocked",
    ]),
  };
}

async function createVerificationProducts(
  application: AuthorityEntitlementApplicationService,
  actorOwnerUserId: string,
): Promise<{ teamCreateProductId: string; raceProductId: string; rollbackProductId: string; providerProductId: string; personalProviderProductId: string }> {
  const teamCreate = await createAndListProduct(application, {
    code: "verify_team_create",
    displayName: "Verification Team Create",
    effectCode: "team_create_unit",
    grantUnits: 2,
    purchaseAmountUnits: 1_000n,
    grantDurationSeconds: 86_400,
    maxLifetimePurchasesPerUser: null,
    maxUnconsumedUnitsPerUser: null,
    maxCurrentOwnedTeams: null,
    maxLifetimeCreatedTeams: null,
    refundMode: "unused_by_owner",
    refundDeadlineSeconds: 3_600,
    settlementHoldSeconds: 7_200,
    sellerScopeRef: "global:",
    actorOwnerUserId,
  });
  const race = await createAndListProduct(application, {
    code: "verify_team_create_race",
    displayName: "Verification Team Create Race",
    effectCode: "team_create_unit",
    grantUnits: 1,
    purchaseAmountUnits: 1_000n,
    grantDurationSeconds: 86_400,
    maxLifetimePurchasesPerUser: null,
    maxUnconsumedUnitsPerUser: null,
    maxCurrentOwnedTeams: null,
    maxLifetimeCreatedTeams: null,
    refundMode: "none",
    refundDeadlineSeconds: null,
    settlementHoldSeconds: 7_200,
    sellerScopeRef: "global:",
    actorOwnerUserId,
  });
  const rollback = await createAndListProduct(application, {
    code: "verify_team_create_rollback",
    displayName: "Verification Team Create Rollback",
    effectCode: "team_create_unit",
    grantUnits: 7,
    purchaseAmountUnits: 1_000n,
    grantDurationSeconds: 86_400,
    maxLifetimePurchasesPerUser: null,
    maxUnconsumedUnitsPerUser: null,
    maxCurrentOwnedTeams: null,
    maxLifetimeCreatedTeams: null,
    refundMode: "unused_by_owner",
    refundDeadlineSeconds: 3_600,
    settlementHoldSeconds: 7_200,
    sellerScopeRef: "global:",
    actorOwnerUserId,
  });
  const provider = await createAndListProduct(application, {
    code: "verify_team_provider",
    displayName: "Verification Team Provider",
    effectCode: "team_custom_provider_access",
    grantUnits: 1,
    purchaseAmountUnits: 1_000n,
    grantDurationSeconds: 3_600,
    maxLifetimePurchasesPerUser: null,
    maxUnconsumedUnitsPerUser: null,
    maxCurrentOwnedTeams: null,
    maxLifetimeCreatedTeams: null,
    refundMode: "none",
    refundDeadlineSeconds: null,
    settlementHoldSeconds: 7_200,
    sellerScopeRef: "global:",
    actorOwnerUserId,
  });
  const personalProvider = await createAndListProduct(application, {
    code: "verify_personal_provider", displayName: "Verification Personal Provider", effectCode: "user_custom_provider_access",
    grantUnits: 1, purchaseAmountUnits: 1_000n, grantDurationSeconds: 365 * 86_400,
    maxLifetimePurchasesPerUser: null, maxUnconsumedUnitsPerUser: null, maxCurrentOwnedTeams: null, maxLifetimeCreatedTeams: null,
    refundMode: "none", refundDeadlineSeconds: null, settlementHoldSeconds: 7_200, sellerScopeRef: "global:", actorOwnerUserId,
  });
  return {
    teamCreateProductId: teamCreate.id,
    raceProductId: race.id,
    rollbackProductId: rollback.id,
    providerProductId: provider.id,
    personalProviderProductId: personalProvider.id,
  };
}

async function verifyPersonalProviderSlots(
  owner: PostgresClientOwner,
  application: AuthorityEntitlementApplicationService,
  productId: string,
): Promise<VerificationSection> {
  const buyerUserId = userIds.primaryBuyer;
  const first = await application.purchasePersonalProviderSlot({ buyerUserId, productId, idempotencyKey: "verify-personal-slot-1" });
  const firstReplay = await application.purchasePersonalProviderSlot({ buyerUserId, productId, idempotencyKey: "verify-personal-slot-1" });
  const second = await application.purchasePersonalProviderSlot({ buyerUserId, productId, idempotencyKey: "verify-personal-slot-2" });
  assert(firstReplay.replayed && firstReplay.slot.id === first.slot.id, "personal_slot_purchase_exact_replay");
  assert(first.slot.id !== second.slot.id, "personal_slot_two_purchases_two_slots");
  assert(first.period.durationDaysSnapshot === 365 && first.period.effectiveEnd === new Date(Date.parse(first.period.effectiveStart) + 365 * 86_400_000).toISOString(), "personal_slot_365_days_exact");
  assert(await owner.prisma.user_provider_slots.count({ where: { user_id: buyerUserId } }) === 2, "personal_slot_two_stable_rows");
  assert(await owner.prisma.user_provider_entitlement_periods.count({ where: { user_id: buyerUserId } }) === 2, "personal_slot_two_append_only_periods");

  const renewals = await Promise.all([
    application.renewPersonalProviderSlot({ buyerUserId, slotId: first.slot.id, productId, idempotencyKey: "verify-personal-renew-1" }),
    application.renewPersonalProviderSlot({ buyerUserId, slotId: first.slot.id, productId, idempotencyKey: "verify-personal-renew-2" }),
  ]);
  const periods = await owner.prisma.user_provider_entitlement_periods.findMany({ where: { provider_slot_id: first.slot.id }, orderBy: [{ effective_start: "asc" }, { id: "asc" }] });
  assert(periods.length === 3, "personal_slot_two_concurrent_renewals_append");
  assert(periods[0]!.effective_end === periods[1]!.effective_start && periods[1]!.effective_end === periods[2]!.effective_start, "personal_slot_concurrent_renewals_are_adjacent");
  assert(new Set(renewals.map((renewal) => renewal.period.id)).size === 2, "personal_slot_concurrent_renewals_have_distinct_periods");
  const renewedReplay = await application.renewPersonalProviderSlot({ buyerUserId, slotId: first.slot.id, productId, idempotencyKey: "verify-personal-renew-1" });
  assert(renewedReplay.replayed && periods.some((period) => period.id === renewedReplay.period.id), "personal_slot_renewal_exact_replay");

  const provider = await application.createPersonalProvider({ slotId: first.slot.id, userId: buyerUserId, name: "Verification Personal Codex" });
  const providerReplay = await application.createPersonalProvider({ slotId: first.slot.id, userId: buyerUserId, name: "Verification Personal Codex" });
  assert(!provider.replayed && providerReplay.replayed && providerReplay.provider.id === provider.provider.id, "personal_slot_provider_create_exact_replay");
  await expectRelay("personal_provider_create_conflict", () => application.createPersonalProvider({ slotId: first.slot.id, userId: buyerUserId, name: "Changed Personal Codex" }));
  assert(provider.provider.kind === "codex" && provider.provider.credentialResolver === "oauth:" && provider.slot.providerId === provider.provider.id, "personal_slot_provider_codex_oauth_bound");
  await expectFailure(() => owner.prisma.providers.update({ where: { id: provider.provider.id }, data: { scope_ref: "global:" } }));
  await expectFailure(() => owner.prisma.providers.update({ where: { id: provider.provider.id }, data: { config_json: "{\"escape\":true}" } }));
  await expectFailure(() => owner.prisma.provider_bindings.update({ where: { provider_id: provider.provider.id }, data: { auth_method: "api-key" } }));
  const secondProvider = await application.createPersonalProvider({ slotId: second.slot.id, userId: buyerUserId, name: "Verification Second Personal Codex" });
  await owner.prisma.provider_models.create({ data: {
    id: "provider_model_personal_verify_second", provider_id: secondProvider.provider.id, provider_model_name: "gpt-personal-second", display_name: "gpt-personal-second",
    status: "disabled", created_at: fixtureAt, updated_at: fixtureAt,
  } });
  await owner.prisma.provider_models.create({ data: {
    id: "provider_model_personal_verify", provider_id: provider.provider.id, provider_model_name: "gpt-personal", display_name: "gpt-personal",
    status: "disabled", created_at: fixtureAt, updated_at: fixtureAt,
  } });
  await application.changePersonalProviderModel({
    slotId: first.slot.id, userId: buyerUserId, providerId: provider.provider.id, providerModelName: "gpt-personal", status: "enabled",
  });
  const zeroCost = await owner.prisma.provider_model_costs.findFirstOrThrow({ where: { provider_id: provider.provider.id, provider_model_name: "gpt-personal", status: "enabled" } });
  assert(zeroCost.input_price_units_per_1m === 0n && zeroCost.output_price_units_per_1m === 0n, "personal_provider_model_zero_cost_fact");
  assert(await owner.prisma.audit_logs.count({ where: { action: "personal_provider_model_zero_cost.ensure", resource_id: zeroCost.id } }) === 1, "personal_provider_model_zero_cost_audit");
  const personalAccessPoint = (ordinal: number) => application.createPersonalAccessPoint({
    slotId: first.slot.id, userId: buyerUserId,
    command: {
      idempotencyKey: `verify-personal-ap-${ordinal}`, name: `Personal AP ${ordinal}`, apiFamily: "openai-compatible",
      exposedModel: `personal-${ordinal}`, targetModel: "gpt-personal", status: "disabled",
      routing: { selector: { id: "direct", behaviorVersion: 1, config: {} }, targets: [{
        type: "provider-model", targetAccessPointId: null, targetProviderId: provider.provider.id,
        targetProviderModelName: "gpt-personal", position: 0, status: "enabled",
      }] },
    },
  });
  for (let ordinal = 1; ordinal <= 99; ordinal += 1) await personalAccessPoint(ordinal);
  const capacityRace = await Promise.allSettled([personalAccessPoint(100), personalAccessPoint(101)]);
  assert(capacityRace.filter((result) => result.status === "fulfilled").length === 1 && capacityRace.filter((result) => result.status === "rejected").length === 1, "personal_slot_concurrent_100_101_single_winner");
  assert((await application.entitlement.getPersonalProviderSlot(first.slot.id))?.usedAccessPoints === 100, "personal_slot_100_access_points");
  const slotPage = await application.entitlement.pagePersonalProviderSlotsForUser(buyerUserId, 1, 20);
  assert(slotPage.total === 2 && slotPage.items.length === 2 && slotPage.items.every((slot) => slot.maxAccessPoints === 100), "personal_slot_set_based_bounded_page");
  assert(await owner.prisma.audit_logs.count({ where: { action: "personal_access_point_zero_price.ensure" } }) === 100, "personal_access_point_zero_price_audit_per_creation");
  await expectRelay("personal_access_point_limit_reached", () => personalAccessPoint(102));
  assert(await owner.prisma.accessPoint.count({ where: { personalProviderSlotId: first.slot.id, removedAt: null } }) === 100, "personal_slot_101_zero_partial_write");
  const firstAccessPoint = await owner.prisma.accessPoint.findFirstOrThrow({ where: { personalProviderSlotId: first.slot.id }, orderBy: { id: "asc" } });
  const firstTarget = await owner.prisma.accessPointTarget.findFirstOrThrow({ where: { accessPointId: firstAccessPoint.id, removedAt: null } });
  await expectFailure(() => owner.prisma.accessPoint.create({ data: { ...firstAccessPoint, id: "ap_personal_db_limit", createIdempotencyKeyHash: null, createRequestHash: null } }));
  await expectFailure(() => owner.prisma.accessPoint.update({ where: { id: firstAccessPoint.id }, data: { ownerId: userIds.nextOwner } }));
  await expectFailure(() => owner.prisma.accessPointTarget.update({ where: { id: firstTarget.id }, data: {
    targetProviderId: secondProvider.provider.id, targetProviderModelName: "gpt-personal-second", targetProviderModelId: "provider_model_personal_verify_second",
  } }));
  assert((await owner.prisma.accessPoint.findUniqueOrThrow({ where: { id: firstAccessPoint.id } })).ownerId === buyerUserId, "personal_slot_db_owner_guard_rollback");
  assert((await owner.prisma.accessPointTarget.findUniqueOrThrow({ where: { id: firstTarget.id } })).targetProviderId === provider.provider.id, "personal_slot_db_target_guard_rollback");
  await application.removePersonalAccessPoint({ slotId: first.slot.id, userId: buyerUserId, accessPointId: firstAccessPoint.id });
  await personalAccessPoint(102);
  assert(await owner.prisma.accessPoint.count({ where: { personalProviderSlotId: first.slot.id, removedAt: null } }) === 100, "personal_slot_remove_releases_capacity");

  await expectFailure(() => owner.prisma.user_provider_entitlement_periods.update({ where: { id: first.period.id }, data: { effective_end: "2099-01-01T00:00:00.000Z" } }));
  const terminalAt = new Date(Date.parse(periods[2]!.effective_end) + 180 * 86_400_000).toISOString();
  await expectRelay("provider_slot_retention_not_due", () => application.finalizePersonalProviderSlotRetention({ slotId: first.slot.id, at: new Date(Date.parse(terminalAt) - 1).toISOString() }));
  const exactCutoffWithOffset = terminalAt.replace(/Z$/u, "+00:00");
  const finalized = await application.finalizePersonalProviderSlotRetention({ slotId: first.slot.id, at: exactCutoffWithOffset });
  await expectFailure(() => owner.prisma.accessPoint.create({ data: { ...firstAccessPoint, id: "ap_personal_terminal", removedAt: null, createIdempotencyKeyHash: null, createRequestHash: null } }));
  const terminalCleanupAccessPoint = await owner.prisma.accessPoint.findFirstOrThrow({ where: { personalProviderSlotId: first.slot.id, removedAt: null }, orderBy: { id: "asc" } });
  await owner.prisma.accessPoint.update({ where: { id: terminalCleanupAccessPoint.id }, data: { status: "disabled", updatedAt: terminalAt } });
  await owner.prisma.accessPoint.update({ where: { id: terminalCleanupAccessPoint.id }, data: { removedAt: terminalAt, updatedAt: terminalAt } });
  assert((await owner.prisma.accessPoint.findUniqueOrThrow({ where: { id: terminalCleanupAccessPoint.id } })).removedAt === terminalAt, "personal_slot_terminal_cleanup_can_shrink");
  const finalizedReplay = await application.finalizePersonalProviderSlotRetention({ slotId: first.slot.id, at: terminalAt });
  assert(!finalized.replayed && finalizedReplay.replayed && finalized.slot.lifecycle === "retention_expired", "personal_slot_terminal_exact_cutoff_idempotent");
  await expectRelay("provider_slot_renewal_window_expired", () => application.renewPersonalProviderSlot({ buyerUserId, slotId: first.slot.id, productId, idempotencyKey: "verify-personal-renew-after-terminal" }));
  return section([
    "purchase_replay_and_two_independent_slots", "positive_integer_365_day_period", "concurrent_renewals_serialized_and_adjacent",
    "append_only_period_trigger", "codex_oauth_provider_binding_and_exact_create_replay", "slot_bound_provider_database_definition_guards",
    "access_point_100_101_and_remove_capacity", "personal_access_point_database_owner_target_capacity_guards",
    "zero_provider_cost_and_plan_override_audits", "set_based_bounded_slot_page",
    "terminal_exact_cutoff_idempotent_no_restore_insert_rejection_and_cleanup_shrink",
  ]);
}

async function verifyGrantQuotaUseAndApplicationPurchase(
  owner: PostgresClientOwner,
  authority: AuthorityCommands,
  application: AuthorityEntitlementApplicationService,
  products: { teamCreateProductId: string; raceProductId: string },
): Promise<{ purchaseId: string; grantId: string; quotaId: string; useId: string; section: VerificationSection }> {
  const purchaseInput = {
    buyerUserId: userIds.primaryBuyer,
    productId: products.teamCreateProductId,
    idempotencyKey: "verify-primary-purchase",
    requestId: "req_verify_primary_purchase",
  };
  const purchased = await application.purchaseTeamCreationProduct(purchaseInput);
  const purchaseReplay = await application.purchaseTeamCreationProduct(purchaseInput);
  assert(!purchased.replayed && purchaseReplay.replayed, "purchase_replay_flags");
  assert(purchaseReplay.purchase.id === purchased.purchase.id, "purchase_replay_same_purchase");
  assert(purchaseReplay.grant.id === purchased.grant.id, "purchase_replay_same_grant");
  assert(purchaseReplay.quota.id === purchased.quota.id, "purchase_replay_same_quota");
  assert(await owner.prisma.authority_purchases.count({ where: { id: purchased.purchase.id } }) === 1, "purchase_single_purchase_fact");
  assert(await owner.prisma.authority_grants.count({ where: { source_purchase_id: purchased.purchase.id } }) === 1, "purchase_single_grant_fact");
  assert(await owner.prisma.authority_grant_quotas.count({ where: { grant_id: purchased.grant.id } }) === 1, "purchase_single_quota_fact");
  assert(await owner.prisma.credit_ledger_events.count({ where: { authority_purchase_id: purchased.purchase.id, event_type: "authority_purchase" } }) === 1, "purchase_single_ledger_fact");
  assert(await owner.prisma.seller_settlement_events.count({ where: { authority_purchase_id: purchased.purchase.id, event_type: "revenue" } }) === 1, "purchase_single_settlement_fact");
  assert(await owner.prisma.audit_logs.count({ where: { action: "authority_purchase.create", resource_id: purchased.purchase.id } }) === 1, "purchase_single_audit_fact");
  const changedProductBefore = await purchasedAuthorityFactCounts(owner, userIds.primaryBuyer);
  await expectRelay("authority_idempotency_conflict", () => application.purchaseTeamCreationProduct({
    ...purchaseInput,
    productId: products.raceProductId,
    requestId: "req_verify_primary_purchase_changed_product",
  }));
  assertSameCounts(await purchasedAuthorityFactCounts(owner, userIds.primaryBuyer), changedProductBefore, "purchase_changed_product_conflict_no_extra_purchase_grant_quota");

  const createInput = {
    beneficiaryUserId: userIds.primaryBuyer,
    name: "Verification Primary Team",
    idempotencyKey: "verify-primary-team-create",
    requestId: "req_verify_primary_team_create",
  };
  const created = await application.createTeamByConsumingAuthority(createInput);
  const createReplay = await application.createTeamByConsumingAuthority(createInput);
  assert(!created.replayed && createReplay.replayed && createReplay.use.id === created.use.id, "team_create_exact_replay");
  assert(createReplay.targetStatus === "active", "team_create_replay_target_active");
  await expectRelay("authority_idempotency_conflict", () => application.createTeamByConsumingAuthority({ ...createInput, name: "Changed Verification Team" }));
  assert(await owner.prisma.authority_uses.count({ where: { id: created.use.id } }) === 1, "team_create_single_use");
  assert(await owner.prisma.teams.count({ where: { id: created.use.targetIdSnapshot, owner_id: userIds.primaryBuyer } }) === 1, "team_create_single_team");
  assert(await owner.prisma.team_memberships.count({ where: { team_id: created.use.targetIdSnapshot, user_id: userIds.primaryBuyer } }) === 1, "team_create_single_owner_membership");
  assert(await owner.prisma.audit_logs.count({ where: { action: "authority_grant.consume", resource_id: created.use.id } }) === 1, "team_create_single_consume_audit");
  assert(await owner.prisma.audit_logs.count({ where: { action: "team.create", resource_id: created.use.targetIdSnapshot } }) === 1, "team_create_single_team_audit");
  await expectRelay("authority_grant_already_used", () => application.refundUnusedAuthorityGrant({
    grantId: purchased.grant.id,
    actorOwnerUserId: userIds.nextOwner,
    reasonCode: "customer_request",
    idempotencyKey: "verify-used-grant-refund",
    requestId: "req_verify_used_grant_refund",
  }));
  assert(await owner.prisma.authority_refunds.count({ where: { authority_purchase_id: purchased.purchase.id } }) === 0, "used_grant_refund_rejection_no_refund");
  assert(await owner.prisma.credit_ledger_events.count({ where: { authority_purchase_id: purchased.purchase.id, event_type: "reversal" } }) === 0, "used_grant_refund_rejection_no_ledger_reversal");
  assert(await owner.prisma.seller_settlement_events.count({ where: { authority_purchase_id: purchased.purchase.id, event_type: "reversal" } }) === 0, "used_grant_refund_rejection_no_settlement_reversal");
  assert(await owner.prisma.audit_logs.count({ where: { action: "authority_purchase.refund", resource_id: purchased.purchase.id } }) === 0, "used_grant_refund_rejection_no_refund_audit");

  const racePurchase = await application.purchaseTeamCreationProduct({
    buyerUserId: userIds.raceBuyer,
    productId: products.raceProductId,
    idempotencyKey: "verify-race-purchase",
    requestId: "req_verify_race_purchase",
  });
  assert(racePurchase.quota.grantedUnits === 1, "race_real_one_unit_quota");
  const raceBeforeTeams = await owner.prisma.teams.count({ where: { owner_id: userIds.raceBuyer } });
  const raceAttempts = await Promise.allSettled([
    application.createTeamByConsumingAuthority({ beneficiaryUserId: userIds.raceBuyer, name: "Race Team A", idempotencyKey: "verify-race-team-a", requestId: "req_verify_race_team_a" }),
    application.createTeamByConsumingAuthority({ beneficiaryUserId: userIds.raceBuyer, name: "Race Team B", idempotencyKey: "verify-race-team-b", requestId: "req_verify_race_team_b" }),
  ]);
  const raceFulfilled = raceAttempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<AuthorityEntitlementApplicationService["createTeamByConsumingAuthority"]>>> => result.status === "fulfilled");
  const raceRejected = raceAttempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(raceFulfilled.length === 1 && raceRejected.length === 1, "one_unit_race_one_winner");
  assertExpectedOneUnitRaceRejection(raceRejected[0]!.reason);
  assert(await owner.prisma.authority_uses.count({ where: { grant_quota_id: racePurchase.quota.id } }) === 1, "one_unit_race_single_use");
  assert(await owner.prisma.teams.count({ where: { owner_id: userIds.raceBuyer } }) === raceBeforeTeams + 1, "one_unit_race_single_team");

  const cancelPurchase = await application.purchaseTeamCreationProduct({
    buyerUserId: userIds.cancelBuyer,
    productId: products.teamCreateProductId,
    idempotencyKey: "verify-cancel-purchase",
    requestId: "req_verify_cancel_purchase",
  });
  const canceled = await authority.cancelGrant({
    grantId: cancelPurchase.grant.id,
    actorOwnerUserId: userIds.nextOwner,
    reasonCode: "security_response",
    requestId: "req_verify_cancel_grant",
  });
  const cancelReplay = await authority.cancelGrant({
    grantId: cancelPurchase.grant.id,
    actorOwnerUserId: userIds.nextOwner,
    reasonCode: "security_response",
    requestId: "req_verify_cancel_grant_replay",
  });
  assert(canceled.lifecycle === "canceled" && canceled.cancelReasonCode === "security_response", "grant_active_to_canceled");
  assert(cancelReplay.canceledAt === canceled.canceledAt && cancelReplay.cancelReasonCode === canceled.cancelReasonCode, "grant_cancel_same_reason_replay_stable");
  assert(await owner.prisma.audit_logs.count({ where: { action: "authority_grant.cancel", resource_id: canceled.id } }) === 1, "grant_cancel_single_audit");
  await expectRelay("authority_cancel_conflict", () => authority.cancelGrant({
    grantId: cancelPurchase.grant.id,
    actorOwnerUserId: userIds.nextOwner,
    reasonCode: "fraud",
    requestId: "req_verify_cancel_grant_conflict",
  }));
  const canceledUseCountBefore = await owner.prisma.authority_uses.count({ where: { beneficiary_user_id: userIds.cancelBuyer } });
  const canceledTeamCountBefore = await owner.prisma.teams.count({ where: { owner_id: userIds.cancelBuyer } });
  await expectRelay("authority_grant_canceled", () => application.createTeamByConsumingAuthority({
    beneficiaryUserId: userIds.cancelBuyer,
    name: "Canceled Grant Must Not Create Team",
    idempotencyKey: "verify-canceled-grant-consume",
    requestId: "req_verify_canceled_grant_consume",
  }));
  assert(await owner.prisma.authority_uses.count({ where: { beneficiary_user_id: userIds.cancelBuyer } }) === canceledUseCountBefore, "canceled_grant_consumption_rejection_no_use");
  assert(await owner.prisma.teams.count({ where: { owner_id: userIds.cancelBuyer } }) === canceledTeamCountBefore, "canceled_grant_consumption_rejection_no_team");

  return {
    purchaseId: purchased.purchase.id,
    grantId: purchased.grant.id,
    quotaId: purchased.quota.id,
    useId: created.use.id,
    section: section([
      "purchase_replay_same_three_authority_identities",
      "purchase_changed_product_conflict_without_extra_purchase_grant_quota",
      "purchase_single_financial_and_authority_facts",
      "team_create_use_team_membership_single_result",
      "used_grant_refund_rejected_without_refund_or_reversal",
      "one_unit_concurrency_exact_domain_loser",
      "grant_cancel_replay_and_conflict",
      "canceled_grant_consumption_rejected_without_use_or_team",
    ]),
  };
}

async function verifyPlanAndSubscription(
  owner: PostgresClientOwner,
  application: AuthorityEntitlementApplicationService,
  actorOwnerUserId: string,
): Promise<VerificationSection> {
  const versionOne = await application.createPlanDefinition(planInput("Verification Versioned Plan", actorOwnerUserId));
  const versionTwo = await application.createPlanDefinition(planInput("Verification Versioned Plan", actorOwnerUserId));
  assert(versionOne.version === 1 && versionTwo.version === 2, "plan_name_versions_increment");

  const lifecycle = await application.createPlanDefinition(planInput("Verification Lifecycle Plan", actorOwnerUserId));
  await expectRelay("plan_must_be_closed_first", () => application.revisePlanDefinition(lifecycle.id, {
    status: "disabled",
    actorUserId: actorOwnerUserId,
    requestId: "req_verify_plan_disable_direct",
  }));
  const closed = await application.revisePlanDefinition(lifecycle.id, {
    status: "closed",
    actorUserId: actorOwnerUserId,
    requestId: "req_verify_plan_close",
  });
  const disabled = await application.revisePlanDefinition(lifecycle.id, {
    status: "disabled",
    actorUserId: actorOwnerUserId,
    requestId: "req_verify_plan_disable",
  });
  assert(closed.plan.planStatus === "closed" && disabled.plan.planStatus === "disabled", "plan_lifecycle_enabled_closed_disabled");

  const fundedPlan = await application.createPlanDefinition({
    ...planInput("Verification Funded Sold Plan", actorOwnerUserId),
    purchaseAmount: 2,
    durationSeconds: 3_600,
  });
  const fundingAccount = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { scope_ref: `user:${userIds.planBuyer}` } });
  const fundingBalanceBefore = fundingAccount.balance_snap_units;
  const funded = await application.createPlanSubscriptionUnits({
    planId: fundedPlan.id,
    scopeRef: `user:${userIds.planBuyer}`,
    units: 2,
    source: "verification_funded",
    purchasedByUserId: userIds.planBuyer,
    paymentMode: "charge_account",
    paymentAccountId: fundingAccount.id,
    effectiveStart: "2090-01-01T00:00:00.000Z",
    actorUserId: userIds.planBuyer,
    requestId: "req_verify_funded_subscriptions",
  });
  assert(funded.subscriptions.length === 2 && funded.ledgerEventIds.length === 2, "funded_subscription_units_created");
  assert(funded.subscriptions[0]!.effectiveEnd === funded.subscriptions[1]!.effectiveStart, "funded_subscription_units_adjacent");
  assert(await owner.prisma.credit_ledger_events.count({ where: { id: { in: funded.ledgerEventIds }, event_type: "plan_purchase" } }) === 2, "funded_subscription_ledger_facts");
  assert(await owner.prisma.seller_settlement_events.count({ where: { plan_subscription_id: { in: funded.subscriptions.map((row) => row.id) }, event_type: "revenue" } }) === 2, "funded_subscription_settlement_facts");
  assert((await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: fundingAccount.id } })).balance_snap_units === fundingBalanceBefore - 4_000_000n, "funded_subscription_account_projection_matches_ledger_debits");

  const soldBefore = await owner.prisma.plans.findUniqueOrThrow({ where: { id: fundedPlan.id } });
  const soldAuditBefore = await owner.prisma.audit_logs.count({ where: { action: "plan.update", resource_id: fundedPlan.id } });
  await expectRelay("sold_plan_terms_immutable", () => application.revisePlanDefinition(fundedPlan.id, {
    durationSeconds: 7_200,
    actorUserId: actorOwnerUserId,
    requestId: "req_verify_sold_plan_immutable",
  }));
  const soldAfter = await owner.prisma.plans.findUniqueOrThrow({ where: { id: fundedPlan.id } });
  assert(soldAfter.duration_seconds === soldBefore.duration_seconds && soldAfter.purchase_amount_units === soldBefore.purchase_amount_units, "sold_plan_terms_unchanged");
  assert(await owner.prisma.audit_logs.count({ where: { action: "plan.update", resource_id: fundedPlan.id } }) === soldAuditBefore, "sold_plan_rejection_no_audit");

  const overlapPlan = await application.createPlanDefinition(planInput("Verification Overlap Plan", actorOwnerUserId));
  const overlapStart = "2091-01-01T00:00:00.000Z";
  const overlapEnd = "2091-02-01T00:00:00.000Z";
  const overlapAttempts = await Promise.allSettled([
    application.createPlanSubscription(subscriptionInput("verify_subscription_overlap_a", overlapPlan.id, `user:${userIds.primaryBuyer}`, overlapStart, overlapEnd, actorOwnerUserId)),
    application.createPlanSubscription(subscriptionInput("verify_subscription_overlap_b", overlapPlan.id, `user:${userIds.primaryBuyer}`, overlapStart, overlapEnd, actorOwnerUserId)),
  ]);
  const overlapFulfilled = overlapAttempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<AuthorityEntitlementApplicationService["createPlanSubscription"]>>> => result.status === "fulfilled");
  const overlapRejected = overlapAttempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert(overlapFulfilled.length === 1 && overlapRejected.length === 1, "subscription_overlap_concurrent_one_winner");
  assertExpectedConcurrentRejection(overlapRejected[0]!.reason, "plan_subscription_overlap");
  assert(await owner.prisma.plan_subscriptions.count({ where: { plan_id: overlapPlan.id, scope_ref: `user:${userIds.primaryBuyer}`, subscription_lifecycle: "active" } }) === 1, "subscription_overlap_single_active_row");

  const adjacent = await application.createPlanSubscription(subscriptionInput(
    "verify_subscription_adjacent",
    overlapPlan.id,
    `user:${userIds.primaryBuyer}`,
    overlapEnd,
    "2091-03-01T00:00:00.000Z",
    actorOwnerUserId,
  ));
  assert(adjacent.effectiveStart === overlapEnd, "subscription_adjacent_period_allowed");

  const winning = overlapFulfilled[0]!.value;
  const cancellationEnd = "2091-01-15T00:00:00.000Z";
  const canceled = await application.cancelPlanSubscription(winning.id, {
    actorUserId: actorOwnerUserId,
    effectiveEnd: cancellationEnd,
    requestId: "req_verify_subscription_cancel",
  });
  const cancelReplay = await application.cancelPlanSubscription(winning.id, {
    actorUserId: actorOwnerUserId,
    effectiveEnd: "2091-01-10T00:00:00.000Z",
    requestId: "req_verify_subscription_cancel_replay",
  });
  assert(canceled.subscriptionLifecycle === "canceled" && canceled.effectiveEnd === cancellationEnd, "subscription_cancel_truncates_end");
  assert(cancelReplay.subscriptionLifecycle === "canceled" && cancelReplay.effectiveEnd === cancellationEnd, "subscription_cancel_replay_stable");
  assert(await owner.prisma.plan_subscriptions.count({ where: { id: winning.id } }) === 1, "subscription_cancel_retains_row");
  assert(await owner.prisma.audit_logs.count({ where: { action: "plan_subscription.cancel", resource_id: winning.id } }) === 1, "subscription_cancel_single_audit");

  return section([
    "plan_version_increment",
    "plan_lifecycle_transitions",
    "sold_commercial_terms_immutable",
    "real_concurrent_overlap_exact_domain_rejection",
    "adjacent_period_allowed",
    "cancellation_retains_and_truncates",
    "cancellation_replay_stable",
    "funded_subscription_rows_financial_facts_and_account_projection",
  ]);
}

async function verifyTeamProviderAndPartnerDecisions(
  owner: PostgresClientOwner,
  application: AuthorityEntitlementApplicationService,
  providerProductId: string,
  actorOwnerUserId: string,
): Promise<VerificationSection> {
  const providerPurchaseInput = {
    buyerUserId: userIds.providerBuyer,
    productId: providerProductId,
    teamId: teamIds.providerPurchase,
    idempotencyKey: "verify-provider-purchase",
    requestId: "req_verify_provider_purchase",
  };
  const providerPurchase = await application.purchaseTeamProviderProduct(providerPurchaseInput);
  const providerPurchaseReplay = await application.purchaseTeamProviderProduct(providerPurchaseInput);
  assert(!providerPurchase.replayed && providerPurchaseReplay.replayed, "team_provider_purchase_replay_flags");
  assert(providerPurchase.purchase.id === providerPurchaseReplay.purchase.id && providerPurchase.entitlement.id === providerPurchaseReplay.entitlement.id, "team_provider_purchase_same_result");
  assert(await owner.prisma.authority_purchases.count({ where: { id: providerPurchase.purchase.id } }) === 1, "team_provider_purchase_single_purchase");
  assert(await owner.prisma.team_provider_entitlements.count({ where: { source_authority_purchase_id: providerPurchase.purchase.id } }) === 1, "team_provider_purchase_single_entitlement");
  assert(await owner.prisma.credit_ledger_events.count({ where: { authority_purchase_id: providerPurchase.purchase.id, event_type: "authority_purchase" } }) === 1, "team_provider_purchase_single_ledger");
  assert(await owner.prisma.seller_settlement_events.count({ where: { authority_purchase_id: providerPurchase.purchase.id, event_type: "revenue" } }) === 1, "team_provider_purchase_single_settlement");

  await seedTeamAccessPointProvider(owner, {
    providerId: "verify_team_ap_provider",
    providerModelId: "verify_team_ap_provider_model",
    providerCostId: "verify_team_ap_provider_cost",
    ownerId: userIds.providerBuyer,
    teamId: teamIds.providerPurchase,
  });
  await owner.prisma.teams.update({ where: { id: teamIds.providerPurchase }, data: { team_owner_can_create_access_point: 1 } });
  const teamAccessPointCommand = {
    idempotencyKey: "verify-team-access-point",
    ownerId: userIds.providerBuyer,
    scopeRef: `team:${teamIds.providerPurchase}` as const,
    name: "Verification Team AccessPoint",
    apiFamily: "openai-compatible",
    exposedModel: "team-verification-model",
    targetModel: "team-verification-model",
    status: "disabled",
    routing: {
      selector: { id: "direct" as const, behaviorVersion: 1 as const, config: {} },
      targets: [{
        type: "provider-model" as const,
        targetAccessPointId: null,
        targetProviderId: "verify_team_ap_provider",
        targetProviderModelName: "team-verification-model",
        position: 0,
        status: "enabled" as const,
      }],
    },
  };
  const teamAccessPointAudit = {
    actor: { actorType: "user" as const, actorId: userIds.providerBuyer },
    source: "web" as const,
    requestId: "req_verify_team_access_point",
  };
  const teamAccessPoint = await application.createTeamAccessPoint({
    teamId: teamIds.providerPurchase,
    actorUserId: userIds.providerBuyer,
    command: teamAccessPointCommand,
    audit: teamAccessPointAudit,
  });
  const teamAccessPointReplay = await application.createTeamAccessPoint({
    teamId: teamIds.providerPurchase,
    actorUserId: userIds.providerBuyer,
    command: teamAccessPointCommand,
    audit: teamAccessPointAudit,
  });
  assert(!teamAccessPoint.replayed && teamAccessPointReplay.replayed && teamAccessPointReplay.id === teamAccessPoint.id, "team_access_point_team_provider_entitlement_exact_replay");
  assert(await owner.prisma.accessPoint.count({ where: { scopeRef: `team:${teamIds.providerPurchase}`, removedAt: null } }) === 1, "team_access_point_single_unremoved_row");

  await owner.prisma.teams.update({ where: { id: teamIds.providerNone }, data: { team_owner_can_create_access_point: 1 } });
  const noAllowanceAccessPointCommand = {
    ...teamAccessPointCommand,
    idempotencyKey: "verify-team-access-point-no-allowance",
    ownerId: userIds.primaryBuyer,
    scopeRef: `team:${teamIds.providerNone}` as const,
    name: "Verification Team AccessPoint Rejected",
  };
  await expectRelay("team_provider_entitlement_required", () => application.createTeamAccessPoint({
    teamId: teamIds.providerNone,
    actorUserId: userIds.primaryBuyer,
    command: noAllowanceAccessPointCommand,
    audit: { ...teamAccessPointAudit, actor: { actorType: "user", actorId: userIds.primaryBuyer }, requestId: "req_verify_team_access_point_no_allowance" },
  }));
  assert(await owner.prisma.accessPoint.count({ where: { scopeRef: `team:${teamIds.providerNone}`, removedAt: null } }) === 0, "team_access_point_no_provider_entitlement_no_row");

  const adminGrantInput = {
    teamId: teamIds.providerAdmin,
    productId: providerProductId,
    actorOwnerUserId,
    idempotencyKey: "verify-provider-admin-grant",
    requestId: "req_verify_provider_admin_grant",
  };
  const adminGrant = await application.grantTeamProviderEntitlement(adminGrantInput);
  const adminGrantReplay = await application.grantTeamProviderEntitlement(adminGrantInput);
  assert(!adminGrant.replayed && adminGrantReplay.replayed && adminGrantReplay.entitlement.id === adminGrant.entitlement.id, "team_provider_admin_grant_replay");
  assert(await owner.prisma.team_provider_entitlements.count({ where: { id: adminGrant.entitlement.id } }) === 1, "team_provider_admin_grant_single_row");

  await owner.prisma.teams.update({ where: { id: teamIds.providerAdmin }, data: { team_owner_can_create_access_point: 1 } });
  await seedTeamAccessPointProvider(owner, {
    providerId: "verify_team_admin_ap_provider",
    providerModelId: "verify_team_admin_ap_provider_model",
    providerCostId: "verify_team_admin_ap_provider_cost",
    ownerId: userIds.primaryBuyer,
    teamId: teamIds.providerAdmin,
  });
  const adminTeamAccessPoint = await application.createTeamAccessPoint({
    teamId: teamIds.providerAdmin,
    actorUserId: userIds.primaryBuyer,
    command: {
      ...teamAccessPointCommand,
      idempotencyKey: "verify-team-access-point-admin-grant",
      ownerId: userIds.primaryBuyer,
      scopeRef: `team:${teamIds.providerAdmin}` as const,
      name: "Verification Team AccessPoint Admin Grant",
      routing: {
        ...teamAccessPointCommand.routing,
        targets: [{
          ...teamAccessPointCommand.routing.targets[0]!,
          targetProviderId: "verify_team_admin_ap_provider",
        }],
      },
    },
    audit: {
      ...teamAccessPointAudit,
      actor: { actorType: "user", actorId: userIds.primaryBuyer },
      requestId: "req_verify_team_access_point_admin_grant",
    },
  });
  assert(!adminTeamAccessPoint.replayed, "team_access_point_admin_grant_admission");
  assert(await owner.prisma.accessPoint.count({ where: { scopeRef: `team:${teamIds.providerAdmin}`, removedAt: null } }) === 1, "team_access_point_admin_grant_single_row");

  const notEntitled = await application.entitlement.getTeamProviderAccessState(teamIds.providerNone, fixtureAt);
  assert(notEntitled.state === "not_entitled", "team_provider_not_entitled_decision");
  const scheduledAt = addMilliseconds(adminGrant.entitlement.effectiveStart, -1);
  const scheduled = await application.entitlement.getTeamProviderAccessState(teamIds.providerAdmin, scheduledAt);
  assert(scheduled.state === "scheduled" && scheduled.nextEntitlement?.id === adminGrant.entitlement.id, "team_provider_scheduled_decision");
  const active = await application.entitlement.decideTeamProviderAccess(teamIds.providerAdmin, adminGrant.entitlement.effectiveStart);
  assert(active.kind === "allowed" && active.state === "active", "team_provider_active_decision");
  const expired = await application.entitlement.getTeamProviderAccessState(teamIds.providerAdmin, adminGrant.entitlement.effectiveEnd!);
  assert(expired.state === "expired", "team_provider_expired_decision");

  await owner.prisma.team_provider_entitlements.create({ data: {
    id: "verify_team_provider_permanent_entitlement",
    team_id: teamIds.providerPermanent,
    source_kind: "legacy_migration",
    source_authority_purchase_id: null,
    source_authority_product_id: null,
    source_product_code_snapshot: null,
    source_product_version_snapshot: null,
    source_product_display_name_snapshot: null,
    buyer_user_id: null,
    issued_by_user_id: null,
    effective_start: "2000-01-01T00:00:00.000Z",
    effective_end: null,
    lifecycle: "active",
    canceled_at: null,
    canceled_by_user_id: null,
    cancel_reason_code: null,
    idempotency_key_hash: null,
    request_hash: null,
    created_at: fixtureAt,
  } });
  await owner.prisma.teams.update({ where: { id: teamIds.providerPermanent }, data: { team_owner_can_create_access_point: 1 } });
  await seedTeamAccessPointProvider(owner, {
    providerId: "verify_team_permanent_ap_provider",
    providerModelId: "verify_team_permanent_ap_provider_model",
    providerCostId: "verify_team_permanent_ap_provider_cost",
    ownerId: userIds.primaryBuyer,
    teamId: teamIds.providerPermanent,
  });
  const permanent = await application.entitlement.decideTeamProviderAccess(teamIds.providerPermanent, fixtureAt);
  assert(permanent.kind === "allowed" && permanent.state === "permanent" && permanent.effectiveEnd === null, "team_provider_permanent_legacy_fixture_decision");
  const permanentTeamAccessPoint = await application.createTeamAccessPoint({
    teamId: teamIds.providerPermanent,
    actorUserId: userIds.primaryBuyer,
    command: {
      ...teamAccessPointCommand,
      idempotencyKey: "verify-team-access-point-permanent",
      ownerId: userIds.primaryBuyer,
      scopeRef: `team:${teamIds.providerPermanent}` as const,
      name: "Verification Team AccessPoint Permanent",
      routing: {
        ...teamAccessPointCommand.routing,
        targets: [{
          ...teamAccessPointCommand.routing.targets[0]!,
          targetProviderId: "verify_team_permanent_ap_provider",
        }],
      },
    },
    audit: {
      ...teamAccessPointAudit,
      actor: { actorType: "user", actorId: userIds.primaryBuyer },
      requestId: "req_verify_team_access_point_permanent",
    },
  });
  assert(!permanentTeamAccessPoint.replayed, "team_access_point_permanent_admission");
  assert(await owner.prisma.accessPoint.count({ where: { scopeRef: `team:${teamIds.providerPermanent}`, removedAt: null } }) === 1, "team_access_point_permanent_single_row");

  const canceled = await application.entitlementCommands.cancelTeamProviderEntitlement({
    entitlementId: adminGrant.entitlement.id,
    actorOwnerUserId,
    reasonCode: "operator_error",
    requestId: "req_verify_provider_cancel",
  });
  const cancelReplay = await application.entitlementCommands.cancelTeamProviderEntitlement({
    entitlementId: adminGrant.entitlement.id,
    actorOwnerUserId,
    reasonCode: "operator_error",
    requestId: "req_verify_provider_cancel_replay",
  });
  assert(canceled.lifecycle === "canceled" && canceled.cancelReasonCode === "operator_error", "team_provider_canceled_fact");
  assert(cancelReplay.canceledAt === canceled.canceledAt, "team_provider_cancel_replay_stable");
  const canceledProjection = await application.entitlement.getTeamProviderAccessState(teamIds.providerAdmin, adminGrant.entitlement.effectiveStart);
  assert(canceledProjection.state === "expired" && canceledProjection.entitlement === null, "team_provider_canceled_denied_projection");
  await expectRelay("team_provider_entitlement_expired", () => application.createTeamAccessPoint({
    teamId: teamIds.providerAdmin,
    actorUserId: userIds.primaryBuyer,
    command: {
      ...teamAccessPointCommand,
      idempotencyKey: "verify-team-access-point-canceled-entitlement",
      ownerId: userIds.primaryBuyer,
      scopeRef: `team:${teamIds.providerAdmin}` as const,
      name: "Verification Team AccessPoint Canceled Entitlement",
      routing: {
        ...teamAccessPointCommand.routing,
        targets: [{
          ...teamAccessPointCommand.routing.targets[0]!,
          targetProviderId: "verify_team_admin_ap_provider",
        }],
      },
    },
    audit: {
      ...teamAccessPointAudit,
      actor: { actorType: "user", actorId: userIds.primaryBuyer },
      requestId: "req_verify_team_access_point_canceled_entitlement",
    },
  }));
  assert(await owner.prisma.accessPoint.count({ where: { scopeRef: `team:${teamIds.providerAdmin}`, removedAt: null } }) === 1, "team_access_point_canceled_entitlement_no_row");

  const partnerPlan = await application.createPlanDefinition({
    ...planInput("Verification Partner Plan", actorOwnerUserId),
    durationSeconds: 31_536_000,
  });
  const partnerStart = "2092-01-01T00:00:00.000Z";
  const partnerEnd = "2093-01-01T00:00:00.000Z";
  const partnerSubscription = await application.createPlanSubscription(subscriptionInput(
    "verify_partner_subscription",
    partnerPlan.id,
    `team:${teamIds.partner}`,
    partnerStart,
    partnerEnd,
    actorOwnerUserId,
  ));
  await seedPartnerOrderFixture(owner, partnerPlan.id, actorOwnerUserId);
  const partnerCreated = await application.entitlementCommands.createPartnerOperatingEntitlement({
    sourceOrderId: "verify_partner_order",
    ownerUserId: userIds.planBuyer,
    partnerTeamId: teamIds.partner,
    partnerPlanId: partnerPlan.id,
    planSubscriptionId: partnerSubscription.id,
    effectiveStart: partnerStart,
    effectiveEnd: partnerEnd,
    actor: { actorType: "user", actorId: actorOwnerUserId },
    requestId: "req_verify_partner_entitlement",
  });
  const partnerReplay = await application.entitlementCommands.createPartnerOperatingEntitlement({
    sourceOrderId: "verify_partner_order",
    ownerUserId: userIds.planBuyer,
    partnerTeamId: teamIds.partner,
    partnerPlanId: partnerPlan.id,
    planSubscriptionId: partnerSubscription.id,
    effectiveStart: partnerStart,
    effectiveEnd: partnerEnd,
    actor: { actorType: "user", actorId: actorOwnerUserId },
    requestId: "req_verify_partner_entitlement_replay",
  });
  assert(!partnerCreated.replayed && partnerReplay.replayed && partnerReplay.entitlement.id === partnerCreated.entitlement.id, "partner_entitlement_exact_replay");
  const partnerFixture = await owner.prisma.partner_operating_entitlements.findUniqueOrThrow({ where: { id: partnerCreated.entitlement.id } });
  const partnerTeam = await owner.prisma.teams.findUniqueOrThrow({ where: { id: teamIds.partner } });
  assert(partnerFixture.owner_user_id === partnerTeam.owner_id && partnerTeam.owner_id === userIds.planBuyer, "partner_fixture_owner_matches_partner_team_owner");
  const noPartner = await application.entitlement.decidePartnerOperating(teamIds.providerNone, fixtureAt);
  assert(noPartner.kind === "denied" && noPartner.state === "not_partner", "partner_no_row_not_partner");
  const partnerAt = "2092-06-01T00:00:00.000Z";
  const partnerAllowed = await application.entitlement.decidePartnerOperating(teamIds.partner, partnerAt);
  assert(partnerAllowed.kind === "allowed" && partnerAllowed.subscriptionId === partnerSubscription.id, "partner_decision_on_aligned_direct_fixture_allowed");
  await application.cancelPlanSubscription(partnerSubscription.id, {
    actorUserId: actorOwnerUserId,
    effectiveEnd: "2092-12-01T00:00:00.000Z",
    requestId: "req_verify_partner_subscription_cancel",
  });
  const partnerDenied = await application.entitlement.decidePartnerOperating(teamIds.partner, partnerAt);
  assert(partnerDenied.kind === "denied" && partnerDenied.state === "inactive", "partner_decision_on_direct_fixture_with_canceled_subscription_denied");

  return section([
    "team_provider_purchase_exact_replay",
    "team_access_point_team_provider_entitlement_exact_replay",
    "team_access_point_no_provider_entitlement_no_row",
    "admin_grant_exact_replay",
    "team_access_point_admin_grant_admission",
    "team_provider_not_entitled_scheduled_active_expired",
    "team_provider_decision_on_legacy_permanent_fixture",
    "team_access_point_permanent_admission",
    "canceled_team_provider_fact_denied",
    "team_access_point_canceled_entitlement_denied",
    "partner_no_row_not_partner",
    "partner_decision_on_aligned_direct_fixture_allowed",
    "partner_decision_on_direct_fixture_with_canceled_subscription_denied",
  ]);
}

async function verifyRefundApplicationTransaction(
  owner: PostgresClientOwner,
  application: AuthorityEntitlementApplicationService,
  productId: string,
  actorOwnerUserId: string,
): Promise<VerificationSection> {
  const accountBefore = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { scope_ref: `user:${userIds.refundBuyer}` } });
  const purchase = await application.purchaseTeamCreationProduct({
    buyerUserId: userIds.refundBuyer,
    productId,
    idempotencyKey: "verify-refund-purchase",
    requestId: "req_verify_refund_purchase",
  });
  const afterPurchase = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: accountBefore.id } });
  assert(afterPurchase.balance_snap_units === accountBefore.balance_snap_units - purchase.purchase.purchaseAmountUnits, "refund_purchase_debits_balance");
  const refundInput = {
    grantId: purchase.grant.id,
    actorOwnerUserId,
    reasonCode: "customer_request",
    idempotencyKey: "verify-unused-refund",
    requestId: "req_verify_unused_refund",
  };
  const refund = await application.refundUnusedAuthorityGrant(refundInput);
  const refundReplay = await application.refundUnusedAuthorityGrant(refundInput);
  assert(!refund.replayed && refundReplay.replayed, "refund_replay_flags");
  assert(refundReplay.refund.id === refund.refund.id, "refund_replay_same_refund");
  assert(refundReplay.creditLedgerEventId === refund.creditLedgerEventId, "refund_replay_same_ledger");
  assert(refundReplay.sellerSettlementReversalId === refund.sellerSettlementReversalId, "refund_replay_same_settlement");
  const canceledGrant = await owner.prisma.authority_grants.findUniqueOrThrow({ where: { id: purchase.grant.id } });
  assert(canceledGrant.lifecycle === "canceled" && canceledGrant.cancel_reason_code === "refund", "refund_cancels_unused_grant");
  assert(await owner.prisma.authority_refunds.count({ where: { authority_purchase_id: purchase.purchase.id } }) === 1, "refund_single_refund_fact");
  assert(await owner.prisma.credit_ledger_events.count({ where: { authority_purchase_id: purchase.purchase.id, event_type: "reversal" } }) === 1, "refund_single_ledger_reversal");
  assert(await owner.prisma.seller_settlement_events.count({ where: { authority_purchase_id: purchase.purchase.id, event_type: "reversal" } }) === 1, "refund_single_settlement_reversal");
  assert((await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: accountBefore.id } })).balance_snap_units === accountBefore.balance_snap_units, "refund_restores_balance");
  assert(await owner.prisma.audit_logs.count({ where: { action: "authority_grant.cancel", resource_id: purchase.grant.id } }) === 1, "refund_single_cancel_audit");
  assert(await owner.prisma.audit_logs.count({ where: { action: "authority_purchase.refund", resource_id: purchase.purchase.id } }) === 1, "refund_single_refund_audit");
  return section([
    "unused_grant_canceled_for_refund",
    "refund_and_ledger_settlement_reversals",
    "refund_balance_restored",
    "refund_exact_replay_single_facts",
  ]);
}

async function verifyRollbackAtomicity(
  owner: PostgresClientOwner,
  application: AuthorityEntitlementApplicationService,
  rollbackProductId: string,
  teamCreateProductId: string,
  providerProductId: string,
  actorOwnerUserId: string,
): Promise<VerificationSection> {
  const purchaseBefore = await rollbackCounts(owner);
  const purchaseAccountBefore = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { scope_ref: `user:${userIds.purchaseRollbackBuyer}` } });
  await withScopedInsertFailure(owner, {
    suffix: "purchase_quota",
    table: "authority_grant_quotas",
    when: `NEW."granted_units" = 7`,
  }, () => expectFailure(() => application.purchaseTeamCreationProduct({
    buyerUserId: userIds.purchaseRollbackBuyer,
    productId: rollbackProductId,
    idempotencyKey: "verify-purchase-rollback",
    requestId: "req_verify_purchase_rollback",
  })));
  assertSameCounts(await rollbackCounts(owner), purchaseBefore, "purchase_failure_zero_partial_rows");
  const purchaseAccountAfter = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: purchaseAccountBefore.id } });
  assert(purchaseAccountAfter.balance_snap_units === purchaseAccountBefore.balance_snap_units && purchaseAccountAfter.balance_snap_ledger_event_id === purchaseAccountBefore.balance_snap_ledger_event_id, "purchase_failure_balance_rollback");
  assert(await owner.prisma.authority_purchases.count({ where: { buyer_user_id: userIds.purchaseRollbackBuyer } }) === 0, "purchase_failure_no_purchase");
  assert(await owner.prisma.authority_grants.count({ where: { beneficiary_user_id: userIds.purchaseRollbackBuyer, source_kind: "product_purchase" } }) === 0, "purchase_failure_no_grant");

  const providerPurchaseBefore = await rollbackCounts(owner);
  const providerPurchaseAccountBefore = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { scope_ref: `user:${userIds.providerRollbackBuyer}` } });
  await withScopedInsertFailure(owner, {
    suffix: "team_provider_purchase_audit",
    table: "audit_logs",
    when: `NEW."action" = 'team_provider_entitlement.purchase' AND NEW."actor_id" = '${safeSqlLiteral(userIds.providerRollbackBuyer)}'`,
  }, () => expectFailure(() => application.purchaseTeamProviderProduct({
    buyerUserId: userIds.providerRollbackBuyer,
    productId: providerProductId,
    teamId: teamIds.providerPurchaseRollback,
    idempotencyKey: "verify-provider-purchase-rollback",
    requestId: "req_verify_provider_purchase_rollback",
  })));
  assertSameCounts(await rollbackCounts(owner), providerPurchaseBefore, "team_provider_purchase_late_audit_failure_zero_partial_rows");
  const providerPurchaseAccountAfter = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: providerPurchaseAccountBefore.id } });
  assert(providerPurchaseAccountAfter.balance_snap_units === providerPurchaseAccountBefore.balance_snap_units
    && providerPurchaseAccountAfter.balance_snap_ledger_event_id === providerPurchaseAccountBefore.balance_snap_ledger_event_id,
  "team_provider_purchase_late_audit_failure_account_projection_rollback");
  assert(await owner.prisma.authority_purchases.count({ where: { buyer_user_id: userIds.providerRollbackBuyer } }) === 0, "team_provider_purchase_late_audit_failure_no_purchase");
  assert(await owner.prisma.credit_ledger_events.count({ where: { actor_user_id: userIds.providerRollbackBuyer, event_type: "authority_purchase" } }) === 0, "team_provider_purchase_late_audit_failure_no_ledger");
  assert(await providerPurchaseSettlementCount(owner, userIds.providerRollbackBuyer) === 0, "team_provider_purchase_late_audit_failure_no_settlement");
  assert(await owner.prisma.team_provider_entitlements.count({ where: { team_id: teamIds.providerPurchaseRollback } }) === 0, "team_provider_purchase_late_audit_failure_no_entitlement");
  assert(await owner.prisma.audit_logs.count({ where: { actor_id: userIds.providerRollbackBuyer, action: { in: ["authority_purchase.create", "team_provider_entitlement.purchase"] } } }) === 0, "team_provider_purchase_late_audit_failure_no_audit");

  const refundPurchase = await application.purchaseTeamCreationProduct({
    buyerUserId: userIds.refundRollbackBuyer,
    productId: teamCreateProductId,
    idempotencyKey: "verify-refund-rollback-purchase",
    requestId: "req_verify_refund_rollback_purchase",
  });
  const refundBefore = await rollbackCounts(owner);
  const refundGrantBefore = await owner.prisma.authority_grants.findUniqueOrThrow({ where: { id: refundPurchase.grant.id } });
  const refundAccountBefore = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: refundPurchase.purchase.creditAccountId } });
  await withScopedInsertFailure(owner, {
    suffix: "refund_settlement",
    table: "seller_settlement_events",
    when: `NEW."event_type" = 'reversal' AND NEW."source_type" = 'authority_refund' AND NEW."authority_purchase_id" = '${safeSqlLiteral(refundPurchase.purchase.id)}'`,
  }, () => expectFailure(() => application.refundUnusedAuthorityGrant({
    grantId: refundPurchase.grant.id,
    actorOwnerUserId,
    reasonCode: "customer_request",
    idempotencyKey: "verify-refund-rollback",
    requestId: "req_verify_refund_rollback",
  })));
  assertSameCounts(await rollbackCounts(owner), refundBefore, "refund_failure_zero_partial_rows");
  const refundGrantAfter = await owner.prisma.authority_grants.findUniqueOrThrow({ where: { id: refundPurchase.grant.id } });
  const refundAccountAfter = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: refundAccountBefore.id } });
  assert(JSON.stringify(refundGrantAfter) === JSON.stringify(refundGrantBefore), "refund_failure_grant_cancellation_rollback");
  assert(refundAccountAfter.balance_snap_units === refundAccountBefore.balance_snap_units && refundAccountAfter.balance_snap_ledger_event_id === refundAccountBefore.balance_snap_ledger_event_id, "refund_failure_balance_rollback");
  assert(await owner.prisma.authority_refunds.count({ where: { authority_purchase_id: refundPurchase.purchase.id } }) === 0, "refund_failure_no_refund");
  assert(await owner.prisma.credit_ledger_events.count({ where: { authority_purchase_id: refundPurchase.purchase.id, event_type: "reversal" } }) === 0, "refund_failure_no_ledger_reversal");
  assert(await owner.prisma.seller_settlement_events.count({ where: { authority_purchase_id: refundPurchase.purchase.id, event_type: "reversal" } }) === 0, "refund_failure_no_settlement_reversal");

  const teamPurchase = await application.purchaseTeamCreationProduct({
    buyerUserId: userIds.teamRollbackBuyer,
    productId: teamCreateProductId,
    idempotencyKey: "verify-team-rollback-purchase",
    requestId: "req_verify_team_rollback_purchase",
  });
  const teamBefore = await rollbackCounts(owner);
  await withScopedInsertFailure(owner, {
    suffix: "team_create_audit",
    table: "audit_logs",
    when: `NEW."action" = 'team.create' AND NEW."actor_id" = '${safeSqlLiteral(userIds.teamRollbackBuyer)}'`,
  }, () => expectFailure(() => application.createTeamByConsumingAuthority({
    beneficiaryUserId: userIds.teamRollbackBuyer,
    name: "Verification Rollback Team",
    idempotencyKey: "verify-team-create-rollback",
    requestId: "req_verify_team_create_rollback",
  })));
  assertSameCounts(await rollbackCounts(owner), teamBefore, "team_create_failure_zero_partial_rows");
  assert(await owner.prisma.authority_uses.count({ where: { grant_quota_id: teamPurchase.quota.id } }) === 0, "team_create_failure_no_use");
  assert(await owner.prisma.teams.count({ where: { owner_id: userIds.teamRollbackBuyer } }) === 0, "team_create_failure_no_team");
  assert(await owner.prisma.team_memberships.count({ where: { user_id: userIds.teamRollbackBuyer } }) === 0, "team_create_failure_no_membership");
  assert(await owner.prisma.audit_logs.count({ where: { actor_id: userIds.teamRollbackBuyer, action: { in: ["authority_grant.consume", "team.create"] } } }) === 0, "team_create_failure_no_audit");

  const grantBefore = await rollbackCounts(owner);
  await expectFailure(() => application.grantTeamProviderEntitlement({
    teamId: teamIds.providerAdminRollback,
    productId: providerProductId,
    actorOwnerUserId,
    idempotencyKey: "verify-admin-grant-rollback",
    requestId: invalidRequestId,
  }));
  assertSameCounts(await rollbackCounts(owner), grantBefore, "admin_grant_failure_zero_partial_rows");
  assert(await owner.prisma.team_provider_entitlements.count({ where: { team_id: teamIds.providerAdminRollback } }) === 0, "admin_grant_failure_no_entitlement");

  const fundedRollbackPlan = await application.createPlanDefinition({
    ...planInput("Verification Funded Rollback Plan", actorOwnerUserId),
    purchaseAmount: 3,
    durationSeconds: 3_600,
  });
  const fundedRollbackAccountBefore = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { scope_ref: `user:${userIds.fundedRollbackBuyer}` } });
  const fundedRollbackBefore = await rollbackCounts(owner);
  const secondSubscriptionStart = "2094-01-01T01:00:00.000Z";
  await withScopedInsertFailure(owner, {
    suffix: "funded_subscription_second_settlement",
    table: "seller_settlement_events",
    when: `NEW."source_type" = 'plan_purchase' AND NEW."window_start" = '${secondSubscriptionStart}'`,
  }, () => expectFailure(() => application.createPlanSubscriptionUnits({
    planId: fundedRollbackPlan.id,
    scopeRef: `user:${userIds.fundedRollbackBuyer}`,
    units: 2,
    source: "verification_funded_rollback",
    purchasedByUserId: userIds.fundedRollbackBuyer,
    paymentMode: "charge_account",
    paymentAccountId: fundedRollbackAccountBefore.id,
    effectiveStart: "2094-01-01T00:00:00.000Z",
    actorUserId: userIds.fundedRollbackBuyer,
    requestId: "req_verify_funded_rollback",
  })));
  assertSameCounts(await rollbackCounts(owner), fundedRollbackBefore, "funded_subscription_late_second_settlement_failure_zero_partial_rows");
  const fundedRollbackAccountAfter = await owner.prisma.credit_accounts.findUniqueOrThrow({ where: { id: fundedRollbackAccountBefore.id } });
  assert(fundedRollbackAccountAfter.balance_snap_units === fundedRollbackAccountBefore.balance_snap_units
    && fundedRollbackAccountAfter.balance_snap_ledger_event_id === fundedRollbackAccountBefore.balance_snap_ledger_event_id,
  "funded_subscription_late_second_settlement_failure_account_projection_rollback");
  assert(await owner.prisma.plan_subscriptions.count({ where: { plan_id: fundedRollbackPlan.id } }) === 0, "funded_subscription_late_second_settlement_failure_no_subscriptions");
  assert(await owner.prisma.credit_ledger_events.count({ where: { account_id: fundedRollbackAccountBefore.id, event_type: "plan_purchase", reason: `plan:${fundedRollbackPlan.id}` } }) === 0, "funded_subscription_late_second_settlement_failure_no_ledger");
  assert(await fundedSubscriptionSettlementCount(owner, fundedRollbackPlan.id) === 0, "funded_subscription_late_second_settlement_failure_no_settlement");
  assert(await owner.prisma.audit_logs.count({ where: { action: "plan_subscription.create", request_id: "req_verify_funded_rollback" } }) === 0, "funded_subscription_late_second_settlement_failure_no_audit");
  assert(await scopedFailureTriggerCount(owner) === 0, "predicate_scoped_failure_triggers_removed");

  return section([
    "purchase_late_quota_failure_full_rollback",
    "team_provider_purchase_late_audit_failure_full_rollback",
    "refund_late_settlement_failure_full_rollback",
    "team_create_final_audit_failure_full_rollback",
    "admin_grant_invalid_audit_full_rollback",
    "funded_subscription_late_second_settlement_failure_full_rollback",
    "predicate_scoped_failure_triggers_removed",
    "exact_persisted_counts_unchanged",
  ]);
}

async function verifyPhysicalConstraintsAndAppendOnlyTriggers(
  owner: PostgresClientOwner,
  purchaseId: string,
  grantId: string,
  quotaId: string,
  useId: string,
): Promise<VerificationSection> {
  const expectedTriggers = [
    { name: "authority_grant_quotas_no_update", tableName: "authority_grant_quotas", event: "UPDATE", functionName: "friday_relay_reject_append_only_mutation" },
    { name: "authority_grant_quotas_no_delete", tableName: "authority_grant_quotas", event: "DELETE", functionName: "friday_relay_reject_delete" },
    { name: "authority_uses_no_update", tableName: "authority_uses", event: "UPDATE", functionName: "friday_relay_reject_append_only_mutation" },
    { name: "authority_uses_no_delete", tableName: "authority_uses", event: "DELETE", functionName: "friday_relay_reject_delete" },
    { name: "audit_logs_no_update", tableName: "audit_logs", event: "UPDATE", functionName: "friday_relay_reject_append_only_mutation" },
    { name: "audit_logs_no_delete", tableName: "audit_logs", event: "DELETE", functionName: "friday_relay_reject_append_only_mutation" },
  ] as const;
  const triggerRows = await owner.query<{
    name: string;
    tableName: string;
    functionName: string;
    updateEvent: boolean;
    deleteEvent: boolean;
  }>(`
    SELECT trigger_row.tgname AS "name",
      attached_table.relname AS "tableName",
      trigger_function.proname AS "functionName",
      (trigger_row.tgtype & 16) = 16 AS "updateEvent",
      (trigger_row.tgtype & 8) = 8 AS "deleteEvent"
    FROM pg_trigger trigger_row
    INNER JOIN pg_class attached_table ON attached_table.oid = trigger_row.tgrelid
    INNER JOIN pg_namespace table_schema ON table_schema.oid = attached_table.relnamespace
    INNER JOIN pg_proc trigger_function ON trigger_function.oid = trigger_row.tgfoid
    INNER JOIN pg_namespace function_schema ON function_schema.oid = trigger_function.pronamespace
    WHERE NOT trigger_row.tgisinternal
      AND table_schema.nspname = 'public'
      AND function_schema.nspname = 'public'
      AND trigger_row.tgname IN (
        'authority_grant_quotas_no_update', 'authority_grant_quotas_no_delete',
        'authority_uses_no_update', 'authority_uses_no_delete',
        'audit_logs_no_update', 'audit_logs_no_delete'
      )
  `);
  assert(triggerRows.rows.length === expectedTriggers.length, "physical_append_only_trigger_count_exact");
  for (const expected of expectedTriggers) {
    const row = triggerRows.rows.find((candidate) => candidate.name === expected.name);
    assert(row?.tableName === expected.tableName, `physical_append_only_trigger_table:${expected.name}`);
    assert(row.functionName === expected.functionName, `physical_append_only_trigger_function:${expected.name}`);
    assert(row.updateEvent === (expected.event === "UPDATE") && row.deleteEvent === (expected.event === "DELETE"), `physical_append_only_trigger_event:${expected.name}`);
  }

  const grantRow = await owner.prisma.authority_grants.findUniqueOrThrow({ where: { id: grantId } });
  await expectFailure(() => owner.prisma.authority_grants.create({ data: { ...grantRow, id: "verify_duplicate_purchase_grant" } }));
  assert(await owner.prisma.authority_grants.count({ where: { source_purchase_id: purchaseId } }) === 1, "physical_purchase_grant_unique");

  const quotaRow = await owner.prisma.authority_grant_quotas.findUniqueOrThrow({ where: { id: quotaId } });
  await expectFailure(() => owner.prisma.authority_grant_quotas.create({ data: { ...quotaRow, id: "verify_duplicate_grant_quota" } }));
  assert(await owner.prisma.authority_grant_quotas.count({ where: { grant_id: grantId, capability_code: "team.create" } }) === 1, "physical_grant_quota_unique");

  const useRow = await owner.prisma.authority_uses.findUniqueOrThrow({ where: { id: useId } });
  await expectFailure(() => owner.prisma.authority_uses.create({ data: { ...useRow, id: "verify_duplicate_use_operation", unit_index: useRow.unit_index + 100 } }));
  await expectFailure(() => owner.prisma.authority_uses.create({ data: { ...useRow, id: "verify_duplicate_use_unit", idempotency_key_hash: "verify_distinct_idempotency_hash" } }));
  assert(await owner.prisma.authority_uses.count({ where: { id: useId } }) === 1, "physical_use_unique_facts");

  await expectFailure(() => owner.prisma.authority_grant_quotas.update({ where: { id: quotaId }, data: { granted_units: quotaRow.granted_units + 1n } }));
  await expectFailure(() => owner.prisma.authority_grant_quotas.delete({ where: { id: quotaId } }));
  await expectFailure(() => owner.prisma.authority_uses.update({ where: { id: useId }, data: { request_hash: "verify_mutated_request_hash" } }));
  await expectFailure(() => owner.prisma.authority_uses.delete({ where: { id: useId } }));
  assert((await owner.prisma.authority_grant_quotas.findUniqueOrThrow({ where: { id: quotaId } })).granted_units === quotaRow.granted_units, "quota_update_rejected_state_stable");
  assert((await owner.prisma.authority_uses.findUniqueOrThrow({ where: { id: useId } })).request_hash === useRow.request_hash, "use_update_rejected_state_stable");

  const auditRow = await owner.prisma.audit_logs.findFirstOrThrow({ orderBy: { id: "asc" } });
  await expectFailure(() => owner.prisma.audit_logs.update({ where: { id: auditRow.id }, data: { metadata_json: "{}" } }));
  await expectFailure(() => owner.prisma.audit_logs.delete({ where: { id: auditRow.id } }));
  assert(await owner.prisma.audit_logs.count({ where: { id: auditRow.id } }) === 1, "audit_update_delete_rejected_state_stable");

  const usedCountColumns = await owner.query<{ count: number }>(`
    SELECT COUNT(*)::bigint AS "count"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('authority_grants', 'authority_grant_quotas')
      AND column_name IN ('used_count', 'usedCount')
  `);
  assert(usedCountColumns.rows[0]?.count === 0, "authority_has_no_used_count_copy");

  return section([
    "grant_purchase_unique_index",
    "grant_quota_unique_index",
    "use_operation_and_unit_unique_indexes",
    "quota_append_only_trigger_names_tables_events_and_function",
    "use_append_only_trigger_names_tables_events_and_function",
    "audit_append_only_trigger_names_tables_events_and_function",
    "used_count_column_absent",
  ]);
}

async function verifyCompatibilityOnlyDecisions(
  owner: PostgresClientOwner,
  application: AuthorityEntitlementApplicationService,
): Promise<VerificationSection> {
  const before = await compatibilityStateDigest(owner);
  const allowance = await application.entitlement.decideAccessPointAllowance(`user:${userIds.primaryBuyer}`);
  const restriction = await application.entitlement.decideApiKeyPlanSourceRestriction("verify_nonexistent_api_key");
  const after = await compatibilityStateDigest(owner);
  assert(allowance.kind === "allowed" && allowance.maxAccessPoints === 100 && allowance.source === "paid_provider_entitlement", "paid_access_point_allowance_bounded");
  assert(restriction.mode === "all" && restriction.sourceKeys.length === 0 && restriction.teamScopeRefs.length === 0, "compatibility_plan_sources_all_empty");
  assert(before === after, "compatibility_decisions_selected_state_unchanged");
  return section([
    "exact_paid_access_point_allowance_bounded_shape",
    "exact_api_key_plan_sources_all_empty_restrictions_shape",
    "compatibility_decisions_selected_database_state_unchanged",
  ]);
}

async function verifyAuditPostconditions(owner: PostgresClientOwner): Promise<VerificationSection> {
  const policies: Readonly<Record<string, string>> = {
    "authority_grant.bootstrap": "beneficiaryUserId,sourceKind",
    "authority_grant.cancel": "reasonCode,sourceKind",
    "authority_grant.consume": "grantQuotaId,ownerUserId,teamId",
    "platform_owner.handover": "nextOwnerUserId,previousGrantId,previousOwnerUserId",
    "authority_product.create": "code,effectCode,lifecycle,version",
    "authority_product.list": "code,replacedProductId,version",
    "authority_purchase.create": "grantUnits,productCode,productId,productVersion,purchaseAmountUnits",
    "authority_purchase.refund": "grantId,purchaseAmountUnits,reasonCode,refundId",
    "plan.create": "accessPointCount,budgetLimitCount,ownerId,scopeRef,status,version",
    "plan.update": "newCatalogStatus,newStatus,oldCatalogStatus,oldStatus,ownerId,scopeRef,version",
    "plan_subscription.create": "effectiveEnd,effectiveStart,planId,priority,scopeRef,source",
    "plan_subscription.cancel": "effectiveEnd,lifecycle,planId,scopeRef",
    "team_provider_entitlement.grant": "effectiveEnd,effectiveStart,productCode,productId,productVersion,teamId",
    "team_provider_entitlement.cancel": "reasonCode,sourceKind,teamId",
    "team_provider_entitlement.purchase": "effectiveEnd,effectiveStart,productCode,productId,productVersion,purchaseAmountUnits,teamId",
    "partner_operating_entitlement.create": "effectiveEnd,effectiveStart,ownerUserId,partnerTeamId,planId,sourceOrderId,subscriptionId",
    "team.create": "name,ownerId,status",
  };
  const rows = await owner.prisma.audit_logs.findMany({ where: { action: { in: Object.keys(policies) } } });
  assert(rows.length > 0, "authority_entitlement_audits_present");
  for (const action of Object.keys(policies)) assert(rows.some((row) => row.action === action), `audit_action_present:${action}`);
  for (const row of rows) {
    assert(row.result === "success", `audit_success_result:${row.action}`);
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    assert(Object.keys(metadata).sort().join(",") === policies[row.action], `audit_metadata_exact:${row.action}`);
    assertForbiddenSecretPatternsAbsent(JSON.stringify(metadata), `audit_metadata_forbidden_secret_patterns_absent:${row.action}`);
  }

  const bootstrap = await representativeAudit(owner, {
    action: "authority_grant.bootstrap", requestId: null, actorType: "system", actorId: "bootstrap",
    source: "system", resourceType: "authority_grant",
  });
  const bootstrapGrant = await owner.prisma.authority_grants.findUniqueOrThrow({ where: { id: bootstrap.resource_id } });
  const bootstrapMetadata = JSON.parse(bootstrap.metadata_json) as Record<string, unknown>;
  assert(bootstrapGrant.source_kind === "system_bootstrap" && bootstrapGrant.beneficiary_user_id === bootstrapMetadata.beneficiaryUserId, "audit_bootstrap_resource_matches_grant");

  const handoverRows = await owner.prisma.audit_logs.findMany({ where: { action: "platform_owner.handover", request_id: null } });
  assert(handoverRows.length === 1, "audit_handover_single_event");
  const handoverMetadata = JSON.parse(handoverRows[0]!.metadata_json) as Record<string, unknown>;
  const handover = await representativeAudit(owner, {
    action: "platform_owner.handover", requestId: null, actorType: "user", actorId: String(handoverMetadata.previousOwnerUserId),
    source: "owner", resourceType: "authority_grant",
  });
  const handoverGrant = await owner.prisma.authority_grants.findUniqueOrThrow({ where: { id: handover.resource_id } });
  assert(handoverGrant.beneficiary_user_id === handoverMetadata.nextOwnerUserId, "audit_handover_resource_matches_next_owner_grant");

  const purchase = await representativeAudit(owner, {
    action: "authority_purchase.create", requestId: "req_verify_primary_purchase", actorType: "user", actorId: userIds.primaryBuyer,
    source: "web", resourceType: "authority_purchase",
  });
  assert((await owner.prisma.authority_purchases.findUniqueOrThrow({ where: { id: purchase.resource_id } })).buyer_user_id === userIds.primaryBuyer, "audit_purchase_resource_matches_buyer");

  const consume = await representativeAudit(owner, {
    action: "authority_grant.consume", requestId: "req_verify_primary_team_create", actorType: "user", actorId: userIds.primaryBuyer,
    source: "web", resourceType: "authority_use",
  });
  const teamCreate = await representativeAudit(owner, {
    action: "team.create", requestId: "req_verify_primary_team_create", actorType: "user", actorId: userIds.primaryBuyer,
    source: "web", resourceType: "team",
  });
  const use = await owner.prisma.authority_uses.findUniqueOrThrow({ where: { id: consume.resource_id } });
  const createdTeam = await owner.prisma.teams.findUniqueOrThrow({ where: { id: teamCreate.resource_id } });
  assert(use.target_id_snapshot === createdTeam.id && createdTeam.owner_id === userIds.primaryBuyer, "audit_team_create_use_and_team_resources_match");

  const refund = await representativeAudit(owner, {
    action: "authority_purchase.refund", requestId: "req_verify_unused_refund", actorType: "user", actorId: userIds.nextOwner,
    source: "owner", resourceType: "authority_purchase",
  });
  const refundCancel = await representativeAudit(owner, {
    action: "authority_grant.cancel", requestId: "req_verify_unused_refund", actorType: "user", actorId: userIds.nextOwner,
    source: "owner", resourceType: "authority_grant",
  });
  const refundFact = await owner.prisma.authority_refunds.findUniqueOrThrow({ where: { authority_purchase_id: refund.resource_id } });
  assert(refundFact.authority_grant_id === refundCancel.resource_id, "audit_refund_purchase_and_grant_resources_match");

  const adminProviderGrant = await representativeAudit(owner, {
    action: "team_provider_entitlement.grant", requestId: "req_verify_provider_admin_grant", actorType: "user", actorId: userIds.nextOwner,
    source: "owner", resourceType: "team_provider_entitlement",
  });
  const adminEntitlement = await owner.prisma.team_provider_entitlements.findUniqueOrThrow({ where: { id: adminProviderGrant.resource_id } });
  assert(adminEntitlement.team_id === teamIds.providerAdmin && adminEntitlement.issued_by_user_id === userIds.nextOwner, "audit_admin_team_provider_resource_matches_entitlement");

  const subscriptionCancel = await representativeAudit(owner, {
    action: "plan_subscription.cancel", requestId: "req_verify_subscription_cancel", actorType: "user", actorId: userIds.nextOwner,
    source: "owner", resourceType: "plan_subscription",
  });
  const subscriptionCreateRows = await owner.prisma.audit_logs.findMany({
    where: { action: "plan_subscription.create", resource_id: subscriptionCancel.resource_id },
  });
  assert(subscriptionCreateRows.length === 1, "audit_subscription_create_single_event_for_canceled_resource");
  const subscriptionCreate = subscriptionCreateRows[0]!;
  assert(subscriptionCreate.actor_type === "user" && subscriptionCreate.actor_id === userIds.nextOwner
    && subscriptionCreate.source === "owner" && subscriptionCreate.resource_type === "plan_subscription"
    && ["req_verify_subscription_overlap_a", "req_verify_subscription_overlap_b"].includes(subscriptionCreate.request_id ?? ""),
  "audit_subscription_create_actor_source_resource_request");
  assert(await owner.prisma.plan_subscriptions.count({ where: { id: subscriptionCancel.resource_id } }) === 1, "audit_subscription_create_cancel_resource_persisted");

  const replayedResources = [
    ["authority_grant.bootstrap", bootstrap.resource_id],
    ["platform_owner.handover", handover.resource_id],
    ["authority_purchase.create", purchase.resource_id],
    ["authority_grant.consume", consume.resource_id],
    ["team.create", teamCreate.resource_id],
    ["authority_purchase.refund", refund.resource_id],
    ["authority_grant.cancel", refundCancel.resource_id],
    ["team_provider_entitlement.grant", adminProviderGrant.resource_id],
    ["plan_subscription.create", subscriptionCancel.resource_id],
    ["plan_subscription.cancel", subscriptionCancel.resource_id],
  ] as const;
  for (const [action, resourceId] of replayedResources) {
    assert(await owner.prisma.audit_logs.count({ where: { action, resource_id: resourceId } }) === 1, `audit_replayed_resource_single_event:${action}`);
  }

  return section([
    "all_representative_actions_persisted",
    "action_metadata_exact_allowlists",
    "representative_actor_source_resource_and_request_semantics",
    "bootstrap_and_handover_request_ids_null",
    "replayed_resource_lifecycle_events_single_where_defined",
    "audit_metadata_forbidden_secret_patterns_absent",
    "audit_update_delete_physically_rejected",
  ]);
}

async function representativeAudit(
  owner: PostgresClientOwner,
  expected: {
    action: string;
    requestId: string | null;
    actorType: string;
    actorId: string;
    source: string;
    resourceType: string;
  },
) {
  const rows = await owner.prisma.audit_logs.findMany({
    where: { action: expected.action, request_id: expected.requestId },
  });
  assert(rows.length === 1, `audit_representative_single:${expected.action}`);
  const row = rows[0]!;
  assert(row.actor_type === expected.actorType && row.actor_id === expected.actorId, `audit_representative_actor:${expected.action}`);
  assert(row.source === expected.source, `audit_representative_source:${expected.action}`);
  assert(row.resource_type === expected.resourceType && row.resource_id.length > 0, `audit_representative_resource:${expected.action}`);
  assert(row.request_id === expected.requestId, `audit_representative_request_id:${expected.action}`);
  return row;
}

async function seedDeterministicFixtures(owner: PostgresClientOwner): Promise<void> {
  const enabledUsers = Object.values(userIds).filter((id) => id !== userIds.disabledOwner);
  await owner.prisma.user_controls.createMany({
    data: Object.values(userIds).map((id, index) => ({
      id,
      team_id: null,
      email: `authority-entitlement-verifier-${index}@example.invalid`,
      password_hash: "verification-fixture-not-a-credential",
      status: id === userIds.disabledOwner ? "disabled" : "enabled",
      user_can_create_custom_provider: 1,
      user_can_create_access_point: 1,
      created_at: fixtureAt,
      updated_at: fixtureAt,
    })),
  });
  const creditUsers = [
    userIds.primaryBuyer,
    userIds.raceBuyer,
    userIds.cancelBuyer,
    userIds.refundBuyer,
    userIds.refundRollbackBuyer,
    userIds.purchaseRollbackBuyer,
    userIds.teamRollbackBuyer,
    userIds.providerBuyer,
    userIds.providerRollbackBuyer,
    userIds.planBuyer,
    userIds.fundedRollbackBuyer,
  ];
  await owner.prisma.credit_accounts.createMany({
    data: creditUsers.map((userId) => ({
      id: `credit_${userId}`,
      scope_ref: `user:${userId}`,
      status: "active",
      balance_snap_units: 100_000_000n,
      balance_snap_ledger_event_id: null,
      balance_snap_updated_at: fixtureAt,
      created_at: fixtureAt,
      updated_at: fixtureAt,
    })),
  });
  await owner.prisma.cpa_instances.upsert({
    where: { id: "cpa_default" },
    create: { id: "cpa_default", name: "Verification CPA", status: "enabled", created_at: fixtureAt, updated_at: fixtureAt },
    update: { status: "enabled", updated_at: fixtureAt },
  });
  await owner.prisma.teams.createMany({
    data: [
      teamFixture(teamIds.providerPurchase, userIds.providerBuyer, "Provider Purchase Team"),
      teamFixture(teamIds.providerPurchaseRollback, userIds.providerRollbackBuyer, "Provider Purchase Rollback Team"),
      teamFixture(teamIds.providerAdmin, userIds.primaryBuyer, "Provider Admin Team"),
      teamFixture(teamIds.providerAdminRollback, userIds.primaryBuyer, "Provider Rollback Team"),
      teamFixture(teamIds.providerNone, userIds.primaryBuyer, "Provider None Team"),
      teamFixture(teamIds.providerPermanent, userIds.primaryBuyer, "Provider Permanent Team"),
      teamFixture(teamIds.partner, userIds.planBuyer, "Partner Team"),
    ],
  });
  assert(enabledUsers.length > 0, "fixture_enabled_users_present");
}

async function seedTeamAccessPointProvider(
  owner: PostgresClientOwner,
  input: { providerId: string; providerModelId: string; providerCostId: string; ownerId: string; teamId: string },
): Promise<void> {
  await owner.prisma.providers.create({ data: {
    id: input.providerId,
    owner_id: input.ownerId,
    scope_ref: `team:${input.teamId}`,
    name: "Verification Team AccessPoint Provider",
    kind: "openai-compatible",
    status: "disabled",
    base_url_resolver: "fixed:https://example.invalid",
    credential_resolver: "api-key:verifier",
    models_resolver: "static:team-verification-model",
    config_json: "{}",
    cpa_instance_id: "cpa_default",
    created_at: fixtureAt,
    updated_at: fixtureAt,
  } });
  await owner.prisma.provider_models.create({ data: {
    id: input.providerModelId,
    provider_id: input.providerId,
    provider_model_name: "team-verification-model",
    display_name: "Team Verification Model",
    status: "disabled",
    created_at: fixtureAt,
    updated_at: fixtureAt,
  } });
  await owner.prisma.provider_model_costs.create({ data: {
    id: input.providerCostId,
    provider_id: input.providerId,
    provider_model_name: "team-verification-model",
    input_per_1m: 1,
    cached_input_per_1m: 1,
    cache_write_per_1m: 1,
    output_per_1m: 1,
    input_price_units_per_1m: 1_000_000n,
    cached_input_price_units_per_1m: 1_000_000n,
    cache_write_price_units_per_1m: 1_000_000n,
    output_price_units_per_1m: 1_000_000n,
    source: "fixed-verifier",
    status: "enabled",
    created_at: fixtureAt,
    updated_at: fixtureAt,
  } });
}

async function seedPartnerOrderFixture(owner: PostgresClientOwner, partnerPlanId: string, actorOwnerUserId: string): Promise<void> {
  await owner.prisma.$transaction(async (transaction) => {
    await transaction.payment_channels.create({ data: {
      id: "verify_partner_payment_channel",
      code: "verify-partner-channel",
      display_name: "Verification Partner Channel",
      payment_network: "verification",
      payment_asset: "USD",
      settlement_mode: "manual",
      recipient_identifier_type: "reference",
      transaction_reference_type: "reference",
      recipient_identifier: "verification-only",
      recipient_identifier_display: "verification-only",
      normalized_recipient_identifier_hash: "verify_partner_recipient_hash",
      payment_instruction: null,
      status: "enabled",
      created_by_user_id: actorOwnerUserId,
      created_at: fixtureAt,
    } });
    await transaction.service_products.create({ data: {
      id: "verify_partner_service_product",
      code: "verify_partner_service",
      version: 1,
      display_name: "Verification Partner Service",
      description: null,
      fulfillment_effect: "partner_team_annual",
      duration_seconds: 31_536_000,
      partner_plan_id: partnerPlanId,
      status: "enabled",
      created_by_user_id: actorOwnerUserId,
      created_at: fixtureAt,
    } });
    await transaction.service_product_listings.create({ data: {
      id: "verify_partner_service_listing",
      product_id: "verify_partner_service_product",
      payment_channel_id: "verify_partner_payment_channel",
      price_amount_units: 1_000_000n,
      status: "enabled",
      created_at: fixtureAt,
    } });
    await transaction.service_orders.create({ data: {
      id: "verify_partner_order",
      buyer_user_id: userIds.planBuyer,
      target_partner_team_id: teamIds.partner,
      product_id: "verify_partner_service_product",
      product_listing_id: "verify_partner_service_listing",
      payment_channel_id: "verify_partner_payment_channel",
      product_code: "verify_partner_service",
      product_version: 1,
      product_display_name: "Verification Partner Service",
      fulfillment_effect: "partner_team_annual",
      duration_seconds: 31_536_000,
      partner_plan_id: partnerPlanId,
      purchase_intent: "new",
      expected_payment_amount_units: 1_000_000n,
      confirmed_received_amount_units: 1_000_000n,
      payment_asset: "USD",
      payment_network: "verification",
      normalized_transaction_reference_hash: null,
      transaction_reference_tail: null,
      payment_submitted_at: fixtureAt,
      reviewed_by_user_id: actorOwnerUserId,
      reviewed_at: fixtureAt,
      review_note: null,
      status: "fulfilled",
      create_idempotency_key_hash: "verify_partner_order_idempotency",
      create_request_hash: "verify_partner_order_request",
      created_at: fixtureAt,
      updated_at: fixtureAt,
    } });
  });
}

function teamFixture(id: string, ownerId: string, name: string) {
  return {
    id,
    owner_id: ownerId,
    name,
    status: "enabled",
    team_owner_can_manage_member_api_key_limit: 0,
    team_owner_can_manage_member_credit: 0,
    team_owner_can_create_custom_provider: 0,
    team_owner_can_create_access_point: 0,
    invite_email_domain_pattern: null,
    created_at: fixtureAt,
    updated_at: fixtureAt,
  };
}

function planInput(name: string, actorUserId: string) {
  return {
    ownerId: actorUserId,
    scopeRef: "global:" as const,
    name,
    description: null,
    adminNote: null,
    durationSeconds: 86_400,
    status: "enabled" as const,
    catalogStatus: "unlisted" as const,
    accessPointIds: [],
    budgetLimits: [],
    billingMode: "prepaid",
    purchaseAmount: 0,
    actorUserId,
    requestId: `req_${name.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "")}`,
  };
}

function subscriptionInput(
  id: string,
  planId: string,
  scopeRef: `user:${string}` | `team:${string}`,
  effectiveStart: string,
  effectiveEnd: string,
  actorUserId: string,
) {
  return {
    id,
    planId,
    scopeRef,
    source: "verification",
    purchasedByUserId: actorUserId,
    fundingAccountId: null,
    originCardId: null,
    priority: 100,
    effectiveStart,
    effectiveEnd,
    actor: { actorType: "user" as const, actorId: actorUserId },
    auditSource: "owner" as const,
    requestId: `req_${id}`,
  };
}

async function createAndListProduct(
  application: AuthorityEntitlementApplicationService,
  input: Parameters<AuthorityEntitlementApplicationService["createAuthorityProductVersion"]>[0],
) {
  const created = await application.createAuthorityProductVersion({ ...input, requestId: `req_${input.code}_create` });
  const listed = await application.listAuthorityProductVersion(created.id, input.actorOwnerUserId, `req_${input.code}_list`);
  assert(listed.lifecycle === "listed" && listed.id === created.id, `product_listed:${input.code}`);
  return listed;
}

async function activeBootstrapOwnerCount(owner: PostgresClientOwner): Promise<number> {
  return owner.prisma.authority_grants.count({
    where: { role_domain: "platform", role_code: "owner", source_kind: "system_bootstrap", lifecycle: "active" },
  });
}

async function purchasedAuthorityFactCounts(owner: PostgresClientOwner, buyerUserId: string): Promise<Record<string, number>> {
  const result = await owner.query<{ purchases: number; grants: number; quotas: number }>(`
    SELECT
      (SELECT COUNT(*)::bigint FROM authority_purchases WHERE buyer_user_id = $1) AS purchases,
      (SELECT COUNT(*)::bigint FROM authority_grants WHERE beneficiary_user_id = $1 AND source_kind = 'product_purchase') AS grants,
      (SELECT COUNT(*)::bigint FROM authority_grant_quotas quota
        INNER JOIN authority_grants grant_row ON grant_row.id = quota.grant_id
        WHERE grant_row.beneficiary_user_id = $1 AND grant_row.source_kind = 'product_purchase') AS quotas
  `, [buyerUserId]);
  const row = result.rows[0];
  assert(row !== undefined, "purchased_authority_fact_counts_missing");
  return row;
}

async function providerPurchaseSettlementCount(owner: PostgresClientOwner, buyerUserId: string): Promise<number> {
  const result = await owner.query<{ count: number }>(`
    SELECT COUNT(*)::bigint AS count
    FROM seller_settlement_events settlement
    INNER JOIN authority_purchases purchase ON purchase.id = settlement.authority_purchase_id
    WHERE purchase.buyer_user_id = $1
  `, [buyerUserId]);
  return result.rows[0]?.count ?? 0;
}

async function fundedSubscriptionSettlementCount(owner: PostgresClientOwner, planId: string): Promise<number> {
  const result = await owner.query<{ count: number }>(`
    SELECT COUNT(*)::bigint AS count
    FROM seller_settlement_events settlement
    INNER JOIN plan_subscriptions subscription ON subscription.id = settlement.plan_subscription_id
    WHERE subscription.plan_id = $1
  `, [planId]);
  return result.rows[0]?.count ?? 0;
}

async function scopedFailureTriggerCount(owner: PostgresClientOwner): Promise<number> {
  const result = await owner.query<{ count: number }>(`
    SELECT COUNT(*)::bigint AS count
    FROM pg_trigger
    WHERE NOT tgisinternal AND tgname LIKE 'verification_fail_mod03_%'
  `);
  return result.rows[0]?.count ?? 0;
}

async function rollbackCounts(owner: PostgresClientOwner): Promise<Record<string, number>> {
  const [purchases, grants, quotas, uses, refunds, teams, memberships, permissions, providerEntitlements, subscriptions, ledger, settlements, audits] = await Promise.all([
    owner.prisma.authority_purchases.count(),
    owner.prisma.authority_grants.count(),
    owner.prisma.authority_grant_quotas.count(),
    owner.prisma.authority_uses.count(),
    owner.prisma.authority_refunds.count(),
    owner.prisma.teams.count(),
    owner.prisma.team_memberships.count(),
    owner.prisma.resource_permissions.count(),
    owner.prisma.team_provider_entitlements.count(),
    owner.prisma.plan_subscriptions.count(),
    owner.prisma.credit_ledger_events.count(),
    owner.prisma.seller_settlement_events.count(),
    owner.prisma.audit_logs.count(),
  ]);
  return { purchases, grants, quotas, uses, refunds, teams, memberships, permissions, providerEntitlements, subscriptions, ledger, settlements, audits };
}

async function compatibilityStateDigest(owner: PostgresClientOwner): Promise<string> {
  const result = await owner.query<{ digest: string }>(`
    SELECT md5(jsonb_build_object(
      'access_points', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb) FROM access_points row_value),
      'api_keys', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb) FROM api_keys row_value),
      'authority_grants', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb) FROM authority_grants row_value),
      'authority_grant_quotas', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb) FROM authority_grant_quotas row_value),
      'authority_uses', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb) FROM authority_uses row_value),
      'plans', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb) FROM plans row_value),
      'plan_subscriptions', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb) FROM plan_subscriptions row_value),
      'team_provider_entitlements', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb) FROM team_provider_entitlements row_value),
      'audit_logs', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb) FROM audit_logs row_value)
    )::text) AS digest
  `);
  const digest = result.rows[0]?.digest;
  if (!digest) throw new Error("authority_entitlement_assertion_failed:compatibility_digest_missing");
  return digest;
}

async function withScopedInsertFailure<T>(
  owner: PostgresClientOwner,
  input: { suffix: string; table: string; when: string },
  callback: () => Promise<T>,
): Promise<T> {
  const suffix = safeIdentifier(input.suffix);
  const table = safeIdentifier(input.table);
  const functionName = `verification_fail_mod03_${suffix}`;
  const triggerName = `verification_fail_mod03_${suffix}`;
  await owner.prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'verification scoped failure' USING ERRCODE = '55000'; END $$
  `);
  try {
    await owner.prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "${table}"
      FOR EACH ROW WHEN (${input.when}) EXECUTE FUNCTION "${functionName}"()
    `);
    try {
      return await callback();
    } finally {
      await owner.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "${table}"`);
    }
  } finally {
    await owner.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
  }
}

function section(checks: readonly string[]): VerificationSection {
  return Object.freeze({ passed: true, checks: Object.freeze([...checks]) });
}

function assertSameCounts(actual: Record<string, number>, expected: Record<string, number>, name: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), name);
}

function assertExpectedBootstrapRaceRejection(error: unknown): void {
  if (error instanceof RelayError && error.code === "platform_owner_already_exists") return;
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (["P2002", "P2034", "23505", "40001"].includes(code)
    || message.includes("authority_grants_active_owner_unique")
    || message.includes("write conflict")) return;
  throw new Error("authority_entitlement_assertion_failed:bootstrap_concurrency_unexpected_rejection");
}

function assertExpectedOneUnitRaceRejection(error: unknown): void {
  assertExpectedConcurrentRejection(error, "authority_quota_exhausted");
}

function assertExpectedConcurrentRejection(error: unknown, relayCode: string): void {
  assertRelayError(error, relayCode);
}

function assertRelayError(error: unknown, code: string): void {
  if (error instanceof RelayError && error.code === code) return;
  const actual = error instanceof RelayError
    ? error.code
    : error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : error instanceof Error
        ? error.constructor.name
        : typeof error;
  throw new Error(`authority_entitlement_assertion_failed:expected_relay_error:${code}:actual:${actual}`);
}

async function expectRelay(code: string, callback: () => Promise<unknown>): Promise<void> {
  try {
    await callback();
  } catch (error) {
    assertRelayError(error, code);
    return;
  }
  throw new Error(`authority_entitlement_assertion_failed:expected_relay_error:${code}`);
}

async function expectFailure(callback: () => Promise<unknown>): Promise<void> {
  try {
    await callback();
  } catch {
    return;
  }
  throw new Error("authority_entitlement_assertion_failed:expected_failure");
}

function assertForbiddenSecretPatternsAbsent(value: string, name: string): void {
  const forbidden = /(?:postgres(?:ql)?:\/\/|bearer\s+[A-Za-z0-9]|sk-[A-Za-z0-9_-]{8,}|"(?:authorization|apiKey|credential|password|secret|prompt|requestBody)"\s*:\s*"[^"]+")/iu;
  assert(!forbidden.test(value), name);
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function safeIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error("authority_entitlement_identifier_invalid");
  return value;
}

function safeSqlLiteral(value: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/u.test(value)) throw new Error("authority_entitlement_sql_literal_invalid");
  return value;
}

function assert(condition: boolean, name: string): asserts condition {
  if (!condition) throw new Error(`authority_entitlement_assertion_failed:${name}`);
}

function run(
  command: string,
  args: string[],
  input?: string,
  environment: NodeJS.ProcessEnv = process.env,
  runtime?: PostgresVerificationRuntime,
): string {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: environment,
    input,
    encoding: "utf8",
    maxBuffer: maximumCommandOutputBytes,
  });
  if (result.status !== 0) {
    const rawDetail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const detail = runtime?.redact(rawDetail) ?? rawDetail;
    throw new Error(`${command}_failed:${result.status ?? "signal"}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout;
}

await main();
