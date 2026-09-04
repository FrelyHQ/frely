import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePostgresPrismaRuntimeArtifacts } from "@frely/postgres/runtime-artifacts";
import { afterEach, describe, expect, test } from "vitest";
import { assertPrismaMigrationsCurrent, committedPrismaMigrationNames, inspectAccessPointScopeIdempotencyMigration, inspectPrismaMigrationState } from "@frely/postgres/migration-state";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Prisma migration state", () => {
  test("reads the canonical migration lineage from the installed PostgreSQL artifacts", () => {
    const { migrationsRoot } = resolvePostgresPrismaRuntimeArtifacts();
    expect(committedPrismaMigrationNames()).toEqual(committedPrismaMigrationNames(migrationsRoot));
  });

  test("uses the committed directory order as the only expected history", async () => {
    const root = migrationRoot();
    const state = await inspectPrismaMigrationState(context([
      row("20260813000000_baseline", "finished"),
    ]), { migrationsRoot: root });
    expect(state).toMatchObject({
      status: "pending",
      allowed: true,
      required: true,
      appliedHead: "20260813000000_baseline",
      migrationHead: "20260813001000_next",
      pendingMigrationNames: ["20260813001000_next"],
    });
  });

  test("keeps the deployed ProviderAttempt repair head as a prefix of forward integration migrations", async () => {
    const deployedRepairPrefix = [
      "20260813000000_postgresql_baseline",
      "20260813001000_model_access_routing",
      "20260813002000_usd_units_expand",
      "20260813003000_provider_invocation_stage_1",
      "20260813004000_access_point_request_overrides",
      "20260820000000_task_leases",
      "20260824000000_repair_provider_attempt_mutable_fields",
      "20260824001000_repair_provider_attempt_transition_function",
    ];
    const committedMigrations = committedPrismaMigrationNames();
    expect(committedMigrations.slice(0, deployedRepairPrefix.length)).toEqual(deployedRepairPrefix);
    const pendingMigrationNames = committedMigrations.slice(deployedRepairPrefix.length);
    const state = await inspectPrismaMigrationState(context(
      deployedRepairPrefix.map((name) => row(name, "finished")),
    ));
    expect(state).toMatchObject({
      status: "pending",
      allowed: true,
      appliedHead: deployedRepairPrefix.at(-1),
      migrationHead: committedMigrations.at(-1),
      pendingMigrationNames,
    });
  });

  test("accepts an exact successful Prisma history when timestamp ties return rows out of order", async () => {
    const root = migrationRoot();
    const state = await assertPrismaMigrationsCurrent(context([
      row("20260813001000_next", "finished"),
      row("20260813000000_baseline", "finished"),
    ]), { migrationsRoot: root });
    expect(state.status).toBe("current");
  });

  test("fails closed for unfinished and divergent histories", async () => {
    const root = migrationRoot();
    await expect(inspectPrismaMigrationState(context([
      row("20260813000000_baseline", "finished"),
      row("20260813001000_next", "started"),
    ]), { migrationsRoot: root })).resolves.toMatchObject({ status: "failed", allowed: false });
    await expect(inspectPrismaMigrationState(context([
      row("20260813001000_next", "finished"),
    ]), { migrationsRoot: root })).resolves.toMatchObject({ status: "diverged", allowed: false });
  });

  test("treats an empty database as pending instead of inventing history", async () => {
    const root = migrationRoot();
    const missing = { query: async () => { throw Object.assign(new Error("missing"), { code: "42P01" }); } };
    await expect(inspectPrismaMigrationState(missing, { migrationsRoot: root })).resolves.toMatchObject({
      status: "pending",
      appliedHead: null,
      pendingMigrationNames: ["20260813000000_baseline", "20260813001000_next"],
    });
  });

  test("fails closed before the scope-idempotency migration when legacy owners collide", async () => {
    const result = await inspectAccessPointScopeIdempotencyMigration({
      query: async (text) => text.includes("_prisma_migrations")
        ? { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] }
        : { rows: [{ duplicateGroups: 1 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] },
    }, { expectedChecksum: "b".repeat(64) });
    expect(result).toMatchObject({ status: "absent", legacyDuplicateGroups: 1, allowed: false, reason: "legacy_duplicate_groups" });
  });

  test("distinguishes an applied checksum from an unfinished migration", async () => {
    const applied = await inspectAccessPointScopeIdempotencyMigration(context([row("20260901001000_access_point_scope_idempotency", "finished")]), { expectedChecksum: "a".repeat(64) });
    expect(applied).toMatchObject({ status: "applied", allowed: true, reason: "migration_applied" });
    const mismatched = await inspectAccessPointScopeIdempotencyMigration(context([{ ...row("20260901001000_access_point_scope_idempotency", "finished"), checksum: "c".repeat(64) }]), { expectedChecksum: "a".repeat(64) });
    expect(mismatched).toMatchObject({ status: "applied", allowed: false, reason: "migration_checksum_mismatch" });
    const failed = await inspectAccessPointScopeIdempotencyMigration(context([row("20260901001000_access_point_scope_idempotency", "started")]), { expectedChecksum: "a".repeat(64) });
    expect(failed).toMatchObject({ status: "failed", allowed: false, reason: "migration_failed" });
    const rolledBack = await inspectAccessPointScopeIdempotencyMigration(context([{
      ...row("20260901001000_access_point_scope_idempotency", "started"),
      rolledBackAt: "2026-09-02T00:00:00.000Z",
    }]), { expectedChecksum: "a".repeat(64) });
    expect(rolledBack).toMatchObject({ status: "absent", allowed: true, reason: "migration_absent" });
  });
});

function migrationRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "friday-relay-prisma-state-"));
  roots.push(root);
  mkdirSync(join(root, "20260813000000_baseline"));
  mkdirSync(join(root, "20260813001000_next"));
  return root;
}

function row(migrationName: string, state: "finished" | "started") {
  return {
    id: `${migrationName}-${state}`,
    migrationName,
    checksum: "a".repeat(64),
    startedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: state === "finished" ? "2026-08-13T00:00:01.000Z" : null,
    rolledBackAt: null,
  };
}

function context(rows: ReturnType<typeof row>[]) {
  return { query: async () => ({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] }) };
}
