import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePostgresPrismaRuntimeArtifacts } from "@frely/postgres/runtime-artifacts";
import type { PostgresTransactionContext } from "@frely/postgres/server";
import { committedPrismaMigrationNames } from "@frely/postgres/migration-state";

export const REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION = "20260824001200_request_execution_stable_references";
export const REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM = "f34f16d409d1ab3af9ed22d83b3f6a1d030df6b1d725b6fdc11aa8919006afa2";
export const PROVIDER_ATTEMPT_TRANSITION_TRIGGER_MIGRATION = "20260824002100_scope_provider_attempt_transition_trigger";

const POSTGRES_BASELINE_MIGRATION = "20260813000000_postgresql_baseline";
const PROVIDER_INVOCATION_STAGE_ONE_MIGRATION = "20260813003000_provider_invocation_stage_1";
const PROVIDER_ATTEMPT_TRANSITION_FUNCTION_REPAIR_MIGRATION = "20260824001000_repair_provider_attempt_transition_function";
const PROVIDER_MODEL_STABLE_ROUTING_REFERENCE_MIGRATION = "20260824001100_provider_model_stable_routing_reference";
const MIGRATION_LOCK_SQL = "SELECT pg_try_advisory_xact_lock(hashtextextended('friday-relay:prisma-migrate-deploy', 0)) AS acquired";
const LIFECYCLE_COLUMNS = Object.freeze([
  "outcome",
  "failure_class",
  "output_committed",
  "trusted_usage_source",
  "ended_at",
  "cost_exposure",
  "final_usage_evidence",
  "usage_settled",
  "reconciliation_reason",
]);
const IMMUTABLE_TRIGGER_ARGUMENTS = [
  "Provider Attempt identity cannot be updated",
  ...LIFECYCLE_COLUMNS,
];
const POST_012_FUNCTIONS = Object.freeze([
  "friday_relay_resolve_provider_attempt_provider_model",
  "friday_relay_guard_request_execution_plan_source",
  "friday_relay_guard_request_log_plan_source",
  "friday_relay_sync_request_execution_plan_source",
  "friday_relay_require_request_execution_plan_source",
]);
const POST_012_TRIGGERS = Object.freeze([
  "request_provider_attempts_provider_model_reference",
  "request_executions_plan_source_insert_guard",
  "request_executions_plan_source_update_guard",
  "request_logs_plan_source_projection_guard",
  "budget_claims_request_execution_plan_source",
  "provider_usage_request_execution_plan_source",
  "request_executions_selected_plan_source_required",
]);
const POST_012_CONSTRAINTS = Object.freeze([
  "request_provider_attempts_provider_model_fk",
  "request_executions_selected_plan_subscription_fk",
]);
const POST_012_INDEXES = Object.freeze([
  "request_provider_attempts_provider_model_started_idx",
  "request_executions_selected_plan_subscription_idx",
]);

interface RecoveryOwner {
  withTransaction<T>(callback: (context: PostgresTransactionContext) => Promise<T>): Promise<T>;
  withReadOnlyTransaction<T>(callback: (context: PostgresTransactionContext) => Promise<T>): Promise<T>;
}

interface ResolveResult {
  outputDigest: string;
}

interface MigrationRow extends Record<string, unknown> {
  migrationName: string;
  checksum: string;
  finishedAt: Date | string | null;
  rolledBackAt: Date | string | null;
  appliedStepsCount: number;
}

interface TriggerRow extends Record<string, unknown> {
  name: string;
  enabled: string;
  functionName: string;
  definition: string;
  triggerColumns: string[];
  arguments: string;
}

interface RecoveryPreparation {
  state: "not_applicable" | "prepared_pending" | "prepared_failed";
  triggerChanged: boolean;
  resolveRequired: boolean;
  appliedHead: string | null;
}

export interface ProviderAttemptReferenceRecoveryInspection {
  schema: "friday-relay.provider-attempt-reference-migration-recovery-inspection.v1";
  status: "not_applicable" | "ready_pending" | "ready_failed_zero_step";
  migrationName: typeof REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION;
  migrationChecksum: typeof REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM;
  appliedHead: string | null;
  triggerState: "not_inspected" | "unscoped" | "scoped";
  resolveRequired: boolean;
}

