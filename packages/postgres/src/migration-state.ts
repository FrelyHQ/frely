import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolvePostgresPrismaRuntimeArtifacts } from "@frely/postgres/runtime-artifacts";
import type { PostgresTransactionContext } from "./server.js";

export type PrismaMigrationStatus = "current" | "pending" | "failed" | "diverged";

export interface PrismaMigrationState {
  status: PrismaMigrationStatus;
  allowed: boolean;
  required: boolean;
  migrationHead: string;
  appliedHead: string | null;
  pendingMigrationNames: string[];
  failedMigrationNames: string[];
  reason: "migration_current" | "migration_pending" | "migration_failed" | "migration_history_diverged";
}

export const ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION = "20260901001000_access_point_scope_idempotency";

export type AccessPointScopeIdempotencyMigrationStatus = "absent" | "applied" | "failed";

export interface AccessPointScopeIdempotencyMigrationPreflight {
  migrationName: typeof ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION;
  status: AccessPointScopeIdempotencyMigrationStatus;
  observedChecksum: string | null;
  expectedChecksum: string;
  legacyDuplicateGroups: number;
  allowed: boolean;
  reason: "migration_absent" | "migration_applied" | "migration_failed" | "legacy_duplicate_groups" | "migration_checksum_mismatch";
}

interface PrismaMigrationRow extends Record<string, unknown> {
  id: string;
  migrationName: string;
  checksum: string;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  rolledBackAt: Date | string | null;
}

const { migrationsRoot: defaultMigrationsRoot } = resolvePostgresPrismaRuntimeArtifacts();

export function committedPrismaMigrationNames(migrationsRoot = defaultMigrationsRoot): string[] {
  const names = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) throw new Error("prisma_migration_history_empty");
  return names;
}

export function committedPrismaMigrationHead(migrationsRoot = defaultMigrationsRoot): string {
  return committedPrismaMigrationNames(migrationsRoot).at(-1)!;
}

export function committedPrismaMigrationChecksum(
  migrationName: string = ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
  migrationsRoot = defaultMigrationsRoot,
): string {
  return createHash("sha256").update(readFileSync(`${migrationsRoot}/${migrationName}/migration.sql`)).digest("hex");
}

export async function inspectAccessPointScopeIdempotencyMigration(
  context: Pick<PostgresTransactionContext, "query">,
  options: { migrationsRoot?: string; expectedChecksum?: string } = {},
): Promise<AccessPointScopeIdempotencyMigrationPreflight> {
  const expectedChecksum = options.expectedChecksum ?? committedPrismaMigrationChecksum(ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION, options.migrationsRoot ?? defaultMigrationsRoot);
  let migrationRows: Array<{ checksum: string; finishedAt: Date | string | null; rolledBackAt: Date | string | null }> = [];
  try {
    migrationRows = (await context.query<{ checksum: string; finishedAt: Date | string | null; rolledBackAt: Date | string | null }>(
      `SELECT "checksum", "finished_at" AS "finishedAt", "rolled_back_at" AS "rolledBackAt"
       FROM "_prisma_migrations"
       WHERE "migration_name" = $1
       ORDER BY "started_at" DESC, "id" DESC
       LIMIT 1`,
      [ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION],
    )).rows;
  } catch (error) {
    if (!isMissingRelationError(error)) throw error;
  }

  const row = migrationRows[0];
  // Prisma keeps a resolved failed row in the ledger with rolled_back_at set.
  // That row is safe to replay and must retain the pending/absent preflight
  // semantics; only an unfinished, unresolved row is a failed migration.
  const status: AccessPointScopeIdempotencyMigrationStatus = !row || row.rolledBackAt !== null
    ? "absent"
    : row.finishedAt !== null
      ? "applied"
      : "failed";
  const observedChecksum = row?.checksum ?? null;
  if (status === "applied") {
    return Object.freeze({
      migrationName: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
      status,
      observedChecksum,
      expectedChecksum,
      legacyDuplicateGroups: 0,
      allowed: observedChecksum === expectedChecksum,
      reason: observedChecksum === expectedChecksum ? "migration_applied" : "migration_checksum_mismatch",
    });
  }
  if (status === "failed") {
    return Object.freeze({
      migrationName: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
      status,
      observedChecksum,
      expectedChecksum,
      legacyDuplicateGroups: 0,
      allowed: false,
      reason: "migration_failed",
    });
  }

  let legacyDuplicateGroups = 0;
  try {
    const duplicates = await context.query<{ duplicateGroups: number }>(
      `SELECT COUNT(*)::int AS "duplicateGroups"
       FROM (
         SELECT "scope_ref", "creation_idempotency_key_hash"
         FROM "access_points"
         WHERE "creation_idempotency_key_hash" IS NOT NULL
         GROUP BY "scope_ref", "creation_idempotency_key_hash"
         HAVING COUNT(DISTINCT "owner_id") > 1
       ) legacy_duplicates`,
    );
    legacyDuplicateGroups = Number(duplicates.rows[0]?.duplicateGroups ?? 0);
  } catch (error) {
    if (!isMissingRelationError(error)) throw error;
  }
  return Object.freeze({
    migrationName: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
    status,
    observedChecksum,
    expectedChecksum,
    legacyDuplicateGroups,
    allowed: legacyDuplicateGroups === 0,
    reason: legacyDuplicateGroups === 0 ? "migration_absent" : "legacy_duplicate_groups",
  });
}

