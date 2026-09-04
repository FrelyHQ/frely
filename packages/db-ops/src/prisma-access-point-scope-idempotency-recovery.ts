import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePostgresPrismaRuntimeArtifacts } from "@frely/postgres/runtime-artifacts";
import type { PostgresTransactionContext } from "@frely/postgres/server";
import {
  ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
  committedPrismaMigrationNames,
  type PrismaMigrationState,
} from "@frely/postgres/migration-state";

export const ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM = "c401a3cab9e8f2d4b748e3cdc72289b0d728589dcbcd3e7d5be074bcd6e3f3aa";
export const ACCESS_POINT_SCOPE_IDEMPOTENCY_REPAIR_MIGRATION = "20260901002000_access_point_scope_idempotency_repair";

const MIGRATION_LOCK_SQL = "SELECT pg_try_advisory_xact_lock(hashtextextended('friday-relay:prisma-migrate-deploy', 0)) AS acquired";
const LEGACY_INDEX_COLUMNS = Object.freeze([
  "scope_ref",
  "owner_id",
  "creation_idempotency_key_hash",
]);

interface RecoveryOwner {
  withTransaction<T>(callback: (context: PostgresTransactionContext) => Promise<T>): Promise<T>;
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

interface Lineage {
  names: string[];
  checksums: ReadonlyMap<string, string>;
  migrationIndex: number;
}

interface LedgerState {
  kind: "before_supported_boundary" | "pending" | "failed_zero_step" | "rolled_back_pending" | "already_applied";
  appliedHead: string | null;
}

interface LegacyIndexRow {
  name: string;
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  isLive: boolean;
  predicate: string | null;
  columns: string[] | null;
}

export interface AccessPointScopeIdempotencyRecoveryInspection {
  schema: "friday-relay.access-point-scope-idempotency-migration-recovery-inspection.v1";
  status: "not_applicable" | "ready_failed_zero_step";
  migrationName: typeof ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION;
  migrationChecksum: typeof ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM;
  appliedHead: string | null;
  physicalIndexState: "not_inspected" | "legacy";
  legacyDuplicateGroups: number;
  resolveRequired: boolean;
}

export interface AccessPointScopeIdempotencyRecoveryResult {
  schema: "friday-relay.access-point-scope-idempotency-migration-recovery.v1";
  status: "not_applicable" | "resolved_failed_zero_step";
  migrationName: typeof ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION;
  migrationChecksum: typeof ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM;
  legacyDuplicateGroups: number;
  resolveOutputDigest?: string;
}

export function isRecoverableAccessPointScopeIdempotencyMigrationPreflight(
  migration: Pick<PrismaMigrationState, "status" | "allowed" | "failedMigrationNames">,
  recovery: Pick<AccessPointScopeIdempotencyRecoveryInspection, "status"> | undefined,
): boolean {
  return migration.status === "failed"
    && migration.allowed === false
    && migration.failedMigrationNames.length === 1
    && migration.failedMigrationNames[0] === ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION
    && recovery?.status === "ready_failed_zero_step";
}

export async function inspectAccessPointScopeIdempotencyRecovery(
  owner: RecoveryOwner,
  options: { migrationsRoot?: string } = {},
): Promise<AccessPointScopeIdempotencyRecoveryInspection> {
  const lineage = validateCommittedLineage(options.migrationsRoot ?? resolvePostgresPrismaRuntimeArtifacts().migrationsRoot);
  return owner.withTransaction(async (context) => {
    const state = await inspectLedger(context, lineage);
    if (state.kind !== "failed_zero_step") {
      return inspection("not_applicable", state.appliedHead, "not_inspected", 0, false);
    }
    const legacyDuplicateGroups = await countLegacyDuplicateGroups(context);
    await assertLegacyIndex(context);
    return inspection("ready_failed_zero_step", state.appliedHead, "legacy", legacyDuplicateGroups, true);
  });
}

export async function recoverAccessPointScopeIdempotencyMigration(
  owner: RecoveryOwner,
  resolveRolledBack: () => ResolveResult,
  options: { migrationsRoot?: string } = {},
): Promise<AccessPointScopeIdempotencyRecoveryResult> {
  const lineage = validateCommittedLineage(options.migrationsRoot ?? resolvePostgresPrismaRuntimeArtifacts().migrationsRoot);
  const preparation = await owner.withTransaction(async (context) => {
    await acquireMigrationLock(context);
    const state = await inspectLedger(context, lineage);
    if (state.kind !== "failed_zero_step") return { state, legacyDuplicateGroups: 0 };
    const legacyDuplicateGroups = await countLegacyDuplicateGroups(context);
    if (legacyDuplicateGroups !== 0) {
      throw recoveryError(
        "access_point_scope_idempotency_legacy_duplicates",
        "Legacy cross-owner AccessPoint idempotency duplicates require a separate reviewed data decision",
      );
    }
    await assertLegacyIndex(context);
    return { state, legacyDuplicateGroups };
  });

  if (preparation.state.kind !== "failed_zero_step") {
    return result("not_applicable", preparation.legacyDuplicateGroups);
  }

  return owner.withTransaction(async (context) => {
    await acquireMigrationLock(context);
    const before = await inspectLedger(context, lineage);
    if (before.kind === "rolled_back_pending") {
      return result("resolved_failed_zero_step", 0);
    }
    if (before.kind !== "failed_zero_step") {
      throw recoveryError(
        "access_point_scope_idempotency_recovery_state_changed",
        "Failed AccessPoint idempotency migration state changed before Prisma resolve",
      );
    }
    if ((await countLegacyDuplicateGroups(context)) !== 0) {
      throw recoveryError(
        "access_point_scope_idempotency_legacy_duplicates",
        "Legacy cross-owner AccessPoint idempotency duplicates require a separate reviewed data decision",
      );
    }
    await assertLegacyIndex(context);
    const resolved = resolveRolledBack();
    const after = await inspectLedger(context, lineage);
    if (after.kind !== "rolled_back_pending") {
      throw recoveryError(
        "access_point_scope_idempotency_recovery_resolve_incomplete",
        "Prisma did not mark the exact failed AccessPoint idempotency migration as rolled back",
      );
    }
    return result("resolved_failed_zero_step", 0, resolved.outputDigest);
  });
}

function inspection(
  status: AccessPointScopeIdempotencyRecoveryInspection["status"],
  appliedHead: string | null,
  physicalIndexState: AccessPointScopeIdempotencyRecoveryInspection["physicalIndexState"],
  legacyDuplicateGroups: number,
  resolveRequired: boolean,
): AccessPointScopeIdempotencyRecoveryInspection {
  return {
    schema: "friday-relay.access-point-scope-idempotency-migration-recovery-inspection.v1",
    status,
    migrationName: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
    migrationChecksum: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM,
    appliedHead,
    physicalIndexState,
    legacyDuplicateGroups,
    resolveRequired,
  };
}

function result(
  status: AccessPointScopeIdempotencyRecoveryResult["status"],
  legacyDuplicateGroups: number,
  resolveOutputDigest?: string,
): AccessPointScopeIdempotencyRecoveryResult {
  return {
    schema: "friday-relay.access-point-scope-idempotency-migration-recovery.v1",
    status,
    migrationName: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
    migrationChecksum: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM,
    legacyDuplicateGroups,
    ...(resolveOutputDigest ? { resolveOutputDigest } : {}),
  };
}

function validateCommittedLineage(migrationsRoot: string): Lineage {
  const names = committedPrismaMigrationNames(migrationsRoot);
  const migrationIndex = names.indexOf(ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION);
  const repairIndex = names.indexOf(ACCESS_POINT_SCOPE_IDEMPOTENCY_REPAIR_MIGRATION);
  if (migrationIndex < 0 || repairIndex <= migrationIndex) {
    throw recoveryError(
      "access_point_scope_idempotency_recovery_lineage_invalid",
      "Committed migration lineage does not contain the supported AccessPoint idempotency recovery boundary",
    );
  }
  const sources = new Map(names.map((name) => [name, readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8")]));
  const checksums = new Map([...sources].map(([name, sql]) => [name, createHash("sha256").update(sql).digest("hex")]));
  if (checksums.get(ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION) !== ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM) {
    throw recoveryError(
      "access_point_scope_idempotency_recovery_source_checksum_invalid",
      "The committed AccessPoint idempotency migration source is not the published immutable checksum",
    );
  }
  return { names, checksums, migrationIndex };
}

async function inspectLedger(context: PostgresTransactionContext, lineage: Lineage): Promise<LedgerState> {
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
    if (isMissingRelationError(error)) return { kind: "before_supported_boundary", appliedHead: null };
    throw error;
  }

  const successful = rows.filter((row) => row.finishedAt !== null && row.rolledBackAt === null);
  const unresolved = rows.filter((row) => row.finishedAt === null && row.rolledBackAt === null);
  const rolledBack = rows.filter((row) => row.rolledBackAt !== null);
  const targetRolledBack = rolledBack.filter((row) => row.migrationName === ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION);
  const successfulNames = successful.map((row) => row.migrationName).sort();
  if (new Set(successfulNames).size !== successfulNames.length
    || successfulNames.some((name, index) => lineage.names[index] !== name)) {
    throw recoveryError(
      "access_point_scope_idempotency_recovery_history_diverged",
      "Successful migration history is not an exact committed prefix",
    );
  }
  if (successful.some((row) => lineage.checksums.get(row.migrationName) !== row.checksum)) {
    throw recoveryError(
      "access_point_scope_idempotency_recovery_successful_checksum_invalid",
      "Successful migration history checksum does not match committed source",
    );
  }
  if (successfulNames.includes(ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION)) {
    return { kind: "already_applied", appliedHead: successfulNames.at(-1) ?? null };
  }
  if (targetRolledBack.some((row) => row.checksum !== ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM
      || row.finishedAt !== null
      || row.appliedStepsCount !== 0)) {
    throw recoveryError(
      "access_point_scope_idempotency_recovery_rolled_back_history_invalid",
      "Recovery found an invalid rolled-back row for the AccessPoint idempotency migration",
    );
  }
  if (unresolved.length > 0) {
    if (unresolved.length !== 1) {
      throw recoveryError(
        "access_point_scope_idempotency_recovery_failed_history_ambiguous",
        "Recovery requires exactly one unfinished migration row",
      );
    }
    const failed = unresolved[0]!;
    if (failed.migrationName !== ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION
      || failed.checksum !== ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM
      || failed.appliedStepsCount !== 0
      || successfulNames.length !== lineage.migrationIndex) {
      throw recoveryError(
        "access_point_scope_idempotency_recovery_failed_history_invalid",
        "Unfinished migration is not the exact zero-step AccessPoint idempotency failure",
      );
    }
    return { kind: "failed_zero_step", appliedHead: successfulNames.at(-1) ?? null };
  }
  if (targetRolledBack.length > 0) return { kind: "rolled_back_pending", appliedHead: successfulNames.at(-1) ?? null };
  if (successfulNames.length < lineage.migrationIndex) {
    return { kind: "before_supported_boundary", appliedHead: successfulNames.at(-1) ?? null };
  }
  if (successfulNames.length > lineage.migrationIndex) {
    throw recoveryError(
      "access_point_scope_idempotency_recovery_history_gap",
      "Successful migration history crossed the AccessPoint idempotency boundary without applying it",
    );
  }
  return { kind: "pending", appliedHead: successfulNames.at(-1) ?? null };
}

async function countLegacyDuplicateGroups(context: PostgresTransactionContext): Promise<number> {
  const result = await context.query<{ duplicateGroups: number }>(
    `SELECT COUNT(*)::int AS "duplicateGroups"
     FROM (
       SELECT "scope_ref", "creation_idempotency_key_hash"
       FROM "access_points"
       WHERE "creation_idempotency_key_hash" IS NOT NULL
       GROUP BY "scope_ref", "creation_idempotency_key_hash"
       HAVING COUNT(DISTINCT "owner_id") > 1
     ) legacy_duplicates`,
  );
  return Number(result.rows[0]?.duplicateGroups ?? 0);
}

async function assertLegacyIndex(context: PostgresTransactionContext): Promise<void> {
  const rows = (await context.query<LegacyIndexRow>(
    `SELECT index_class.relname AS name,
            index.indisunique AS "isUnique", index.indisvalid AS "isValid",
            index.indisready AS "isReady", index.indislive AS "isLive",
            pg_get_expr(index.indpred, index.indrelid) AS predicate,
            COALESCE((
              SELECT array_agg(attribute.attname::text ORDER BY index_column.ordinality)
              FROM unnest(index.indkey::smallint[]) WITH ORDINALITY AS index_column(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid = index.indrelid
               AND attribute.attnum = index_column.attnum
            ), ARRAY[]::text[]) AS columns
     FROM pg_class table_class
     JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
     JOIN pg_index index ON index.indrelid = table_class.oid
     JOIN pg_class index_class ON index_class.oid = index.indexrelid
     WHERE namespace.nspname = 'public'
       AND table_class.relname = 'access_points'
       AND index_class.relname = 'access_points_create_idempotency_unique'`,
  )).rows;
  const index = rows[0];
  if (rows.length !== 1
    || !index
    || index.isUnique !== true
    || index.isValid !== true
    || index.isReady !== true
    || index.isLive !== true
    || !sameArray(index.columns ?? [], LEGACY_INDEX_COLUMNS)
    || normalizePredicate(index.predicate) !== "creation_idempotency_key_hashisnotnull") {
    throw recoveryError(
      "access_point_scope_idempotency_recovery_physical_state_invalid",
      "The legacy owner-scoped AccessPoint idempotency index is not intact",
    );
  }
}

async function acquireMigrationLock(context: PostgresTransactionContext): Promise<void> {
  await context.query("SELECT set_config('idle_in_transaction_session_timeout', '0', true)");
  const lock = await context.query<{ acquired: boolean }>(MIGRATION_LOCK_SQL);
  if (lock.rows[0]?.acquired !== true) {
    throw recoveryError("postgres_migration_lock_busy", "Another deployment owns the PostgreSQL migration lock");
  }
}

function normalizePredicate(value: string | null): string | null {
  return value?.replace(/[()\s"]/gu, "").toLowerCase() ?? null;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isMissingRelationError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "42P01");
}

function recoveryError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