export interface ProviderAttemptReferenceRecoveryResult {
  schema: "friday-relay.provider-attempt-reference-migration-recovery.v1";
  status: "not_applicable" | "prepared_pending" | "resolved_failed_zero_step";
  migrationName: typeof REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION;
  migrationChecksum: typeof REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM;
  triggerChanged: boolean;
  resolveOutputDigest?: string;
}

export async function inspectProviderAttemptReferenceRecovery(
  owner: RecoveryOwner,
  options: { migrationsRoot?: string } = {},
): Promise<ProviderAttemptReferenceRecoveryInspection> {
  const migrationsRoot = options.migrationsRoot ?? resolvePostgresPrismaRuntimeArtifacts().migrationsRoot;
  const lineage = validateCommittedLineage(migrationsRoot);
  return owner.withReadOnlyTransaction(async (context) => {
    const ledger = await inspectLedger(context, lineage);
    if (ledger.kind === "already_applied" || ledger.kind === "before_supported_boundary") {
      return {
        schema: "friday-relay.provider-attempt-reference-migration-recovery-inspection.v1",
        status: "not_applicable",
        migrationName: REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION,
        migrationChecksum: REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM,
        appliedHead: ledger.appliedHead,
        triggerState: "not_inspected",
        resolveRequired: false,
      };
    }
    await assertPhysicalPre012State(context, lineage, ledger.appliedHead === PROVIDER_MODEL_STABLE_ROUTING_REFERENCE_MIGRATION);
    const triggerState = await assertTransitionTrigger(context, "unscoped_or_scoped");
    return {
      schema: "friday-relay.provider-attempt-reference-migration-recovery-inspection.v1",
      status: ledger.kind === "failed_zero_step" ? "ready_failed_zero_step" : "ready_pending",
      migrationName: REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION,
      migrationChecksum: REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM,
      appliedHead: ledger.appliedHead,
      triggerState,
      resolveRequired: ledger.kind === "failed_zero_step",
    };
  });
}

export async function recoverProviderAttemptReferenceMigration(
  owner: RecoveryOwner,
  resolveRolledBack: () => ResolveResult,
  options: { migrationsRoot?: string } = {},
): Promise<ProviderAttemptReferenceRecoveryResult> {
  const migrationsRoot = options.migrationsRoot ?? resolvePostgresPrismaRuntimeArtifacts().migrationsRoot;
  const lineage = validateCommittedLineage(migrationsRoot);
  const preparation = await owner.withTransaction(async (context) => {
    await acquireMigrationLock(context);
    return prepareLocked(context, lineage);
  });

  if (!preparation.resolveRequired) {
    return {
      schema: "friday-relay.provider-attempt-reference-migration-recovery.v1",
      status: preparation.state === "prepared_pending" ? "prepared_pending" : "not_applicable",
      migrationName: REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION,
      migrationChecksum: REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM,
      triggerChanged: preparation.triggerChanged,
    };
  }

  return owner.withTransaction(async (context) => {
    await acquireMigrationLock(context);
    const before = await inspectLedger(context, lineage);
    if (before.kind === "rolled_back_pending") {
      return {
        schema: "friday-relay.provider-attempt-reference-migration-recovery.v1",
        status: "resolved_failed_zero_step",
        migrationName: REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION,
        migrationChecksum: REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM,
        triggerChanged: preparation.triggerChanged,
      };
    }
    if (before.kind !== "failed_zero_step") {
      throw recoveryError("provider_attempt_reference_recovery_state_changed", "Failed migration state changed before Prisma resolve");
    }
    await assertPhysicalPre012State(context, lineage, true);
    await assertTransitionTrigger(context, "scoped");
    const resolved = resolveRolledBack();
    const after = await inspectLedger(context, lineage);
    if (after.kind !== "rolled_back_pending") {
      throw recoveryError("provider_attempt_reference_recovery_resolve_incomplete", "Prisma did not mark the exact failed migration as rolled back");
    }
    return {
      schema: "friday-relay.provider-attempt-reference-migration-recovery.v1",
      status: "resolved_failed_zero_step",
      migrationName: REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION,
      migrationChecksum: REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM,
      triggerChanged: preparation.triggerChanged,
      resolveOutputDigest: resolved.outputDigest,
    };
  });
}