export async function inspectPrismaMigrationState(
  context: Pick<PostgresTransactionContext, "query">,
  options: { migrationsRoot?: string } = {},
): Promise<PrismaMigrationState> {
  const committed = committedPrismaMigrationNames(options.migrationsRoot ?? defaultMigrationsRoot);
  const migrationHead = committed.at(-1)!;
  let rows: PrismaMigrationRow[];
  try {
    rows = (await context.query<PrismaMigrationRow>(
      `SELECT "id", "migration_name" AS "migrationName", "checksum",
              "started_at" AS "startedAt", "finished_at" AS "finishedAt",
              "rolled_back_at" AS "rolledBackAt"
       FROM "_prisma_migrations" ORDER BY "migration_name" ASC, "started_at" ASC, "id" ASC`,
    )).rows;
  } catch (error) {
    if (isMissingRelationError(error)) {
      return state({ status: "pending", committed, successful: [], failed: [] });
    }
    throw error;
  }

  const failed = rows
    .filter((row) => row.finishedAt === null && row.rolledBackAt === null)
    .map((row) => row.migrationName);
  if (failed.length > 0) return state({ status: "failed", committed, successful: successfulNames(rows), failed });

  const successful = successfulNames(rows);
  if (new Set(successful).size !== successful.length
    || successful.some((name, index) => committed[index] !== name)) {
    return state({ status: "diverged", committed, successful, failed: [] });
  }
  return state({
    status: successful.length === committed.length ? "current" : "pending",
    committed,
    successful,
    failed: [],
  });
}

export async function assertPrismaMigrationsCurrent(
  context: Pick<PostgresTransactionContext, "query">,
  options: { migrationsRoot?: string } = {},
): Promise<PrismaMigrationState> {
  const migration = await inspectPrismaMigrationState(context, options);
  if (migration.status !== "current") {
    throw new Error(`prisma_migration_state_not_current:${migration.status}`);
  }
  return migration;
}

function successfulNames(rows: PrismaMigrationRow[]): string[] {
  return rows
    .filter((row) => row.finishedAt !== null && row.rolledBackAt === null)
    .map((row) => row.migrationName)
    .sort();
}

function state({
  status,
  committed,
  successful,
  failed,
}: {
  status: PrismaMigrationStatus;
  committed: string[];
  successful: string[];
  failed: string[];
}): PrismaMigrationState {
  const allowed = status === "current" || status === "pending";
  const required = status === "pending";
  const reasons = {
    current: "migration_current",
    pending: "migration_pending",
    failed: "migration_failed",
    diverged: "migration_history_diverged",
  } as const;
  return {
    status,
    allowed,
    required,
    migrationHead: committed.at(-1)!,
    appliedHead: successful.at(-1) ?? null,
    pendingMigrationNames: status === "pending" ? committed.slice(successful.length) : [],
    failedMigrationNames: [...failed],
    reason: reasons[status],
  };
}

function isMissingRelationError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "42P01");
}
