import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION } from "@frely/postgres/migration-state";
import { createPostgresClient } from "@frely/postgres/server";
import { PostgresVerificationRuntime } from "./postgres-verification-runtime.js";
import {
  ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM,
  ACCESS_POINT_SCOPE_IDEMPOTENCY_REPAIR_MIGRATION,
  inspectAccessPointScopeIdempotencyRecovery,
  recoverAccessPointScopeIdempotencyMigration,
} from "./prisma-access-point-scope-idempotency-recovery.js";
import {
  REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION,
  inspectProviderAttemptReferenceRecovery,
  recoverProviderAttemptReferenceMigration,
} from "./prisma-provider-attempt-reference-recovery.js";
import { runPrismaMigrateResolveRolledBack } from "./prisma-migrate-cli.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const postgresPackageRoot = join(packageRoot, "..", "postgres");
const prismaConfigPath = join(postgresPackageRoot, "prisma.config.ts");
const prismaBinPath = join(postgresPackageRoot, "node_modules", ".bin", "prisma");
const migrationsRoot = join(postgresPackageRoot, "prisma", "migrations");
const providerInvocationStageOneMigration = "20260813003000_provider_invocation_stage_1";
const providerAttemptMutableFieldsRepair = "20260824000000_repair_provider_attempt_mutable_fields";
const providerAttemptMutableFieldsRepairChecksum = "79e2e53a39d00cd0536b0a6b2b36f193f13395a9c36dd3480dcf2d6039b091ca";
const providerAttemptTransitionFunctionRepair = "20260824001000_repair_provider_attempt_transition_function";
const providerAttemptTransitionFunctionRepairChecksum = "cc455e6eb4380926100eba76772f102d7dc823d3c2c520a83815e9699756bbf1";
const providerModelStableRoutingReference = "20260824001100_provider_model_stable_routing_reference";
const providerModelStableRoutingReferenceChecksum = "fb33b0aca09823a74fae8abcd3569232021320ad7b533472e1f90610b3a10104";
const requestExecutionStableReferences = "20260824001200_request_execution_stable_references";
const requestExecutionStableReferencesChecksum = "f34f16d409d1ab3af9ed22d83b3f6a1d030df6b1d725b6fdc11aa8919006afa2";
const providerAttemptMutableFieldsReassert = "20260824001300_reassert_provider_attempt_mutable_fields";
const providerAttemptTransitionFunctionReassert = "20260824001400_reassert_provider_attempt_transition_function";
const cpaBasicProviderAttemptContract = "20260824002000_add_cpa_basic_provider_attempt_contract";
const cpaBasicProviderAttemptContractChecksum = "e07ea467831dc7ec76a59073c143c87ae238abc2423d1579aa43408128e0ea74";
const providerAttemptTransitionTriggerScope = "20260824002100_scope_provider_attempt_transition_trigger";
const providerAttemptTransitionTriggerScopeChecksum = "e8a032184cc4d3e2c86dbb7006f5d959fab57030c9bc45d209be48157984c2a3";
const removeMcpRuntime = "20260824002200_remove_mcp_runtime";
const identityTenancyContextExpand = "20260824003000_identity_tenancy_context_expand";
const identityMigrationSnapshotConsistency = "20260824004000_identity_migration_snapshot_consistency";
const billingKernelClosure = "20260824005000_modernization_04_billing_kernel_closure";
const image = process.env.FRIDAY_RELAY_PRISMA_TAKEOVER_POSTGRES_IMAGE ?? "postgres:16-alpine";
const user = "friday_takeover";
const password = "friday_takeover_local_only";
const legacyDatabase = "friday_takeover_legacy";
const freshRecoveryDatabase = "friday_takeover_fresh_recovery";
const integrationLineageDatabase = "friday_takeover_integration_lineage";
const failedStableReferenceDatabase = "friday_takeover_failed_stable_reference";
const driftDatabase = "friday_takeover_provider_attempt_drift";
const intermediateDriftDatabase = "friday_takeover_provider_attempt_intermediate_drift";
const failedAccessPointScopeIdempotencyDatabase = "friday_takeover_failed_access_point_scope_idempotency";
const failedDatabase = "friday_takeover_failed";
const maxBuffer = 32 * 1024 * 1024;
let verificationRuntime: PostgresVerificationRuntime;