async function prepareLocked(context: PostgresTransactionContext, lineage: Lineage): Promise<RecoveryPreparation> {
  const ledger = await inspectLedger(context, lineage);
  if (ledger.kind === "already_applied" || ledger.kind === "before_supported_boundary") {
    return { state: "not_applicable", triggerChanged: false, resolveRequired: false, appliedHead: ledger.appliedHead };
  }
  await assertPhysicalPre012State(context, lineage, ledger.appliedHead === PROVIDER_MODEL_STABLE_ROUTING_REFERENCE_MIGRATION);
  const triggerState = await assertTransitionTrigger(context, "unscoped_or_scoped");
  if (triggerState === "unscoped") {
    await scopeTransitionTrigger(context);
    await assertTransitionTrigger(context, "scoped");
  }
  return {
    state: ledger.kind === "failed_zero_step" ? "prepared_failed" : "prepared_pending",
    triggerChanged: triggerState === "unscoped",
    resolveRequired: ledger.kind === "failed_zero_step",
    appliedHead: ledger.appliedHead,
  };
}

interface Lineage {
  names: string[];
  checksums: ReadonlyMap<string, string>;
  immutableFunctionSource: string;
  transitionFunctionSource: string;
  stageOneIndex: number;
  stableRoutingIndex: number;
  stableReferencesIndex: number;
}

function validateCommittedLineage(migrationsRoot: string): Lineage {
  const names = committedPrismaMigrationNames(migrationsRoot);
  const stageOneIndex = names.indexOf(PROVIDER_INVOCATION_STAGE_ONE_MIGRATION);
  const stableRoutingIndex = names.indexOf(PROVIDER_MODEL_STABLE_ROUTING_REFERENCE_MIGRATION);
  const stableReferencesIndex = names.indexOf(REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION);
  const triggerMigrationIndex = names.indexOf(PROVIDER_ATTEMPT_TRANSITION_TRIGGER_MIGRATION);
  if (stageOneIndex < 0
    || stableRoutingIndex <= stageOneIndex
    || stableReferencesIndex !== stableRoutingIndex + 1
    || triggerMigrationIndex <= stableReferencesIndex) {
    throw recoveryError("provider_attempt_reference_recovery_lineage_invalid", "Committed migration lineage does not contain the supported recovery boundary");
  }
  const migrationSources = new Map(names.map((name) => [
    name,
    readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8"),
  ]));
  const checksums = new Map([...migrationSources].map(([name, sql]) => [
    name,
    createHash("sha256").update(sql).digest("hex"),
  ]));
  if (checksums.get(REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION) !== REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM) {
    throw recoveryError("provider_attempt_reference_recovery_source_checksum_invalid", "Recorded migration source checksum is not the published recovery checksum");
  }
  const immutableFunctionSource = extractFunctionSource(
    migrationSources.get(POSTGRES_BASELINE_MIGRATION),
    "friday_relay_reject_immutable_update",
  );
  const transitionFunctionSource = extractFunctionSource(
    migrationSources.get(PROVIDER_ATTEMPT_TRANSITION_FUNCTION_REPAIR_MIGRATION),
    "friday_relay_validate_provider_attempt_terminal",
  );
  return {
    names,
    checksums,
    immutableFunctionSource,
    transitionFunctionSource,
    stageOneIndex,
    stableRoutingIndex,
    stableReferencesIndex,
  };
}

