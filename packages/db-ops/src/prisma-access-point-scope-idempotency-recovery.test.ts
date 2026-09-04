import { join } from "node:path";
import type { PostgresTransactionContext } from "@frely/postgres/server";
import {
  ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
  committedPrismaMigrationChecksum,
  committedPrismaMigrationNames,
} from "@frely/postgres/migration-state";
import { describe, expect, test } from "vitest";
import {
  ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM,
  inspectAccessPointScopeIdempotencyRecovery,
  isRecoverableAccessPointScopeIdempotencyMigrationPreflight,
  recoverAccessPointScopeIdempotencyMigration,
} from "./prisma-access-point-scope-idempotency-recovery.js";

const migrationsRoot = join(process.cwd(), "packages/postgres/prisma/migrations");

describe("AccessPoint scope idempotency migration recovery", () => {
  test("admits only the exact recoverable zero-step failure to read-only deployment preflight", async () => {
    const failedHarness = createHarness();
    const ready = await inspectAccessPointScopeIdempotencyRecovery(failedHarness.owner, { migrationsRoot });
    const exactFailure = {
      status: "failed" as const,
      allowed: false,
      failedMigrationNames: [ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION],
    };

    expect(isRecoverableAccessPointScopeIdempotencyMigrationPreflight(exactFailure, ready)).toBe(true);
    expect(isRecoverableAccessPointScopeIdempotencyMigrationPreflight(
      { ...exactFailure, failedMigrationNames: ["20260901000000_other_migration"] },
      ready,
    )).toBe(false);
    expect(isRecoverableAccessPointScopeIdempotencyMigrationPreflight(
      { ...exactFailure, failedMigrationNames: [ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION, "20260901000000_other_migration"] },
      ready,
    )).toBe(false);
    expect(isRecoverableAccessPointScopeIdempotencyMigrationPreflight(
      { status: "pending", allowed: true, failedMigrationNames: [] },
      ready,
    )).toBe(false);

    const appliedHarness = createHarness({ applied: true });
    const notApplicable = await inspectAccessPointScopeIdempotencyRecovery(appliedHarness.owner, { migrationsRoot });
    expect(isRecoverableAccessPointScopeIdempotencyMigrationPreflight(exactFailure, notApplicable)).toBe(false);
  });

  test("resolves only the exact zero-step failure after validating the legacy index and data", async () => {
    const harness = createHarness();

    const recovery = await recoverAccessPointScopeIdempotencyMigration(
      harness.owner,
      () => {
        harness.resolveCalls += 1;
        harness.failedRow.rolledBackAt = new Date("2026-09-02T00:00:00.000Z");
        return { outputDigest: "sha256:test-resolve" };
      },
      { migrationsRoot },
    );

    expect(recovery).toEqual({
      schema: "friday-relay.access-point-scope-idempotency-migration-recovery.v1",
      status: "resolved_failed_zero_step",
      migrationName: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
      migrationChecksum: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM,
      legacyDuplicateGroups: 0,
      resolveOutputDigest: "sha256:test-resolve",
    });
    expect(harness.resolveCalls).toBe(1);
  });

  test("preserves unrelated rolled-back migration history while recovering the exact AccessPoint failure", async () => {
    const harness = createHarness({ unrelatedRolledBack: true });
    const unrelatedRolledBackAt = harness.unrelatedRolledBackRow?.rolledBackAt;

    const inspection = await inspectAccessPointScopeIdempotencyRecovery(harness.owner, { migrationsRoot });
    expect(inspection.status).toBe("ready_failed_zero_step");

    const recovery = await recoverAccessPointScopeIdempotencyMigration(
      harness.owner,
      () => {
        harness.resolveCalls += 1;
        harness.failedRow.rolledBackAt = new Date("2026-09-02T00:00:00.000Z");
        return { outputDigest: "sha256:test-resolve-with-unrelated-history" };
      },
      { migrationsRoot },
    );

    expect(recovery.status).toBe("resolved_failed_zero_step");
    expect(harness.resolveCalls).toBe(1);
    expect(harness.unrelatedRolledBackRow?.rolledBackAt).toEqual(unrelatedRolledBackAt);
  });

  test("rejects an invalid rolled-back row for the target AccessPoint migration", async () => {
    const harness = createHarness({ invalidTargetRolledBack: true });

    await expect(inspectAccessPointScopeIdempotencyRecovery(
      harness.owner,
      { migrationsRoot },
    )).rejects.toMatchObject({ code: "access_point_scope_idempotency_recovery_rolled_back_history_invalid" });
  });

  test("fails closed before resolve when legacy cross-owner duplicates exist", async () => {
    const harness = createHarness({ legacyDuplicateGroups: 1 });

    await expect(recoverAccessPointScopeIdempotencyMigration(
      harness.owner,
      () => {
        harness.resolveCalls += 1;
        return { outputDigest: "sha256:unexpected" };
      },
      { migrationsRoot },
    )).rejects.toMatchObject({ code: "access_point_scope_idempotency_legacy_duplicates" });
    expect(harness.resolveCalls).toBe(0);
  });

  test("fails closed before resolve when the legacy index is not canonical", async () => {
    const harness = createHarness({ indexColumns: ["scope_ref", "creation_idempotency_key_hash"] });

    await expect(recoverAccessPointScopeIdempotencyMigration(
      harness.owner,
      () => {
        harness.resolveCalls += 1;
        return { outputDigest: "sha256:unexpected" };
      },
      { migrationsRoot },
    )).rejects.toMatchObject({ code: "access_point_scope_idempotency_recovery_physical_state_invalid" });
    expect(harness.resolveCalls).toBe(0);
  });

  test("does not invoke recovery when the target migration is already applied", async () => {
    const harness = createHarness({ applied: true });

    const recovery = await recoverAccessPointScopeIdempotencyMigration(
      harness.owner,
      () => {
        harness.resolveCalls += 1;
        return { outputDigest: "sha256:unexpected" };
      },
      { migrationsRoot },
    );

    expect(recovery.status).toBe("not_applicable");
    expect(harness.resolveCalls).toBe(0);
  });
});