async function main(): Promise<void> {
  const names = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migrations = await Promise.all(names.map(async (name) => {
    const sql = await readFile(join(migrationsRoot, name, "migration.sql"), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
  if (migrations.length < 2) throw new Error("prisma_takeover_requires_multiple_migrations");
  const stageOneIndex = names.indexOf(providerInvocationStageOneMigration);
  const mutableFieldsRepairIndex = names.indexOf(providerAttemptMutableFieldsRepair);
  const transitionFunctionRepairIndex = names.indexOf(providerAttemptTransitionFunctionRepair);
  const providerModelStableRoutingReferenceIndex = names.indexOf(providerModelStableRoutingReference);
  const requestExecutionStableReferencesIndex = names.indexOf(requestExecutionStableReferences);
  const mutableFieldsReassertIndex = names.indexOf(providerAttemptMutableFieldsReassert);
  const transitionFunctionReassertIndex = names.indexOf(providerAttemptTransitionFunctionReassert);
  const cpaBasicContractIndex = names.indexOf(cpaBasicProviderAttemptContract);
  const transitionTriggerScopeIndex = names.indexOf(providerAttemptTransitionTriggerScope);
  const removeMcpRuntimeIndex = names.indexOf(removeMcpRuntime);
  const identityTenancyContextExpandIndex = names.indexOf(identityTenancyContextExpand);
  const identityMigrationSnapshotConsistencyIndex = names.indexOf(identityMigrationSnapshotConsistency);
  const billingKernelClosureIndex = names.indexOf(billingKernelClosure);
  const accessPointScopeIdempotencyIndex = names.indexOf(ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION);
  const accessPointScopeIdempotencyRepairIndex = names.indexOf(ACCESS_POINT_SCOPE_IDEMPOTENCY_REPAIR_MIGRATION);
  if (
    stageOneIndex < 0
    || mutableFieldsRepairIndex <= stageOneIndex
    || transitionFunctionRepairIndex !== mutableFieldsRepairIndex + 1
    || providerModelStableRoutingReferenceIndex !== transitionFunctionRepairIndex + 1
    || requestExecutionStableReferencesIndex !== providerModelStableRoutingReferenceIndex + 1
    || mutableFieldsReassertIndex !== requestExecutionStableReferencesIndex + 1
    || transitionFunctionReassertIndex !== mutableFieldsReassertIndex + 1
    || cpaBasicContractIndex !== transitionFunctionReassertIndex + 1
    || transitionTriggerScopeIndex !== cpaBasicContractIndex + 1
    || removeMcpRuntimeIndex !== transitionTriggerScopeIndex + 1
    || identityTenancyContextExpandIndex !== removeMcpRuntimeIndex + 1
    || identityMigrationSnapshotConsistencyIndex !== identityTenancyContextExpandIndex + 1
    || billingKernelClosureIndex !== identityMigrationSnapshotConsistencyIndex + 1
    || accessPointScopeIdempotencyIndex <= billingKernelClosureIndex
    || accessPointScopeIdempotencyRepairIndex <= accessPointScopeIdempotencyIndex
  ) {
    throw new Error("prisma_takeover_provider_attempt_migration_order_invalid");
  }
  if (migrations[mutableFieldsRepairIndex]?.checksum !== providerAttemptMutableFieldsRepairChecksum) {
    throw new Error("prisma_takeover_provider_attempt_mutable_fields_repair_checksum_invalid");
  }
  if (migrations[transitionFunctionRepairIndex]?.checksum !== providerAttemptTransitionFunctionRepairChecksum) {
    throw new Error("prisma_takeover_provider_attempt_transition_function_repair_checksum_invalid");
  }
  if (migrations[providerModelStableRoutingReferenceIndex]?.checksum !== providerModelStableRoutingReferenceChecksum) {
    throw new Error("prisma_takeover_provider_model_stable_routing_reference_checksum_invalid");
  }
  if (migrations[requestExecutionStableReferencesIndex]?.checksum !== requestExecutionStableReferencesChecksum) {
    throw new Error("prisma_takeover_request_execution_stable_references_checksum_invalid");
  }
  if (migrations[mutableFieldsReassertIndex]?.checksum !== providerAttemptMutableFieldsRepairChecksum) {
    throw new Error("prisma_takeover_provider_attempt_mutable_fields_reassert_checksum_invalid");
  }
  if (migrations[transitionFunctionReassertIndex]?.checksum !== providerAttemptTransitionFunctionRepairChecksum) {
    throw new Error("prisma_takeover_provider_attempt_transition_function_reassert_checksum_invalid");
  }
  if (migrations[cpaBasicContractIndex]?.checksum !== cpaBasicProviderAttemptContractChecksum) {
    throw new Error("prisma_takeover_cpa_basic_provider_attempt_contract_checksum_invalid");
  }
  if (migrations[transitionTriggerScopeIndex]?.checksum !== providerAttemptTransitionTriggerScopeChecksum) {
    throw new Error("prisma_takeover_provider_attempt_transition_trigger_scope_checksum_invalid");
  }
  if (migrations[accessPointScopeIdempotencyIndex]?.checksum !== ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM) {
    throw new Error("prisma_takeover_access_point_scope_idempotency_checksum_invalid");
  }

  verificationRuntime = await PostgresVerificationRuntime.start({
    verifier: "prisma_takeover",
    databases: [
      legacyDatabase,
      freshRecoveryDatabase,
      integrationLineageDatabase,
      failedStableReferenceDatabase,
      driftDatabase,
      intermediateDriftDatabase,
      failedAccessPointScopeIdempotencyDatabase,
      failedDatabase,
    ],
    docker: { image, user, password, containerPrefix: "friday-relay-prisma-takeover" },
  });
  let primaryFailure: unknown;
  try {
    for (const migration of migrations) psql(legacyDatabase, migration.sql);
    psql(legacyDatabase, prismaHistoryTableSql());
    for (const [index, migration] of migrations.entries()) {
      psql(legacyDatabase, successfulHistorySql(migration, index));
    }
    const legacyUrl = connectionString(legacyDatabase);
    prisma("status", legacyUrl, true);
    prisma("deploy", legacyUrl, true);
    prisma("status", legacyUrl, true);

    const freshRecoveryUrl = connectionString(freshRecoveryDatabase);
    const freshRecovery = await recoverStableReferenceMigration(freshRecoveryUrl);
    if (freshRecovery.status !== "not_applicable" || freshRecovery.triggerChanged !== false) {
      throw new Error("prisma_takeover_fresh_recovery_not_noop");
    }
    prisma("deploy", freshRecoveryUrl, true);
    prisma("status", freshRecoveryUrl, true);
    assertExactMigrationHistory(freshRecoveryDatabase, migrations.map((migration) => migration.name));
    psql(freshRecoveryDatabase, `UPDATE "_prisma_migrations" SET "checksum" = '${"f".repeat(64)}' WHERE "migration_name" = '${requestExecutionStableReferences}';`);
    await expectInspectionFailure(freshRecoveryUrl, "provider_attempt_reference_recovery_successful_checksum_invalid");
    psql(freshRecoveryDatabase, `UPDATE "_prisma_migrations" SET "checksum" = '${requestExecutionStableReferencesChecksum}' WHERE "migration_name" = '${requestExecutionStableReferences}';`);

    const deployedRepairPrefix = migrations.slice(0, providerModelStableRoutingReferenceIndex);
    for (const migration of deployedRepairPrefix) psql(integrationLineageDatabase, migration.sql);
    psql(integrationLineageDatabase, prismaHistoryTableSql());
    for (const [index, migration] of deployedRepairPrefix.entries()) {
      psql(integrationLineageDatabase, successfulHistorySql(migration, index));
    }
    psql(integrationLineageDatabase, preStableReferenceProviderAttemptFixtureSql());
    const integrationLineageUrl = connectionString(integrationLineageDatabase);
    await assertReadOnlyRecoveryInspectionTransaction(integrationLineageUrl);
    psql(integrationLineageDatabase, `
      SET session_replication_role = replica;
      INSERT INTO "provider_models"
      SELECT 'provider_model_reference_recovery_duplicate', "provider_id", "provider_model_name", "display_name", "status", "created_at", "updated_at"
      FROM "provider_models" WHERE "id" = 'provider_model_reference_recovery';
      SET session_replication_role = origin;
    `);
    await expectInspectionFailure(integrationLineageUrl, "provider_attempt_reference_recovery_model_resolution_invalid");
    psql(integrationLineageDatabase, `
      SET session_replication_role = replica;
      DELETE FROM "provider_models" WHERE "id" = 'provider_model_reference_recovery_duplicate';
      SET session_replication_role = origin;
    `);
    psql(integrationLineageDatabase, `
      CREATE OR REPLACE FUNCTION "friday_relay_validate_provider_attempt_terminal"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF false THEN
          RAISE EXCEPTION 'Provider Attempt dispatch transition is invalid';
          RAISE EXCEPTION 'Provider Attempt terminal transition is invalid';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await expectInspectionFailure(integrationLineageUrl, "provider_attempt_reference_recovery_function_invalid");
    psql(integrationLineageDatabase, functionDefinitionSql(migrations[transitionFunctionRepairIndex]!.sql, "friday_relay_validate_provider_attempt_terminal"));
    psql(integrationLineageDatabase, `
      CREATE OR REPLACE FUNCTION "friday_relay_reject_immutable_update"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NEW;
      END $$;
    `);
    await expectInspectionFailure(integrationLineageUrl, "provider_attempt_reference_recovery_function_invalid");
    psql(integrationLineageDatabase, functionDefinitionSql(migrations[0]!.sql, "friday_relay_reject_immutable_update"));
    const integrationAttemptsBefore = capturePreStableReferenceProviderAttemptSnapshot(integrationLineageDatabase);
    prisma("status", integrationLineageUrl, false);
    const pendingInspection = await inspectStableReferenceMigration(integrationLineageUrl);
    if (pendingInspection.status !== "ready_pending" || pendingInspection.triggerState !== "unscoped" || pendingInspection.resolveRequired !== false) {
      throw new Error("prisma_takeover_pending_stable_reference_inspection_invalid");
    }
    await assertRecoveryLockContention(integrationLineageUrl);
    const pendingRecovery = await recoverStableReferenceMigration(integrationLineageUrl);
    if (pendingRecovery.status !== "prepared_pending" || pendingRecovery.triggerChanged !== true) {
      throw new Error("prisma_takeover_pending_stable_reference_recovery_invalid");
    }
    prisma("deploy", integrationLineageUrl, true);
    prisma("status", integrationLineageUrl, true);
    assertExactMigrationHistory(integrationLineageDatabase, migrations.map((migration) => migration.name));
    assertProviderAttemptRepairHistory(integrationLineageDatabase);
    assertStableReferenceRecoveryResult(integrationLineageDatabase, integrationAttemptsBefore);

    const deployedStableRoutingPrefix = migrations.slice(0, requestExecutionStableReferencesIndex);
    for (const migration of deployedStableRoutingPrefix) psql(failedStableReferenceDatabase, migration.sql);
    psql(failedStableReferenceDatabase, prismaHistoryTableSql());
    for (const [index, migration] of deployedStableRoutingPrefix.entries()) {
      psql(failedStableReferenceDatabase, successfulHistorySql(migration, index));
    }
    psql(failedStableReferenceDatabase, preStableReferenceProviderAttemptFixtureSql());
    psql(failedStableReferenceDatabase, scalePreStableReferenceProviderAttemptsSql());
    assertScaledStableReferenceFixture(failedStableReferenceDatabase);
    const failedAttemptColumns = stableReferenceProviderAttemptColumns(failedStableReferenceDatabase);
    const failedAttemptsBefore = preStableReferenceProviderAttemptDigest(failedStableReferenceDatabase, failedAttemptColumns);
    const failedStableReferenceUrl = connectionString(failedStableReferenceDatabase);
    prisma("deploy", failedStableReferenceUrl, false);
    assertFailedStableReferenceRollback(failedStableReferenceDatabase);
    psql(failedStableReferenceDatabase, `DROP INDEX "provider_models_provider_identity_unique";`);
    await expectInspectionFailure(failedStableReferenceUrl, "provider_attempt_reference_recovery_stable_routing_index_invalid");
    psql(failedStableReferenceDatabase, `CREATE UNIQUE INDEX "provider_models_provider_identity_unique" ON "provider_models" ("provider_id", "provider_model_name");`);
    psql(failedStableReferenceDatabase, `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'provider_models_provider_identity_unique'::regclass;`);
    await expectInspectionFailure(failedStableReferenceUrl, "provider_attempt_reference_recovery_stable_routing_index_invalid");
    psql(failedStableReferenceDatabase, `UPDATE pg_index SET indisvalid = true WHERE indexrelid = 'provider_models_provider_identity_unique'::regclass;`);
    const failedInspection = await inspectStableReferenceMigration(failedStableReferenceUrl);
    if (failedInspection.status !== "ready_failed_zero_step" || failedInspection.triggerState !== "unscoped" || failedInspection.resolveRequired !== true) {
      throw new Error("prisma_takeover_failed_stable_reference_inspection_invalid");
    }
    await interruptStableReferenceRecoveryBeforeResolve(failedStableReferenceUrl);
    const interruptedInspection = await inspectStableReferenceMigration(failedStableReferenceUrl);
    if (interruptedInspection.status !== "ready_failed_zero_step" || interruptedInspection.triggerState !== "scoped" || interruptedInspection.resolveRequired !== true) {
      throw new Error("prisma_takeover_interrupted_stable_reference_recovery_invalid");
    }
    const failedRecovery = await recoverStableReferenceMigration(failedStableReferenceUrl);
    if (failedRecovery.status !== "resolved_failed_zero_step" || failedRecovery.triggerChanged !== false || !failedRecovery.resolveOutputDigest) {
      throw new Error("prisma_takeover_failed_stable_reference_recovery_invalid");
    }
    const repeatedRecovery = await recoverStableReferenceMigration(failedStableReferenceUrl);
    if (repeatedRecovery.status !== "prepared_pending" || repeatedRecovery.triggerChanged !== false || repeatedRecovery.resolveOutputDigest !== undefined) {
      throw new Error("prisma_takeover_failed_stable_reference_recovery_not_idempotent");
    }
    prisma("status", failedStableReferenceUrl, false);
    prisma("deploy", failedStableReferenceUrl, true);
    prisma("status", failedStableReferenceUrl, true);
    assertExactMigrationHistory(failedStableReferenceDatabase, migrations.map((migration) => migration.name));
    assertProviderAttemptRepairHistory(failedStableReferenceDatabase);
    assertStableReferenceRecoveryResult(failedStableReferenceDatabase, undefined, 90_118);
    if (preStableReferenceProviderAttemptDigest(failedStableReferenceDatabase, failedAttemptColumns) !== failedAttemptsBefore) {
      throw new Error("prisma_takeover_scaled_stable_reference_historical_row_rewritten");
    }

    const preRepairMigrations = migrations.slice(0, mutableFieldsReassertIndex);
    for (const migration of preRepairMigrations) psql(driftDatabase, migration.sql);
    psql(driftDatabase, prismaHistoryTableSql());
    for (const [index, migration] of preRepairMigrations.entries()) {
      psql(driftDatabase, successfulHistorySql(migration, index));
    }
    psql(driftDatabase, staleProviderAttemptObjectsSql());
    psql(driftDatabase, providerAttemptFixtureSql());
    const historicalAttemptColumns = stableReferenceProviderAttemptColumns(driftDatabase);
    const historicalAttemptBeforeRepairs = providerAttemptSnapshot(driftDatabase, "attempt_historical", historicalAttemptColumns);

    const staleTriggerDefinition = psqlScalar(driftDatabase, `
      SELECT pg_get_triggerdef(oid)
      FROM pg_trigger
      WHERE tgrelid = 'request_provider_attempts'::regclass
        AND tgname = 'request_provider_attempts_immutable_update'
        AND NOT tgisinternal
    `);
    const staleFunctionDefinition = psqlScalar(driftDatabase, `
      SELECT pg_get_functiondef('friday_relay_validate_provider_attempt_terminal()'::regprocedure)
    `);
    if (staleTriggerDefinition.includes("cost_exposure")) {
      throw new Error("prisma_takeover_provider_attempt_trigger_not_stale");
    }
    if (staleFunctionDefinition.includes("Provider Attempt dispatch transition is invalid")) {
      throw new Error("prisma_takeover_provider_attempt_function_not_stale");
    }
    expectPsqlFailure(
      driftDatabase,
      `UPDATE "request_provider_attempts" SET "cost_exposure" = 'accruing' WHERE "id" = 'attempt_drift';`,
      "Provider Attempt identity cannot be updated",
    );

    const driftUrl = connectionString(driftDatabase);
    prisma("deploy", driftUrl, true);
    prisma("status", driftUrl, true);
    const historicalAttemptAfterRepairs = providerAttemptSnapshot(driftDatabase, "attempt_historical", historicalAttemptColumns);
    if (historicalAttemptAfterRepairs !== historicalAttemptBeforeRepairs) {
      throw new Error("prisma_takeover_provider_attempt_historical_row_rewritten");
    }
    if (psqlScalar(driftDatabase, `SELECT "invocation_contract" FROM "request_provider_attempts" WHERE "id" = 'attempt_historical'`) !== "protected@1") {
      throw new Error("prisma_takeover_provider_attempt_existing_contract_invalid");
    }
    const repairedTriggerDefinition = psqlScalar(driftDatabase, `
      SELECT pg_get_triggerdef(oid)
      FROM pg_trigger
      WHERE tgrelid = 'request_provider_attempts'::regclass
        AND tgname = 'request_provider_attempts_immutable_update'
        AND NOT tgisinternal
    `);
    const repairedFunctionDefinition = psqlScalar(driftDatabase, `
      SELECT pg_get_functiondef('friday_relay_validate_provider_attempt_terminal()'::regprocedure)
    `);
    if (!repairedTriggerDefinition.includes("cost_exposure")) {
      throw new Error("prisma_takeover_provider_attempt_trigger_not_repaired");
    }
    if (!repairedFunctionDefinition.includes("Provider Attempt dispatch transition is invalid")) {
      throw new Error("prisma_takeover_provider_attempt_function_not_repaired");
    }
    assertProviderAttemptRepairHistory(driftDatabase);
    psql(driftDatabase, `
      UPDATE "request_provider_attempts"
      SET "cost_exposure" = 'accruing'
      WHERE "id" = 'attempt_drift';
      UPDATE "request_provider_attempts"
      SET "outcome" = 'succeeded',
          "trusted_usage_source" = 'provider',
          "ended_at" = '2026-08-24T00:00:01.000Z',
          "cost_exposure" = 'stopped',
          "final_usage_evidence" = 'final',
          "usage_settled" = 1
      WHERE "id" = 'attempt_drift';
    `);
    const repairedAttemptState = psqlScalar(driftDatabase, `
      SELECT "outcome" || '/' || "cost_exposure" || '/' || "final_usage_evidence" || '/' || "usage_settled"::text
      FROM "request_provider_attempts"
      WHERE "id" = 'attempt_drift'
    `);
    if (repairedAttemptState !== "succeeded/stopped/final/1") {
      throw new Error(`prisma_takeover_provider_attempt_transition_invalid:${repairedAttemptState}`);
    }
    expectPsqlFailure(
      driftDatabase,
      `UPDATE "request_provider_attempts" SET "provider_id" = 'provider_changed' WHERE "id" = 'attempt_drift';`,
      "Provider Attempt identity cannot be updated",
    );
    psql(driftDatabase, `
      SET session_replication_role = replica;
      INSERT INTO "request_provider_attempts"
      SELECT (jsonb_populate_record(
        NULL::request_provider_attempts,
        to_jsonb(attempt) || jsonb_build_object(
          'id', 'attempt_cpa_basic',
          'request_id', 'request_cpa_basic',
          'candidate_id', 'candidate_cpa_basic',
          'outcome', 'pending',
          'failure_class', NULL,
          'trusted_usage_source', NULL,
          'ended_at', NULL,
          'cost_exposure', 'not_started',
          'final_usage_evidence', 'pending',
          'usage_settled', 0,
          'invocation_contract', 'cpa-basic@1',
          'plan_subscription_id', 'subscription_cpa_basic',
          'api_key_id', 'key_cpa_basic',
          'user_id', 'user_cpa_basic',
          'usage_charge_account_id', NULL,
          'require_service_tier', 0,
          'billable_price_profile_json', '{"schemaVersion":1,"currency":"USD","precision":6,"base":{"inputPriceUnitsPer1M":"0","cachedInputPriceUnitsPer1M":"0","cacheWritePriceUnitsPer1M":null,"outputPriceUnitsPer1M":"0"},"tiers":[]}',
          'provider_cost_profile_json', '{"schemaVersion":1,"currency":"USD","precision":6,"base":{"inputPriceUnitsPer1M":"0","cachedInputPriceUnitsPer1M":"0","cacheWritePriceUnitsPer1M":null,"outputPriceUnitsPer1M":"0"},"tiers":[]}',
          'access_point_price_profiles_json', '[{"accessPointId":"ap_cpa_basic","targetAccessPointId":null,"buyerScopeRef":"global:","sellerScopeRef":"global:","priceId":"price_cpa_basic","profileJson":"{}"}]',
          'billable_price_tier_key', NULL,
          'billable_price_snapshot_json', NULL,
          'input_tokens', NULL,
          'max_output_tokens', NULL,
          'tokenizer_id', NULL,
          'tokenizer_version', NULL,
          'provider_cost_tier_key', NULL,
          'provider_cost_snapshot_json', NULL,
          'access_point_price_snapshots_json', NULL
        )
      )).* FROM "request_provider_attempts" AS attempt WHERE "id" = 'attempt_historical';
      SET session_replication_role = origin;
      UPDATE "request_provider_attempts" SET "cost_exposure" = 'accruing' WHERE "id" = 'attempt_cpa_basic';
      UPDATE "request_provider_attempts"
      SET "outcome" = 'succeeded', "trusted_usage_source" = 'provider',
          "ended_at" = '2026-08-24T00:00:02.000Z', "cost_exposure" = 'stopped',
          "final_usage_evidence" = 'final', "usage_settled" = 1
      WHERE "id" = 'attempt_cpa_basic';
    `);
    const cpaBasicShape = psqlScalar(driftDatabase, `
      SELECT "invocation_contract" || '/' || COALESCE("tokenizer_id", 'null') || '/' ||
             CASE WHEN "billable_price_profile_json" IS NOT NULL THEN 'profile' ELSE 'missing' END || '/' ||
             "outcome" || '/' || "usage_settled"::text
      FROM "request_provider_attempts" WHERE "id" = 'attempt_cpa_basic'
    `);
    if (cpaBasicShape !== "cpa-basic@1/null/profile/succeeded/1") {
      throw new Error(`prisma_takeover_cpa_basic_provider_attempt_invalid:${cpaBasicShape}`);
    }
    if (psqlScalar(driftDatabase, `SELECT count(*)::text FROM "budget_claims" WHERE "provider_attempt_id" = 'attempt_cpa_basic'`) !== "0"
      || psqlScalar(driftDatabase, `SELECT count(*)::text FROM "usage_reservations" WHERE "provider_attempt_id" = 'attempt_cpa_basic'`) !== "0") {
      throw new Error("prisma_takeover_cpa_basic_provider_attempt_not_claimless");
    }

    const intermediateMigrations = migrations.slice(0, transitionFunctionReassertIndex);
    for (const migration of intermediateMigrations) psql(intermediateDriftDatabase, migration.sql);
    psql(intermediateDriftDatabase, prismaHistoryTableSql());
    for (const [index, migration] of intermediateMigrations.entries()) {
      psql(intermediateDriftDatabase, successfulHistorySql(migration, index));
    }
    psql(intermediateDriftDatabase, staleProviderAttemptTransitionFunctionSql());
    psql(intermediateDriftDatabase, providerAttemptFixtureSql());

    const intermediateTriggerDefinition = psqlScalar(intermediateDriftDatabase, `
      SELECT pg_get_triggerdef(oid)
      FROM pg_trigger
      WHERE tgrelid = 'request_provider_attempts'::regclass
        AND tgname = 'request_provider_attempts_immutable_update'
        AND NOT tgisinternal
    `);
    const intermediateFunctionDefinition = psqlScalar(intermediateDriftDatabase, `
      SELECT pg_get_functiondef('friday_relay_validate_provider_attempt_terminal()'::regprocedure)
    `);
    if (!intermediateTriggerDefinition.includes("cost_exposure")) {
      throw new Error("prisma_takeover_provider_attempt_intermediate_trigger_not_repaired");
    }
    if (intermediateFunctionDefinition.includes("Provider Attempt dispatch transition is invalid")) {
      throw new Error("prisma_takeover_provider_attempt_intermediate_function_not_stale");
    }
    expectPsqlFailure(
      intermediateDriftDatabase,
      `UPDATE "request_provider_attempts" SET "cost_exposure" = 'accruing' WHERE "id" = 'attempt_drift';`,
      "Provider Attempt terminal transition is invalid",
    );

    const intermediateDriftUrl = connectionString(intermediateDriftDatabase);
    prisma("status", intermediateDriftUrl, false);
    prisma("deploy", intermediateDriftUrl, true);
    prisma("status", intermediateDriftUrl, true);
    assertProviderAttemptRepairHistory(intermediateDriftDatabase);
    expectPsqlFailure(
      intermediateDriftDatabase,
      `UPDATE "request_provider_attempts" SET "cost_exposure" = 'stopped' WHERE "id" = 'attempt_drift';`,
      "Provider Attempt dispatch transition is invalid",
    );
    psql(intermediateDriftDatabase, `
      UPDATE "request_provider_attempts"
      SET "cost_exposure" = 'accruing'
      WHERE "id" = 'attempt_drift';
    `);
    expectPsqlFailure(
      intermediateDriftDatabase,
      `UPDATE "request_provider_attempts"
       SET "outcome" = 'succeeded',
           "ended_at" = '2026-08-24T00:00:01.000Z',
           "cost_exposure" = 'stopped',
           "final_usage_evidence" = 'final',
           "usage_settled" = 1
       WHERE "id" = 'attempt_drift';`,
      "Provider Attempt terminal transition is invalid",
    );
    psql(intermediateDriftDatabase, `
      UPDATE "request_provider_attempts"
      SET "outcome" = 'succeeded',
          "trusted_usage_source" = 'provider',
          "ended_at" = '2026-08-24T00:00:01.000Z',
          "cost_exposure" = 'stopped',
          "final_usage_evidence" = 'final',
          "usage_settled" = 1
      WHERE "id" = 'attempt_drift';
    `);
    const intermediateAttemptState = psqlScalar(intermediateDriftDatabase, `
      SELECT "outcome" || '/' || "cost_exposure" || '/' || "final_usage_evidence" || '/' || "usage_settled"::text
      FROM "request_provider_attempts"
      WHERE "id" = 'attempt_drift'
    `);
    if (intermediateAttemptState !== "succeeded/stopped/final/1") {
      throw new Error(`prisma_takeover_provider_attempt_intermediate_transition_invalid:${intermediateAttemptState}`);
    }

    const accessPointScopeIdempotencyPrefix = migrations.slice(0, accessPointScopeIdempotencyIndex);
    for (const migration of accessPointScopeIdempotencyPrefix) {
      psql(failedAccessPointScopeIdempotencyDatabase, migration.sql);
    }
    psql(failedAccessPointScopeIdempotencyDatabase, prismaHistoryTableSql());
    for (const [index, migration] of accessPointScopeIdempotencyPrefix.entries()) {
      psql(failedAccessPointScopeIdempotencyDatabase, successfulHistorySql(migration, index));
    }
    psql(
      failedAccessPointScopeIdempotencyDatabase,
      rolledBackHistorySql(migrations[requestExecutionStableReferencesIndex]!, requestExecutionStableReferencesIndex),
    );
    psql(
      failedAccessPointScopeIdempotencyDatabase,
      failedHistorySql(migrations[accessPointScopeIdempotencyIndex]!, accessPointScopeIdempotencyIndex),
    );
    const failedAccessPointScopeIdempotencyUrl = connectionString(failedAccessPointScopeIdempotencyDatabase);
    prisma("status", failedAccessPointScopeIdempotencyUrl, false);
    const unrelatedRollbackBefore = rolledBackHistoryDigest(
      failedAccessPointScopeIdempotencyDatabase,
      requestExecutionStableReferences,
    );
    const accessPointInspection = await inspectAccessPointScopeIdempotencyMigrationRecovery(
      failedAccessPointScopeIdempotencyUrl,
    );
    if (accessPointInspection.status !== "ready_failed_zero_step" || accessPointInspection.resolveRequired !== true) {
      throw new Error("prisma_takeover_access_point_scope_idempotency_inspection_invalid");
    }
    const accessPointRecovery = await recoverAccessPointScopeIdempotencyMigrationForUrl(
      failedAccessPointScopeIdempotencyUrl,
    );
    if (accessPointRecovery.status !== "resolved_failed_zero_step" || !accessPointRecovery.resolveOutputDigest) {
      throw new Error("prisma_takeover_access_point_scope_idempotency_recovery_invalid");
    }
    if (rolledBackHistoryDigest(
      failedAccessPointScopeIdempotencyDatabase,
      requestExecutionStableReferences,
    ) !== unrelatedRollbackBefore) {
      throw new Error("prisma_takeover_access_point_scope_idempotency_unrelated_rollback_rewritten");
    }
    prisma("deploy", failedAccessPointScopeIdempotencyUrl, true);
    prisma("status", failedAccessPointScopeIdempotencyUrl, true);
    assertExactMigrationHistory(
      failedAccessPointScopeIdempotencyDatabase,
      migrations.map((migration) => migration.name),
    );

    for (const migration of deployedStableRoutingPrefix) psql(failedDatabase, migration.sql);
    psql(failedDatabase, prismaHistoryTableSql());
    for (const [index, migration] of deployedStableRoutingPrefix.entries()) {
      psql(failedDatabase, successfulHistorySql(migration, index));
    }
    psql(failedDatabase, failedHistorySql({
      ...migrations[requestExecutionStableReferencesIndex]!,
      checksum: "0".repeat(64),
    }, requestExecutionStableReferencesIndex));
    const failedUrl = connectionString(failedDatabase);
    prisma("status", failedUrl, false);
    prisma("deploy", failedUrl, false);
    await expectRecoveryFailure(failedUrl, "provider_attempt_reference_recovery_failed_history_invalid");
    psql(failedDatabase, `
      UPDATE "_prisma_migrations"
      SET "checksum" = '${requestExecutionStableReferencesChecksum}'
      WHERE "migration_name" = '${requestExecutionStableReferences}'
        AND "finished_at" IS NULL AND "rolled_back_at" IS NULL;
      ALTER TABLE "request_provider_attempts" ADD COLUMN "provider_model_id" text COLLATE "C";
    `);
    await expectRecoveryFailure(failedUrl, "provider_attempt_reference_recovery_physical_state_invalid");

    process.stdout.write(`${JSON.stringify({
      migrationHead: names.at(-1),
      migrationCount: names.length,
      existingHistoryAdopted: true,
      deployNoopVerified: true,
      freshRecoveryNoopVerified: true,
      deployedRepairPrefixCompletedWithForwardMigrations: true,
      providerAttemptStableReferencePendingRecoveryVerified: true,
      providerAttemptStableReferenceFailedRecoveryVerified: true,
      providerAttemptStableReferenceReadOnlyInspectionVerified: true,
      providerAttemptRecoveryInspectionDatabaseReadOnly: true,
      providerAttemptHistoricalStatesBackfilled: true,
      providerAttemptTransitionTriggerScoped: true,
      providerAttemptRecoveryRejectsWrongChecksum: true,
      providerAttemptRecoveryRejectsSuccessfulChecksumDrift: true,
      providerAttemptRecoveryRejectsAmbiguousProviderModel: true,
      providerAttemptRecoveryRejectsMissingStableRoutingIndex: true,
      providerAttemptRecoveryRejectsInvalidStableRoutingIndex: true,
      providerAttemptRecoveryRejectsFunctionDrift: true,
      providerAttemptRecoveryRejectsPartialPhysicalState: true,
      providerAttemptRecoveryIdempotent: true,
      providerAttemptRecoveryLockContentionRejected: true,
      providerAttemptRecoveryResolveInterruptionSafe: true,
      providerAttemptStageOneAppliedWithPhysicalDrift: true,
      providerAttemptIntermediateRepairHistoryRejected: true,
      providerAttemptRepairsApplied: true,
      providerAttemptRepairChecksumsPinned: true,
      cpaBasicProviderAttemptContractVerified: true,
      cpaBasicProviderAttemptClaimless: true,
      providerAttemptValidAndInvalidTransitionsVerified: true,
      providerAttemptIdentityRemainsImmutable: true,
      providerAttemptHistoricalRowPreserved: true,
      accessPointScopeIdempotencyUnrelatedRollbackPreserved: true,
      accessPointScopeIdempotencyFailedRecoveryVerified: true,
      failedMigrationBlocked: true,
    })}\n`);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await verificationRuntime.cleanup();
    } catch (cleanupError) {
      if (primaryFailure) process.stderr.write("prisma_takeover_database_cleanup_failed\n");
      else throw cleanupError;
    }
  }
}

async function assertRecoveryLockContention(url: string): Promise<void> {
  const owner = createPostgresClient({ connectionString: url, max: 1 });
  try {
    await owner.withTransaction(async (context) => {
      const lock = await context.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('friday-relay:prisma-migrate-deploy', 0)) AS acquired",
      );
      if (lock.rows[0]?.acquired !== true) throw new Error("prisma_takeover_recovery_contention_lock_missing");
      await expectRecoveryFailure(url, "postgres_migration_lock_busy");
    });
  } finally {
    await owner.close();
  }
}

async function interruptStableReferenceRecoveryBeforeResolve(url: string): Promise<void> {
  const owner = createPostgresClient({ connectionString: url, max: 1 });
  try {
    await recoverProviderAttemptReferenceMigration(
      owner,
      () => { throw Object.assign(new Error("verification resolve interruption"), { code: "verification_resolve_interrupted" }); },
      { migrationsRoot },
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "verification_resolve_interrupted") return;
    throw error;
  } finally {
    await owner.close();
  }
  throw new Error("prisma_takeover_recovery_resolve_interruption_missing");
}

async function assertReadOnlyRecoveryInspectionTransaction(url: string): Promise<void> {
  const owner = createPostgresClient({ connectionString: url, max: 1 });
  try {
    await owner.withReadOnlyTransaction(async (context) => {
      await context.query(`UPDATE "provider_models" SET "display_name" = "display_name" WHERE false`);
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "25006") return;
    throw error;
  } finally {
    await owner.close();
  }
  throw new Error("prisma_takeover_recovery_inspection_transaction_not_read_only");
}

async function expectInspectionFailure(url: string, expectedCode: string): Promise<void> {
  try {
    await inspectStableReferenceMigration(url);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === expectedCode) return;
    throw error;
  }
  throw new Error(`prisma_takeover_recovery_inspection_unexpected_success:${expectedCode}`);
}

async function inspectStableReferenceMigration(url: string) {
  const owner = createPostgresClient({
    connectionString: url,
    max: 2,
    statementTimeoutMillis: 30_000,
    lockTimeoutMillis: 5_000,
    transactionTimeoutMillis: 60_000,
  });
  try {
    return await inspectProviderAttemptReferenceRecovery(owner, { migrationsRoot });
  } finally {
    await owner.close();
  }
}

async function expectRecoveryFailure(url: string, expectedCode: string): Promise<void> {
  try {
    await recoverStableReferenceMigration(url);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === expectedCode) return;
    throw error;
  }
  throw new Error(`prisma_takeover_recovery_unexpected_success:${expectedCode}`);
}

async function recoverStableReferenceMigration(url: string) {
  const owner = createPostgresClient({
    connectionString: url,
    max: 2,
    statementTimeoutMillis: 30_000,
    lockTimeoutMillis: 5_000,
    transactionTimeoutMillis: 60_000,
  });
  try {
    return await recoverProviderAttemptReferenceMigration(
      owner,
      () => runPrismaMigrateResolveRolledBack(REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION, {
        ...process.env,
        FRIDAY_RELAY_PG_CONNECTION_STRING: url,
      }),
      { migrationsRoot },
    );
  } finally {
    await owner.close();
  }
}

async function inspectAccessPointScopeIdempotencyMigrationRecovery(url: string) {
  const owner = createPostgresClient({
    connectionString: url,
    max: 2,
    statementTimeoutMillis: 30_000,
    lockTimeoutMillis: 5_000,
    transactionTimeoutMillis: 60_000,
  });
  try {
    return await inspectAccessPointScopeIdempotencyRecovery(owner, { migrationsRoot });
  } finally {
    await owner.close();
  }
}

async function recoverAccessPointScopeIdempotencyMigrationForUrl(url: string) {
  const owner = createPostgresClient({
    connectionString: url,
    max: 2,
    statementTimeoutMillis: 30_000,
    lockTimeoutMillis: 5_000,
    transactionTimeoutMillis: 60_000,
  });
  try {
    return await recoverAccessPointScopeIdempotencyMigration(
      owner,
      () => runPrismaMigrateResolveRolledBack(ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION, {
        ...process.env,
        FRIDAY_RELAY_PG_CONNECTION_STRING: url,
      }),
      { migrationsRoot },
    );
  } finally {
    await owner.close();
  }
}

function functionDefinitionSql(sql: string, functionName: string): string {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `CREATE OR REPLACE FUNCTION "${escapedName}"\\(\\) RETURNS trigger LANGUAGE plpgsql AS \\$\\$.*?\\$\\$;`,
    "su",
  ).exec(sql);
  if (!match) throw new Error(`prisma_takeover_function_definition_missing:${functionName}`);
  return match[0];
}

function preStableReferenceProviderAttemptFixtureSql(): string {
  return `
    SET session_replication_role = replica;
    INSERT INTO "provider_models" (
      "id", "provider_id", "provider_model_name", "display_name", "status", "created_at", "updated_at"
    ) VALUES (
      'provider_model_reference_recovery', 'provider_reference_recovery', 'model-reference-recovery',
      'Reference recovery model', 'enabled', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z'
    );
    INSERT INTO "request_provider_attempts" (
      "id", "request_id", "attempt_index", "selector_access_point_id", "selector_id",
      "selector_behavior_version", "routing_revision", "candidate_id", "selector_target_edge_id",
      "path_target_edge_ids_json", "access_point_chain_ids_json", "provider_id",
      "provider_model_name", "outcome", "failure_class", "output_committed", "trusted_usage_source",
      "started_at", "ended_at", "execution_owner_id", "admission_lease_until", "cost_exposure",
      "final_usage_evidence", "usage_settled", "reconciliation_reason", "billable_price_source",
      "billable_price_id", "billable_price_tier_key", "billable_price_snapshot_json",
      "routing_revisions_json", "input_tokens", "max_output_tokens", "tokenizer_id",
      "tokenizer_version", "requested_service_tier", "billing_scope_ref", "plan_seller_scope_ref",
      "plan_billing_mode", "subscription_effective_start", "provider_owner_scope_ref",
      "provider_model_cost_id", "provider_cost_tier_key", "provider_cost_snapshot_json",
      "access_point_price_snapshots_json"
    ) VALUES (
      'attempt_reference_pending_not_started', 'request_reference_pending_not_started', 0,
      'access_point_reference_recovery', 'direct', 1, 1, 'candidate_reference_pending_not_started',
      'edge_reference_recovery', '[]', '[]', 'provider_reference_recovery', 'model-reference-recovery',
      'pending', NULL, 0, NULL, '2026-08-25T00:00:00.000Z', NULL,
      'owner_reference_recovery', '2026-08-25T01:00:00.000Z', 'not_started', 'pending', 0, NULL,
      'access_point', 'price_reference_recovery', 'standard', '{}', '[]', 0, 0, 'verification', 1,
      'standard', 'global:', 'global:', 'prepaid', '2026-08-25T00:00:00.000Z',
      'global:', 'cost_reference_recovery', 'standard', '{}', '[]'
    );
    INSERT INTO "request_provider_attempts"
    SELECT (jsonb_populate_record(
      NULL::request_provider_attempts,
      to_jsonb(attempt) || jsonb_build_object(
        'id', variant.id,
        'request_id', variant.request_id,
        'candidate_id', variant.candidate_id,
        'outcome', variant.outcome,
        'trusted_usage_source', variant.trusted_usage_source,
        'ended_at', variant.ended_at,
        'cost_exposure', variant.cost_exposure,
        'final_usage_evidence', variant.final_usage_evidence,
        'usage_settled', variant.usage_settled
      )
    )).*
    FROM "request_provider_attempts" attempt
    CROSS JOIN (VALUES
      ('attempt_reference_pending_accruing', 'request_reference_pending_accruing', 'candidate_reference_pending_accruing', 'pending', NULL, NULL, 'accruing', 'pending', 0),
      ('attempt_reference_terminal_unsettled', 'request_reference_terminal_unsettled', 'candidate_reference_terminal_unsettled', 'succeeded', NULL, '2026-08-25T00:00:01.000Z', 'not_started', 'pending', 0),
      ('attempt_reference_terminal_settled', 'request_reference_terminal_settled', 'candidate_reference_terminal_settled', 'succeeded', 'provider', '2026-08-25T00:00:02.000Z', 'stopped', 'final', 1)
    ) AS variant(id, request_id, candidate_id, outcome, trusted_usage_source, ended_at, cost_exposure, final_usage_evidence, usage_settled)
    WHERE attempt."id" = 'attempt_reference_pending_not_started';
    SET session_replication_role = origin;
  `;
}

function scalePreStableReferenceProviderAttemptsSql(): string {
  return `
    SET session_replication_role = replica;
    INSERT INTO "request_provider_attempts"
    SELECT (jsonb_populate_record(
      NULL::request_provider_attempts,
      to_jsonb(attempt) || jsonb_build_object(
        'id', 'attempt_reference_scale_' || series.value::text,
        'request_id', 'request_reference_scale_' || series.value::text,
        'candidate_id', 'candidate_reference_scale_' || series.value::text,
        'outcome', CASE WHEN series.value <= 15 THEN 'pending' ELSE 'succeeded' END,
        'trusted_usage_source', CASE WHEN series.value BETWEEN 16 AND 606 THEN 'provider' ELSE NULL END,
        'ended_at', CASE WHEN series.value <= 15 THEN NULL ELSE '2026-08-25T00:00:03.000Z' END,
        'cost_exposure', CASE WHEN series.value <= 15 THEN 'not_started' WHEN series.value BETWEEN 16 AND 606 THEN 'stopped' ELSE 'not_started' END,
        'final_usage_evidence', CASE WHEN series.value BETWEEN 16 AND 606 THEN 'final' ELSE 'pending' END,
        'usage_settled', CASE WHEN series.value BETWEEN 16 AND 606 THEN 1 ELSE 0 END
      )
    )).*
    FROM "request_provider_attempts" attempt
    CROSS JOIN generate_series(1, 90114) AS series(value)
    WHERE attempt."id" = 'attempt_reference_pending_not_started';
    SET session_replication_role = origin;
  `;
}

function assertScaledStableReferenceFixture(database: string): void {
  const shape = psqlScalar(database, `
    SELECT count(*)::text || '/' ||
           count(*) FILTER (WHERE "outcome" = 'pending')::text || '/' ||
           count(*) FILTER (WHERE "outcome" <> 'pending' AND "usage_settled" = 1)::text || '/' ||
           count(*) FILTER (WHERE "outcome" <> 'pending' AND "usage_settled" = 0)::text
    FROM "request_provider_attempts"
    WHERE "id" LIKE 'attempt_reference_%'
  `);
  if (shape !== "90118/17/592/89509") {
    throw new Error(`prisma_takeover_scaled_stable_reference_fixture_invalid:${shape}`);
  }
}

type StableReferenceProviderAttemptSnapshot = Readonly<{
  columns: readonly string[];
  value: string;
}>;

function stableReferenceProviderAttemptColumns(database: string): readonly string[] {
  const parsed: unknown = JSON.parse(psqlScalar(database, `
    SELECT jsonb_agg(column_name ORDER BY ordinal_position)::text
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'request_provider_attempts'
  `));
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((column: unknown) => typeof column !== "string" || !/^[a-z][a-z0-9_]*$/u.test(column))) {
    throw new Error("prisma_takeover_stable_reference_historical_columns_invalid");
  }
  return Object.freeze(parsed as string[]);
}

function stableReferenceProviderAttemptProjection(columns: readonly string[]): string {
  const literals = columns.map((column) => `'${column}'`).join(", ");
  return `(SELECT jsonb_object_agg(entry.key, entry.value ORDER BY entry.key)
    FROM jsonb_each(to_jsonb(attempt)) entry
    WHERE entry.key = ANY (ARRAY[${literals}]::text[]))`;
}

function preStableReferenceProviderAttemptDigest(database: string, columns: readonly string[]): string {
  const projection = stableReferenceProviderAttemptProjection(columns);
  return psqlScalar(database, `
    SELECT md5(string_agg(md5((${projection})::text), '' ORDER BY attempt."id"))
    FROM "request_provider_attempts" attempt
    WHERE attempt."id" LIKE 'attempt_reference_%'
  `);
}

function capturePreStableReferenceProviderAttemptSnapshot(database: string): StableReferenceProviderAttemptSnapshot {
  const columns = stableReferenceProviderAttemptColumns(database);
  const projection = stableReferenceProviderAttemptProjection(columns);
  const value = psqlScalar(database, `
    SELECT jsonb_agg(${projection} ORDER BY attempt."id")::text
    FROM "request_provider_attempts" attempt
    WHERE attempt."id" LIKE 'attempt_reference_%'
  `);
  return Object.freeze({ columns, value });
}

function postStableReferenceProviderAttemptSnapshot(database: string, columns: readonly string[]): string {
  const projection = stableReferenceProviderAttemptProjection(columns);
  return psqlScalar(database, `
    SELECT jsonb_agg(${projection} ORDER BY attempt."id")::text
    FROM "request_provider_attempts" attempt
    WHERE attempt."id" LIKE 'attempt_reference_%'
  `);
}

function assertFailedStableReferenceRollback(database: string): void {
  const failed = psqlScalar(database, `
    SELECT "migration_name" || ':' || "checksum" || ':' || "applied_steps_count"::text
    FROM "_prisma_migrations"
    WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL
  `);
  if (failed !== `${requestExecutionStableReferences}:${requestExecutionStableReferencesChecksum}:0`) {
    throw new Error("prisma_takeover_stable_reference_failed_row_invalid");
  }
  const artifactCount = psqlScalar(database, `
    SELECT (
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'request_provider_attempts' AND column_name = 'provider_model_id')
           OR (table_name = 'request_executions' AND column_name = 'selected_plan_subscription_id')))
      + (SELECT count(*) FROM pg_constraint
         WHERE conname IN ('request_provider_attempts_provider_model_fk', 'request_executions_selected_plan_subscription_fk'))
      + (SELECT count(*) FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname IN ('request_provider_attempts_provider_model_started_idx', 'request_executions_selected_plan_subscription_idx'))
    )::text
  `);
  if (artifactCount !== "0") throw new Error("prisma_takeover_stable_reference_physical_rollback_invalid");
  const triggerDefinition = psqlScalar(database, `
    SELECT pg_get_triggerdef(oid) FROM pg_trigger
    WHERE tgrelid = 'request_provider_attempts'::regclass
      AND tgname = 'request_provider_attempts_terminal_update' AND NOT tgisinternal
  `);
  if (!triggerDefinition.includes("BEFORE UPDATE ON public.request_provider_attempts")) {
    throw new Error("prisma_takeover_stable_reference_failed_trigger_unexpected");
  }
}

function assertStableReferenceRecoveryResult(database: string, beforeSnapshot?: StableReferenceProviderAttemptSnapshot, expectedCount = 4): void {
  if (beforeSnapshot !== undefined) {
    const afterSnapshot = postStableReferenceProviderAttemptSnapshot(database, beforeSnapshot.columns);
    if (afterSnapshot !== beforeSnapshot.value) {
      throw new Error("prisma_takeover_stable_reference_historical_row_rewritten");
    }
  }
  if (psqlScalar(database, `
    SELECT count(*)::text FROM "request_provider_attempts"
    WHERE "id" LIKE 'attempt_reference_%'
      AND "provider_model_id" = 'provider_model_reference_recovery'
  `) !== String(expectedCount)) {
    throw new Error("prisma_takeover_stable_reference_backfill_invalid");
  }
  const triggerDefinition = psqlScalar(database, `
    SELECT pg_get_triggerdef(oid) FROM pg_trigger
    WHERE tgrelid = 'request_provider_attempts'::regclass
      AND tgname = 'request_provider_attempts_terminal_update' AND NOT tgisinternal
  `);
  const expectedColumns = "BEFORE UPDATE OF outcome, failure_class, failure_reason, output_committed, trusted_usage_source, ended_at, cost_exposure, final_usage_evidence, usage_settled, reconciliation_reason ON public.request_provider_attempts";
  if (!triggerDefinition.includes(expectedColumns)) {
    throw new Error("prisma_takeover_provider_attempt_transition_trigger_scope_invalid");
  }
  psql(database, `
    UPDATE "request_provider_attempts"
    SET "provider_model_id" = "provider_model_id"
    WHERE "id" = 'attempt_reference_terminal_settled';
  `);
  expectPsqlFailure(
    database,
    `UPDATE "request_provider_attempts" SET "provider_model_name" = 'changed' WHERE "id" = 'attempt_reference_terminal_settled';`,
    "Provider Attempt identity cannot be updated",
  );
  expectPsqlFailure(
    database,
    `UPDATE "request_provider_attempts" SET "cost_exposure" = 'stopped' WHERE "id" = 'attempt_reference_pending_not_started';`,
    "Provider Attempt dispatch transition is invalid",
  );
}

function prisma(operation: "status" | "deploy", url: string, expectSuccess: boolean): void {
  const result = spawnSync("bun", [prismaBinPath, "migrate", operation, "--config", prismaConfigPath], {
    cwd: packageRoot,
    env: { ...process.env, FRIDAY_RELAY_PG_CONNECTION_STRING: url },
    encoding: "utf8",
    maxBuffer,
  });
  if ((result.status === 0) !== expectSuccess) {
    throw new Error(`prisma_takeover_${operation}_${expectSuccess ? "unexpected_failure" : "unexpected_success"}`);
  }
}

function psql(database: string, sql: string): void {
  verificationRuntime.executeSql(database, sql);
}

function psqlScalar(database: string, sql: string): string {
  return verificationRuntime.queryScalar(database, sql);
}

function providerAttemptSnapshot(database: string, attemptId: string, columns: readonly string[]): string {
  const projection = stableReferenceProviderAttemptProjection(columns);
  return psqlScalar(database, `
    SELECT (${projection})::text
    FROM "request_provider_attempts" AS attempt
    WHERE "id" = '${attemptId}'
  `);
}

function rolledBackHistoryDigest(database: string, migrationName: string): string {
  return psqlScalar(database, `
    SELECT string_agg(
      "migration_name" || ':' || "checksum" || ':' || "applied_steps_count"::text,
      E'\\n' ORDER BY "started_at", "id"
    )
    FROM "_prisma_migrations"
    WHERE "migration_name" = '${migrationName}'
      AND "finished_at" IS NULL
      AND "rolled_back_at" IS NOT NULL
  `);
}

function assertExactMigrationHistory(database: string, expectedNames: string[]): void {
  const actual = psqlScalar(database, `
    SELECT string_agg("migration_name", E'\\n' ORDER BY "migration_name")
    FROM "_prisma_migrations"
    WHERE "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
  `);
  if (actual !== expectedNames.join("\n")) {
    throw new Error("prisma_takeover_exact_migration_history_invalid");
  }
}

function assertProviderAttemptRepairHistory(database: string): void {
  const repairHistory = psqlScalar(database, `
    SELECT string_agg("migration_name" || ':' || "checksum", E'\\n' ORDER BY "migration_name")
    FROM "_prisma_migrations"
    WHERE "migration_name" IN (
      '${providerAttemptMutableFieldsRepair}', '${providerAttemptTransitionFunctionRepair}',
      '${providerAttemptMutableFieldsReassert}', '${providerAttemptTransitionFunctionReassert}',
      '${cpaBasicProviderAttemptContract}', '${providerAttemptTransitionTriggerScope}'
    )
      AND "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
  `);
  const expectedRepairHistory = [
    `${providerAttemptMutableFieldsRepair}:${providerAttemptMutableFieldsRepairChecksum}`,
    `${providerAttemptTransitionFunctionRepair}:${providerAttemptTransitionFunctionRepairChecksum}`,
    `${providerAttemptMutableFieldsReassert}:${providerAttemptMutableFieldsRepairChecksum}`,
    `${providerAttemptTransitionFunctionReassert}:${providerAttemptTransitionFunctionRepairChecksum}`,
    `${cpaBasicProviderAttemptContract}:${cpaBasicProviderAttemptContractChecksum}`,
    `${providerAttemptTransitionTriggerScope}:${providerAttemptTransitionTriggerScopeChecksum}`,
  ].join("\n");
  if (repairHistory !== expectedRepairHistory) {
    throw new Error("prisma_takeover_provider_attempt_repair_history_invalid");
  }
}

function expectPsqlFailure(database: string, sql: string, expectedMessage: string): void {
  const result = verificationRuntime.psqlResult(database, ["-v", "ON_ERROR_STOP=1"], sql);
  const detail = verificationRuntime.redact([result.stdout, result.stderr].filter(Boolean).join("\n"));
  if (result.status === 0) throw new Error("prisma_takeover_expected_provider_attempt_rejection");
  if (!detail.includes(expectedMessage)) {
    throw new Error(`prisma_takeover_unexpected_provider_attempt_rejection:${result.status ?? "signal"}`);
  }
}

function staleProviderAttemptObjectsSql(): string {
  return `
    DROP TRIGGER IF EXISTS "request_provider_attempts_immutable_update" ON "request_provider_attempts";
    CREATE TRIGGER "request_provider_attempts_immutable_update"
      BEFORE UPDATE ON "request_provider_attempts"
      FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_immutable_update"(
        'Provider Attempt identity cannot be updated',
        'outcome', 'failure_class', 'output_committed', 'trusted_usage_source', 'ended_at'
      );
    ${staleProviderAttemptTransitionFunctionSql()}
  `;
}

function staleProviderAttemptTransitionFunctionSql(): string {
  return `
    CREATE OR REPLACE FUNCTION "friday_relay_validate_provider_attempt_terminal"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.outcome <> 'pending'
         OR NEW.outcome NOT IN ('succeeded','failed','aborted')
         OR NEW.ended_at IS NULL
         OR (NEW.outcome = 'succeeded' AND (NEW.failure_class IS NOT NULL OR NEW.trusted_usage_source IS NOT NULL))
         OR (NEW.outcome = 'aborted' AND NEW.failure_class IS NOT NULL)
         OR (NEW.outcome = 'failed' AND NEW.failure_class IS NULL)
      THEN
        RAISE EXCEPTION 'Provider Attempt terminal transition is invalid' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $$;
  `;
}

function providerAttemptFixtureSql(): string {
  return `
    SET session_replication_role = replica;
    INSERT INTO "request_provider_attempts" (
      "id", "request_id", "attempt_index", "selector_access_point_id", "selector_id",
      "selector_behavior_version", "routing_revision", "candidate_id", "selector_target_edge_id",
      "path_target_edge_ids_json", "access_point_chain_ids_json", "provider_id", "provider_model_id",
      "provider_model_name", "outcome", "failure_class", "output_committed", "trusted_usage_source",
      "started_at", "ended_at", "execution_owner_id", "admission_lease_until", "cost_exposure",
      "final_usage_evidence", "usage_settled", "reconciliation_reason", "billable_price_source",
      "billable_price_id", "billable_price_tier_key", "billable_price_snapshot_json",
      "routing_revisions_json", "input_tokens", "max_output_tokens", "tokenizer_id",
      "tokenizer_version", "requested_service_tier", "billing_scope_ref", "plan_seller_scope_ref",
      "plan_billing_mode", "subscription_effective_start", "provider_owner_scope_ref",
      "provider_model_cost_id", "provider_cost_tier_key", "provider_cost_snapshot_json",
      "access_point_price_snapshots_json"
    ) VALUES (
      'attempt_drift', 'request_drift', 0, 'access_point_drift', 'direct',
      1, 1, 'candidate_drift', 'edge_drift', '[]', '[]', 'provider_drift', 'provider_model_drift',
      'model-drift', 'pending', NULL, 0, NULL, '2026-08-24T00:00:00.000Z', NULL,
      'owner_drift', '2026-08-24T01:00:00.000Z', 'not_started', 'pending', 0, NULL,
      'access_point', 'price_drift', 'standard', '{}', '[]', 0, 0, 'verification', 1,
      'standard', 'global:', 'global:', 'prepaid', '2026-08-24T00:00:00.000Z',
      'global:', 'cost_drift', 'standard', '{}', '[]'
    );
    INSERT INTO "request_provider_attempts"
    SELECT (jsonb_populate_record(
      NULL::request_provider_attempts,
      to_jsonb(attempt) || jsonb_build_object(
        'id', 'attempt_historical',
        'request_id', 'request_historical',
        'outcome', 'succeeded',
        'trusted_usage_source', 'provider',
        'ended_at', '2026-08-24T00:00:01.000Z',
        'cost_exposure', 'stopped',
        'final_usage_evidence', 'final',
        'usage_settled', 1
      )
    )).* FROM "request_provider_attempts" AS attempt WHERE "id" = 'attempt_drift';
    SET session_replication_role = origin;
  `;
}

function prismaHistoryTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" varchar(36) PRIMARY KEY NOT NULL,
    "checksum" varchar(64) NOT NULL,
    "finished_at" timestamptz,
    "migration_name" varchar(255) NOT NULL,
    "logs" text,
    "rolled_back_at" timestamptz,
    "started_at" timestamptz NOT NULL DEFAULT now(),
    "applied_steps_count" integer NOT NULL DEFAULT 0
  );`;
}

function successfulHistorySql(migration: { name: string; checksum: string }, index: number): string {
  const timestamp = `2026-08-13T00:${String(index).padStart(2, "0")}:00.000Z`;
  const checksum = publishedRepairChecksum(migration.name) ?? migration.checksum;
  return `INSERT INTO "_prisma_migrations"
    ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
    VALUES ('${randomUUID()}', '${checksum}', '${timestamp}', '${migration.name}', NULL, NULL, '${timestamp}', 1);`;
}

function rolledBackHistorySql(migration: { name: string; checksum: string }, index: number): string {
  const startedAt = `2026-08-13T02:${String(index).padStart(2, "0")}:00.000Z`;
  const rolledBackAt = `2026-08-13T03:${String(index).padStart(2, "0")}:00.000Z`;
  const checksum = publishedRepairChecksum(migration.name) ?? migration.checksum;
  return `INSERT INTO "_prisma_migrations"
    ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
    VALUES ('${randomUUID()}', '${checksum}', NULL, '${migration.name}', 'verification historical rollback', '${rolledBackAt}', '${startedAt}', 0);`;
}

function publishedRepairChecksum(migrationName: string): string | undefined {
  if (migrationName === providerAttemptMutableFieldsRepair) return providerAttemptMutableFieldsRepairChecksum;
  if (migrationName === providerAttemptTransitionFunctionRepair) return providerAttemptTransitionFunctionRepairChecksum;
  if (migrationName === providerModelStableRoutingReference) return providerModelStableRoutingReferenceChecksum;
  if (migrationName === requestExecutionStableReferences) return requestExecutionStableReferencesChecksum;
  if (migrationName === providerAttemptMutableFieldsReassert) return providerAttemptMutableFieldsRepairChecksum;
  if (migrationName === providerAttemptTransitionFunctionReassert) return providerAttemptTransitionFunctionRepairChecksum;
  if (migrationName === cpaBasicProviderAttemptContract) return cpaBasicProviderAttemptContractChecksum;
  if (migrationName === providerAttemptTransitionTriggerScope) return providerAttemptTransitionTriggerScopeChecksum;
  return undefined;
}

function failedHistorySql(migration: { name: string; checksum: string }, index: number): string {
  const timestamp = `2026-08-13T01:${String(index).padStart(2, "0")}:00.000Z`;
  return `INSERT INTO "_prisma_migrations"
    ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
    VALUES ('${randomUUID()}', '${migration.checksum}', NULL, '${migration.name}', 'verification failure', NULL, '${timestamp}', 0);`;
}

function connectionString(database: string): string {
  return verificationRuntime.connectionString(database);
}

await main();