async function inspectLedger(context: PostgresTransactionContext, lineage: Lineage): Promise<{
  kind: "before_supported_boundary" | "pending" | "failed_zero_step" | "rolled_back_pending" | "already_applied";
  appliedHead: string | null;
}> {
  let rows: MigrationRow[];
  try {
    rows = (await context.query<MigrationRow>(
      `SELECT "migration_name" AS "migrationName", "checksum",
              "finished_at" AS "finishedAt", "rolled_back_at" AS "rolledBackAt",
              "applied_steps_count" AS "appliedStepsCount"
       FROM "_prisma_migrations"
       ORDER BY "migration_name", "started_at", "id"`,
    )).rows;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42P01") {
      return { kind: "before_supported_boundary", appliedHead: null };
    }
    throw error;
  }
  const successful = rows.filter((row) => row.finishedAt !== null && row.rolledBackAt === null);
  const unresolved = rows.filter((row) => row.finishedAt === null && row.rolledBackAt === null);
  const rolledBack = rows.filter((row) => row.rolledBackAt !== null);
  const successfulNames = successful.map((row) => row.migrationName).sort();
  if (new Set(successfulNames).size !== successfulNames.length
    || successfulNames.some((name, index) => lineage.names[index] !== name)) {
    throw recoveryError("provider_attempt_reference_recovery_history_diverged", "Successful migration history is not an exact committed prefix");
  }
  if (successful.some((row) => lineage.checksums.get(row.migrationName) !== row.checksum)) {
    throw recoveryError("provider_attempt_reference_recovery_successful_checksum_invalid", "Successful migration history checksum does not match committed source");
  }
  if (successfulNames.includes(REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION)) {
    return { kind: "already_applied", appliedHead: successfulNames.at(-1) ?? null };
  }
  if (rolledBack.some((row) => row.migrationName !== REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION
      || row.checksum !== REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM
      || row.finishedAt !== null
      || row.appliedStepsCount !== 0)) {
    throw recoveryError("provider_attempt_reference_recovery_rolled_back_history_invalid", "Recovery found an unexpected rolled-back migration row");
  }
  if (unresolved.length > 0) {
    if (unresolved.length !== 1) {
      throw recoveryError("provider_attempt_reference_recovery_failed_history_ambiguous", "Recovery requires exactly one unfinished migration row");
    }
    const failed = unresolved[0]!;
    if (failed.migrationName !== REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION
      || failed.checksum !== REQUEST_EXECUTION_STABLE_REFERENCES_CHECKSUM
      || failed.appliedStepsCount !== 0
      || successfulNames.length !== lineage.stableReferencesIndex) {
      throw recoveryError("provider_attempt_reference_recovery_failed_history_invalid", "Unfinished migration is not the exact zero-step stable-reference failure");
    }
    return { kind: "failed_zero_step", appliedHead: successfulNames.at(-1) ?? null };
  }
  if (successfulNames.length <= lineage.stageOneIndex) {
    return { kind: "before_supported_boundary", appliedHead: successfulNames.at(-1) ?? null };
  }
  if (successfulNames.length > lineage.stableReferencesIndex) {
    throw recoveryError("provider_attempt_reference_recovery_history_gap", "Successful migration history crossed the stable-reference boundary without applying it");
  }
  return {
    kind: rolledBack.length > 0 ? "rolled_back_pending" : "pending",
    appliedHead: successfulNames.at(-1) ?? null,
  };
}