function createHarness(options: {
  applied?: boolean;
  indexColumns?: string[];
  invalidTargetRolledBack?: boolean;
  legacyDuplicateGroups?: number;
  unrelatedRolledBack?: boolean;
} = {}) {
  const names = committedPrismaMigrationNames(migrationsRoot);
  const migrationIndex = names.indexOf(ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION);
  const rows = (options.applied ? names : names.slice(0, migrationIndex)).map((migrationName) => ({
    migrationName,
    checksum: committedPrismaMigrationChecksum(migrationName, migrationsRoot),
    finishedAt: new Date("2026-09-01T00:00:00.000Z") as Date | null,
    rolledBackAt: null as Date | null,
    appliedStepsCount: 1,
  }));
  const failedRow = {
    migrationName: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
    checksum: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION_CHECKSUM,
    finishedAt: null as Date | null,
    rolledBackAt: null as Date | null,
    appliedStepsCount: 0,
  };
  if (!options.applied) rows.push(failedRow);
  const unrelatedMigrationName = names[0]!;
  const unrelatedRolledBackRow = options.unrelatedRolledBack ? {
    migrationName: unrelatedMigrationName,
    checksum: committedPrismaMigrationChecksum(unrelatedMigrationName, migrationsRoot),
    finishedAt: null as Date | null,
    rolledBackAt: new Date("2026-08-14T00:00:00.000Z") as Date | null,
    appliedStepsCount: 0,
  } : undefined;
  if (unrelatedRolledBackRow) rows.push(unrelatedRolledBackRow);
  if (options.invalidTargetRolledBack) {
    rows.push({
      migrationName: ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION,
      checksum: "f".repeat(64),
      finishedAt: null,
      rolledBackAt: new Date("2026-09-01T23:00:00.000Z"),
      appliedStepsCount: 0,
    });
  }
  const indexColumns = options.indexColumns ?? ["scope_ref", "owner_id", "creation_idempotency_key_hash"];
  let resolveCalls = 0;
  const context: PostgresTransactionContext = {
    query: async <Row extends Record<string, unknown>>(sql: string) => {
      if (sql.includes("pg_try_advisory_xact_lock")) return result<Row>([{ acquired: true }]);
      if (sql.includes('FROM "_prisma_migrations"')) return result<Row>(rows);
      if (sql.includes('FROM "access_points"')) return result<Row>([{ duplicateGroups: options.legacyDuplicateGroups ?? 0 }]);
      if (sql.includes("FROM pg_class")) {
        return result<Row>([{
          name: "access_points_create_idempotency_unique",
          isUnique: true,
          isValid: true,
          isReady: true,
          isLive: true,
          predicate: "(creation_idempotency_key_hash IS NOT NULL)",
          columns: indexColumns,
        }]);
      }
      return result<Row>([]);
    },
    copyFrom: () => { throw new Error("copy_not_available"); },
  };
  return {
    failedRow,
    unrelatedRolledBackRow,
    get resolveCalls() { return resolveCalls; },
    set resolveCalls(value: number) { resolveCalls = value; },
    owner: {
      withTransaction: async <Value>(callback: (transaction: PostgresTransactionContext) => Promise<Value>) => callback(context),
    },
  };
}

function result<Row extends Record<string, unknown>>(rows: Row[]) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}