async function assertPhysicalPre012State(
  context: PostgresTransactionContext,
  lineage: Lineage,
  stableRoutingRecorded: boolean,
): Promise<void> {
  const artifacts = (await context.query<{
    columnCount: number;
    functionCount: number;
    triggerCount: number;
    constraintCount: number;
    indexCount: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'request_provider_attempts' AND column_name = 'provider_model_id')
            OR (table_name = 'request_executions' AND column_name = 'selected_plan_subscription_id'))) AS "columnCount",
       (SELECT count(*)::int FROM pg_proc function
        JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
        WHERE namespace.nspname = 'public' AND function.proname = ANY($1::text[])) AS "functionCount",
       (SELECT count(*)::int FROM pg_trigger trigger
        WHERE NOT trigger.tgisinternal AND trigger.tgname = ANY($2::text[])) AS "triggerCount",
       (SELECT count(*)::int FROM pg_constraint
        WHERE conname = ANY($3::text[])) AS "constraintCount",
       (SELECT count(*)::int FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ANY($4::text[])) AS "indexCount"`,
    [POST_012_FUNCTIONS, POST_012_TRIGGERS, POST_012_CONSTRAINTS, POST_012_INDEXES],
  )).rows[0];
  if (!artifacts || Object.values(artifacts).some((count) => count !== 0)) {
    throw recoveryError("provider_attempt_reference_recovery_physical_state_invalid", "Stable-reference migration artifacts were not fully rolled back");
  }
  const ambiguousAttemptCount = (await context.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM "request_provider_attempts" attempt
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS matches
       FROM "provider_models" model
       WHERE model."provider_id" = attempt."provider_id"
         AND model."provider_model_name" = attempt."provider_model_name"
     ) resolution
     WHERE resolution.matches <> 1`,
  )).rows[0]?.count;
  if (ambiguousAttemptCount !== 0) {
    throw recoveryError("provider_attempt_reference_recovery_model_resolution_invalid", "Every ProviderAttempt must resolve exactly one ProviderModel");
  }
  if (stableRoutingRecorded) {
    const stableRoutingIndex = (await context.query<{
      definition: string;
      unique: boolean;
      valid: boolean;
      ready: boolean;
      live: boolean;
    }>(
      `SELECT pg_get_indexdef(index_class.oid) AS definition,
              index.indisunique AS "unique", index.indisvalid AS valid,
              index.indisready AS ready, index.indislive AS live
       FROM pg_class table_class
       JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
       JOIN pg_index index ON index.indrelid = table_class.oid
       JOIN pg_class index_class ON index_class.oid = index.indexrelid
       WHERE namespace.nspname = 'public' AND table_class.relname = 'provider_models'
         AND index_class.relname = 'provider_models_provider_identity_unique'`,
    )).rows[0];
    if (!stableRoutingIndex
      || stableRoutingIndex.definition !== "CREATE UNIQUE INDEX provider_models_provider_identity_unique ON public.provider_models USING btree (provider_id, provider_model_name)"
      || stableRoutingIndex.unique !== true
      || stableRoutingIndex.valid !== true
      || stableRoutingIndex.ready !== true
      || stableRoutingIndex.live !== true) {
      throw recoveryError("provider_attempt_reference_recovery_stable_routing_index_invalid", "Recorded stable-routing migration is missing its canonical ProviderModel identity index");
    }
  }
  await assertCanonicalFunction(context, "friday_relay_reject_immutable_update", lineage.immutableFunctionSource);
  await assertCanonicalFunction(context, "friday_relay_validate_provider_attempt_terminal", lineage.transitionFunctionSource);
  const immutable = await triggerRow(context, "request_provider_attempts_immutable_update");
  if (!immutable
    || immutable.enabled !== "O"
    || immutable.functionName !== "friday_relay_reject_immutable_update"
    || immutable.triggerColumns.length !== 0
    || !sameArray(decodeTriggerArguments(immutable.arguments), IMMUTABLE_TRIGGER_ARGUMENTS)
    || !/^CREATE TRIGGER request_provider_attempts_immutable_update BEFORE UPDATE ON public\.request_provider_attempts FOR EACH ROW EXECUTE FUNCTION friday_relay_reject_immutable_update\(/u.test(immutable.definition)) {
    throw recoveryError("provider_attempt_reference_recovery_immutable_trigger_invalid", "ProviderAttempt immutable trigger is not the canonical repaired definition");
  }
}

async function assertCanonicalFunction(
  context: PostgresTransactionContext,
  functionName: string,
  expectedSource: string,
): Promise<void> {
  const row = (await context.query<{
    schemaName: string;
    identityArguments: string;
    resultType: string;
    languageName: string;
    source: string;
    securityDefiner: boolean;
    volatility: string;
    leakproof: boolean;
    parallelSafety: string;
    configuration: string[] | null;
  }>(
    `SELECT namespace.nspname AS "schemaName",
            pg_get_function_identity_arguments(function.oid) AS "identityArguments",
            pg_get_function_result(function.oid) AS "resultType",
            language.lanname AS "languageName", function.prosrc AS source,
            function.prosecdef AS "securityDefiner", function.provolatile AS volatility,
            function.proleakproof AS leakproof, function.proparallel AS "parallelSafety",
            function.proconfig AS configuration
     FROM pg_proc function
     JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
     JOIN pg_language language ON language.oid = function.prolang
     WHERE namespace.nspname = 'public' AND function.proname = $1
       AND pg_get_function_identity_arguments(function.oid) = ''`,
    [functionName],
  )).rows;
  const functionDefinition = row[0];
  if (row.length !== 1
    || !functionDefinition
    || functionDefinition.schemaName !== "public"
    || functionDefinition.identityArguments !== ""
    || functionDefinition.resultType !== "trigger"
    || functionDefinition.languageName !== "plpgsql"
    || functionDefinition.source !== expectedSource
    || functionDefinition.securityDefiner !== false
    || functionDefinition.volatility !== "v"
    || functionDefinition.leakproof !== false
    || functionDefinition.parallelSafety !== "u"
    || functionDefinition.configuration !== null) {
    throw recoveryError("provider_attempt_reference_recovery_function_invalid", `ProviderAttempt recovery function ${functionName} is not the canonical migration definition`);
  }
}

async function assertTransitionTrigger(
  context: PostgresTransactionContext,
  expected: "unscoped_or_scoped" | "scoped",
): Promise<"unscoped" | "scoped"> {
  const trigger = await triggerRow(context, "request_provider_attempts_terminal_update");
  if (!trigger
    || trigger.enabled !== "O"
    || trigger.functionName !== "friday_relay_validate_provider_attempt_terminal"
    || trigger.arguments !== ""
    || !/^CREATE TRIGGER request_provider_attempts_terminal_update BEFORE UPDATE(?: OF [a-z_, ]+)? ON public\.request_provider_attempts FOR EACH ROW EXECUTE FUNCTION friday_relay_validate_provider_attempt_terminal\(\)$/u.test(trigger.definition)) {
    throw recoveryError("provider_attempt_reference_recovery_transition_trigger_invalid", "ProviderAttempt transition trigger is not a supported definition");
  }
  const state = trigger.triggerColumns.length === 0
    ? "unscoped"
    : sameArray(trigger.triggerColumns, LIFECYCLE_COLUMNS) ? "scoped" : undefined;
  if (!state || (expected === "scoped" && state !== "scoped")) {
    throw recoveryError("provider_attempt_reference_recovery_transition_trigger_scope_invalid", "ProviderAttempt transition trigger has an unexpected column scope");
  }
  return state;
}

async function triggerRow(context: PostgresTransactionContext, triggerName: string): Promise<TriggerRow | undefined> {
  return (await context.query<TriggerRow>(
    `SELECT trigger.tgname AS name, trigger.tgenabled AS enabled,
            function.proname AS "functionName", pg_get_triggerdef(trigger.oid) AS definition,
            COALESCE(jsonb_agg(attribute.attname ORDER BY trigger_column.ordinality)
              FILTER (WHERE attribute.attname IS NOT NULL), '[]'::jsonb) AS "triggerColumns",
            encode(trigger.tgargs, 'escape') AS arguments
     FROM pg_trigger trigger
     JOIN pg_proc function ON function.oid = trigger.tgfoid
     LEFT JOIN LATERAL unnest(trigger.tgattr::smallint[]) WITH ORDINALITY AS trigger_column(attnum, ordinality) ON true
     LEFT JOIN pg_attribute attribute ON attribute.attrelid = trigger.tgrelid AND attribute.attnum = trigger_column.attnum
     WHERE trigger.tgrelid = 'request_provider_attempts'::regclass
       AND trigger.tgname = $1
       AND NOT trigger.tgisinternal
     GROUP BY trigger.oid, function.proname`,
    [triggerName],
  )).rows[0];
}

async function scopeTransitionTrigger(context: PostgresTransactionContext): Promise<void> {
  await context.query(`DROP TRIGGER "request_provider_attempts_terminal_update" ON "request_provider_attempts"`);
  await context.query(`CREATE TRIGGER "request_provider_attempts_terminal_update"
    BEFORE UPDATE OF
      "outcome", "failure_class", "output_committed", "trusted_usage_source", "ended_at",
      "cost_exposure", "final_usage_evidence", "usage_settled", "reconciliation_reason"
    ON "request_provider_attempts"
    FOR EACH ROW EXECUTE FUNCTION "friday_relay_validate_provider_attempt_terminal"()`);
}

async function acquireMigrationLock(context: PostgresTransactionContext): Promise<void> {
  await context.query("SELECT set_config('idle_in_transaction_session_timeout', '0', true)");
  const lock = await context.query<{ acquired: boolean }>(MIGRATION_LOCK_SQL);
  if (lock.rows[0]?.acquired !== true) {
    throw recoveryError("postgres_migration_lock_busy", "Another deployment owns the PostgreSQL migration lock");
  }
}

function extractFunctionSource(sql: string | undefined, functionName: string): string {
  if (sql === undefined) {
    throw recoveryError("provider_attempt_reference_recovery_function_source_missing", `Migration source for ${functionName} is missing`);
  }
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `CREATE OR REPLACE FUNCTION "${escapedName}"\\(\\) RETURNS trigger LANGUAGE plpgsql AS \\$\\$(.*?)\\$\\$;`,
    "su",
  ).exec(sql);
  if (!match?.[1]) {
    throw recoveryError("provider_attempt_reference_recovery_function_source_invalid", `Migration source for ${functionName} is not canonical`);
  }
  return match[1];
}

function decodeTriggerArguments(value: string): string[] {
  return value === "" ? [] : value.split("\\000").filter((item) => item.length > 0);
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recoveryError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
