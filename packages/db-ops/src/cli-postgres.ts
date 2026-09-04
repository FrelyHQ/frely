import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createPasswordHash } from "@frely/auth";
import { RelayError } from "@frely/core";
import { PrismaAuditEventAppender } from "@frely/audit/application-internal";
import { AuthorityCommands, AuthorityQueries } from "@frely/authority/application-internal";
import { EmailAddr } from "@frely/identity";
import { IdentityCommands, IdentityQueries } from "@frely/identity/application-internal";
import { TenancyCommands, TenancyQueries } from "@frely/tenancy-context/application-internal";
import { loadWorkspaceConfig as loadConfig } from "@frely/config/workspace";
import { isDbOpsCommand } from "./cli-contract.js";
import { inspectAsyncDeploymentReadiness } from "./deployment-readiness.js";
import { createDbOpsVerificationCapabilities, type DbOpsVerificationQueries } from "@frely/application/internal/verification";
import { createPostgresClientFromEnvironment, resolvePostgresConnectionStringFromEnvironment } from "@frely/postgres/server";
import { ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION, assertPrismaMigrationsCurrent, inspectAccessPointScopeIdempotencyMigration, inspectPrismaMigrationState, type PrismaMigrationState } from "@frely/postgres/migration-state";
import { runPrismaMigrateDeploy, runPrismaMigrateResolveRolledBack, runPrismaMigrateStatus } from "./prisma-migrate-cli.js";
import {
  REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION,
  inspectProviderAttemptReferenceRecovery,
  recoverProviderAttemptReferenceMigration,
} from "./prisma-provider-attempt-reference-recovery.js";
import {
  inspectAccessPointScopeIdempotencyRecovery,
  isRecoverableAccessPointScopeIdempotencyMigrationPreflight,
  recoverAccessPointScopeIdempotencyMigration,
} from "./prisma-access-point-scope-idempotency-recovery.js";
import {
  finalizeRequestCaptureMonthlyArchive,
  purgeVerifiedRequestCaptureMonth,
  planRequestCaptureArchiveMonth,
  runRequestCaptureMonthlyArchive,
  runRequestCaptureMonthlyArchiveCatchUp,
  verifyConfiguredRequestCaptureMonthlyArchive,
  type RequestCaptureMonthlyArchiveProgress,
} from "@frely/capture";
import { runRequestCaptureArchiveOfflineCli, assertSharedCaptureStorageForConfig } from "@frely/capture";
import { runSellerSettlementReleaseTask } from "@frely/application/runtime";
import { PostgresTaskLeaseStore } from "@frely/application/internal/operations";
import { runRequestHistoryArchive, runRequestHistoryArchiveCatchUp, verifyRequestHistoryArchive } from "./request-history-archive.js";
import { reconcileStaleStartedRequestLogs } from "./request-log-reconciliation.js";
import { exportInstanceDataArtifact, inspectInstanceDataArtifact, restoreInstanceDataArtifact } from "./instance-data-artifact.js";

const command = process.argv[2];

if (["instance-data-export", "instance-data-inspect", "instance-data-restore"].includes(command ?? "")) {
  await runInstanceDataCli(command as "instance-data-export" | "instance-data-inspect" | "instance-data-restore");
} else {
const config = await loadConfig();

if (config.database.backend !== "postgres") throw cliError("postgres_runtime_required", "Database operations require PostgreSQL");

if (command === "capture-month-archive" && ["verify", "query", "read", "copy"].includes(process.argv[3] ?? "")) {
  await runRequestCaptureArchiveOfflineCli(process.argv.slice(3), {
    ...(config.archive.coldDirectory ? { defaultRoot: config.archive.coldDirectory } : {}),
  });
} else if (command === "runtime-config-check") {
  if (config.app.environment !== "production") throw new Error("deployment_app_environment_must_be_production");
  const secret = process.env.FRIDAY_RELAY_SECRET_KEY;
  if (!secret || secret.length < 32) throw new Error("friday_relay_secret_key_invalid");
  resolvePostgresConnectionStringFromEnvironment(process.env);
  console.log("Runtime config check passed");
} else if (!isDbOpsCommand(command)) {
  throw cliError("postgres_db_ops_command_not_migrated", `Command ${command ?? "(missing)"} is not available for the PostgreSQL backend`);
} else {
  const client = createPostgresClientFromEnvironment(process.env);
  if (command === "migration-recover-provider-attempt-reference") {
    try {
      if (cliFlag("--plan") && !cliFlag("--execute") && !cliFlag("--deployment-lock-held")) {
        console.log(JSON.stringify(await inspectProviderAttemptReferenceRecovery(client)));
      } else {
        if (!cliFlag("--execute") || !cliFlag("--deployment-lock-held") || cliFlag("--plan")) {
          throw cliError(
            "provider_attempt_reference_recovery_confirmation_required",
            "ProviderAttempt reference migration recovery requires either --plan or --execute with --deployment-lock-held",
          );
        }
        const recovery = await recoverProviderAttemptReferenceMigration(
          client,
          () => runPrismaMigrateResolveRolledBack(REQUEST_EXECUTION_STABLE_REFERENCES_MIGRATION, process.env),
        );
        console.log(JSON.stringify(recovery));
      }
    } finally {
      await client.close();
    }
  } else {
    if (command === "migrate" || command === "migrate-locked") {
      const recovery = await recoverAccessPointScopeIdempotencyMigration(
        client,
        () => runPrismaMigrateResolveRolledBack(ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION, process.env),
      );
      if (recovery.status !== "not_applicable") console.log(JSON.stringify(recovery));
    }
    if (command === "migrate") {
      await assertAccessPointScopeIdempotencyMigrationPreflight(client);
      runPrismaMigrateDeploy(process.env);
    }
    const capabilities = createDbOpsVerificationCapabilities(client);
    try {
    if (command === "migrate-locked") {
      await client.withTransaction(async (transaction) => {
        await transaction.query("SELECT set_config('idle_in_transaction_session_timeout', '0', true)");
        const lock = await transaction.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('friday-relay:prisma-migrate-deploy', 0)) AS acquired");
        if (lock.rows[0]?.acquired !== true) throw cliError("postgres_migration_lock_busy", "Another deployment owns the PostgreSQL migration lock");
        await assertAccessPointScopeIdempotencyMigrationPreflight(transaction);
        runPrismaMigrateDeploy(process.env);
      });
    }
    const migration = await inspectPrismaMigrationState(client);
    const accessPointRecovery = command === "migration-preflight"
      && migration.status === "failed"
      && migration.failedMigrationNames.length === 1
      && migration.failedMigrationNames[0] === ACCESS_POINT_SCOPE_IDEMPOTENCY_MIGRATION
      ? await inspectAccessPointScopeIdempotencyRecovery(client)
      : undefined;
    const recoverableAccessPointPreflight = isRecoverableAccessPointScopeIdempotencyMigrationPreflight(
      migration,
      accessPointRecovery,
    );
    if (command === "migration-status") {
      const prisma = runPrismaMigrateStatus(process.env);
      assertPrismaStatusAgreement(migration, prisma.status);
      if (cliFlag("--required")) console.log(migration.required ? "1" : "0");
      else if (cliFlag("--backup-required")) console.log(migration.required ? "1" : "0");
      else if (cliFlag("--allowed")) console.log(migration.allowed ? "1" : "0");
      else if (cliFlag("--direction")) console.log(migration.status);
      else {
        console.log(JSON.stringify({ backend: "postgres", ...migration, prismaStatusExitCode: prisma.status, prismaStatusOutputDigest: prisma.outputDigest }));
        if (cliFlag("--assert-allowed") && !migration.allowed) process.exitCode = 1;
      }
    } else if (!migration.allowed && !recoverableAccessPointPreflight) {
      throw cliError("postgres_database_migration_not_allowed", `Prisma migration refused: status=${migration.status} reason=${migration.reason}`);
    } else if (command === "migration-preflight") {
      const accessPointMigration = recoverableAccessPointPreflight
        ? await inspectAccessPointScopeIdempotencyMigration(client)
        : await assertAccessPointScopeIdempotencyMigrationPreflight(client);
      const health = await client.health();
      const deploymentReadiness = migration.appliedHead === null ? undefined : await inspectAsyncDeploymentReadiness(capabilities.queries, {
        privateProviderOrigin: process.env.FRIDAY_RELAY_PRIVATE_PROVIDER_ORIGIN,
      });
      console.log("Migration preflight passed: main=1");
      console.log(JSON.stringify({ event: "postgres_migration_preflight", backend: "postgres", migrationStatus: migration, accessPointScopeIdempotencyMigration: accessPointMigration, ...(accessPointRecovery ? { accessPointScopeIdempotencyRecovery: accessPointRecovery } : {}), health: { ok: health.ok }, ...(deploymentReadiness ? { deploymentReadiness } : {}) }));
      if (cliFlag("--assert-private-origin") && deploymentReadiness && ["missing", "mismatch"].includes(deploymentReadiness.privateProviderOrigin.status)) process.exitCode = 1;
    } else if (command === "create-restore-point") {
      if (migration.status !== "pending") throw cliError("postgres_restore_point_pending_migration_required", "A release restore point is only created for a pending migration");
      const name = requiredCliOption("--name");
      if (!/^[a-z][a-z0-9_.-]{2,62}$/u.test(name)) throw cliError("postgres_restore_point_name_invalid", "Restore point name is invalid");
      const result = await client.query<{ lsn: string }>("SELECT pg_create_restore_point($1) AS lsn", [name]);
      const lsn = result.rows[0]?.lsn;
      if (typeof lsn !== "string" || !/^[0-9A-F]+\/[0-9A-F]+$/u.test(lsn)) throw cliError("postgres_restore_point_lsn_invalid", "PostgreSQL did not return a restore point LSN");
      const identity = { schema: "friday-relay.postgres-restore-point.v1", name, lsn, migrationHead: migration.migrationHead };
      console.log(JSON.stringify({ ...identity, id: `postgres-wal:${lsn.replace("/", "-")}`, digest: `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}` }));
    } else if (command === "migrate" || command === "migrate-locked") {
      const finalMigration = await assertPrismaMigrationsCurrent(client);
      const prisma = runPrismaMigrateStatus(process.env);
      assertPrismaStatusAgreement(finalMigration, prisma.status);
      console.log(JSON.stringify({ event: "database_migration_final_status", backend: "postgres", ...finalMigration, prismaStatusExitCode: prisma.status, prismaStatusOutputDigest: prisma.outputDigest }));
    } else {
      await assertPrismaMigrationsCurrent(client);
      if (command === "deployment-readiness") {
        const readiness = await inspectAsyncDeploymentReadiness(capabilities.queries, { privateProviderOrigin: process.env.FRIDAY_RELAY_PRIVATE_PROVIDER_ORIGIN });
        console.log(JSON.stringify({ event: "deployment_readiness", ...readiness }));
        if (cliFlag("--assert-private-origin") && ["missing", "mismatch"].includes(readiness.privateProviderOrigin.status)) process.exitCode = 1;
      } else if (command === "capture-month-archive") {
        await runRequestCaptureMonthlyArchiveCli(client, capabilities.queries, config);
      } else if (command === "request-history-archive") {
        await runRequestHistoryArchiveCli(client, config);
      } else if (command === "archive") {
        await runUnifiedArchiveCli(capabilities.queries, client, config);
      } else if (command === "seller-settlement-release") {
        const ownerId = cliOption("--owner-id");
        const batchSize = cliOption("--batch-size");
        const maxBatches = cliOption("--max-batches");
        const result = await runSellerSettlementReleaseTask({
          taskLeases: new PostgresTaskLeaseStore(client),
          backfillPrepaidSellerSettlements: capabilities.commands.backfillPrepaidSellerSettlements,
          releaseDueSellerSettlements: capabilities.commands.releaseDueSellerSettlements,
        }, {
          ...(ownerId ? { ownerId } : {}),
          ...(batchSize ? { batchSize: requiredCliInteger("--batch-size") } : {}),
          ...(maxBatches ? { maxBatches: requiredCliInteger("--max-batches") } : {}),
        });
        console.log(JSON.stringify({ event: "seller_settlement_release_task", ...result }));
      } else if (command === "bootstrap-owner") {
        const result = await ensurePostgresBootstrapOwner(client, config);
        console.log(JSON.stringify({ bootstrapOwner: result }));
      } else {
        if (!cliFlag("--execute") || !cliFlag("--offline-confirmed")) {
          throw cliError("platform_owner_handover_confirmation_required", "Owner handover requires --execute and --offline-confirmed");
        }
        const currentOwnerUserId = requiredCliOption("--current-owner-user-id");
        const nextOwnerUserId = requiredCliOption("--next-owner-user-id");
        const result = await handoverPostgresOwner(client, currentOwnerUserId, nextOwnerUserId);
        console.log(JSON.stringify({ ownerHandover: { currentOwnerUserId, nextOwnerUserId, grantId: result.nextGrant.id } }));
      }
    }
    } finally {
      await client.close();
    }
  }
}
}

async function runInstanceDataCli(action: "instance-data-export" | "instance-data-inspect" | "instance-data-restore"): Promise<void> {
  if (action === "instance-data-export") {
    const sourceInstance = requiredCliOption("--source-instance");
    const secretPath = process.env.FRIDAY_RELAY_INSTANCE_DATA_SOURCE_PG_CONNECTION_STRING_FILE;
    if (!secretPath || secretPath !== resolve(secretPath)) {
      throw cliError("instance_data_reader_secret_path_invalid", "Instance-data reader secret path is invalid");
    }
    const secretState = lstatSync(secretPath);
    if (!secretState.isFile() || secretState.isSymbolicLink() || realpathSync(secretPath) !== secretPath || (secretState.mode & 0o007) !== 0) {
      throw cliError("instance_data_reader_secret_file_invalid", "Instance-data reader secret must be a canonical private regular file");
    }
    const connectionString = readFileSync(secretPath, "utf8").trim();
    const tempRoot = mkdtempSync(join(tmpdir(), "friday-relay-instance-data-cli-"));
    const artifactPath = join(tempRoot, "instance-data.frid");
    try {
      await exportInstanceDataArtifact({ connectionString, sourceInstance, outputPath: artifactPath });
      await pipeline(createReadStream(artifactPath), process.stdout);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    return;
  }
  const artifactPath = requiredCliOption("--artifact");
  if (action === "instance-data-inspect") {
    const inspected = inspectInstanceDataArtifact(artifactPath, { verifyPayloads: true, requireUnexpired: true });
    console.log(JSON.stringify({
      schema: "friday-relay.instance-data-inspection.v1",
      status: "valid",
      artifactSha256: inspected.artifactSha256,
      artifactSize: inspected.artifactSize,
      profile: inspected.manifest.profile,
      source: inspected.manifest.source,
      snapshot: inspected.manifest.snapshot,
      sourceSchema: inspected.manifest.sourceSchema,
      migrationLedger: inspected.manifest.migrationLedger,
      tables: inspected.manifest.tables.map(({ name, rowCount, contentSha256, transformedColumns }) => ({ name, rowCount, contentSha256, transformedColumns })),
      closure: inspected.manifest.closure,
      createdAt: inspected.manifest.createdAt,
      expiresAt: inspected.manifest.expiresAt,
    }));
    return;
  }
  const connectionString = resolvePostgresConnectionStringFromEnvironment(process.env);
  console.log(JSON.stringify(await restoreInstanceDataArtifact({ connectionString, artifactPath })));
}

function assertPrismaStatusAgreement(migration: PrismaMigrationState, exitCode: number): void {
  if ((exitCode === 0) !== (migration.status === "current")) {
    throw cliError("prisma_migrate_status_disagrees_with_history", `Prisma status disagrees with history projection: status=${migration.status} exit=${exitCode}`);
  }
}

async function runRequestCaptureMonthlyArchiveCli(
  client: ReturnType<typeof createPostgresClientFromEnvironment>,
  queries: DbOpsVerificationQueries,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  assertSharedCaptureStorageForConfig(config);
  const action = process.argv[3];
  try {
    if (action === "catch-up" || action === "plan" || action === "run") {
      const output = await runRequestCaptureMonthlyArchiveTask(client, queries, config, action);
      console.log(JSON.stringify(output));
      if (action === "catch-up" && (output as { archives?: Array<{ status?: string }> }).archives?.some((archive) => archive.status === "blocked")) {
        process.exitCode = 1;
      }
      return;
    }
    const month = requiredCliOption("--month");
    if (action === "purge-plan") {
      console.log(JSON.stringify(await purgeVerifiedRequestCaptureMonth({ config, source: queries, month, execute: false })));
      return;
    }
    if (action === "purge-verified") {
      if (!cliFlag("--execute")) {
        throw cliError("request_capture_archive_purge_execute_required", "purge-verified requires --execute");
      }
      console.log(JSON.stringify(await purgeVerifiedRequestCaptureMonth({ config, source: queries, month, execute: true })));
      return;
    }
    if (action === "finalize") {
      if (!cliFlag("--execute")) {
        throw cliError("request_capture_archive_finalize_execute_required", "finalize requires --execute");
      }
      console.log(JSON.stringify(await finalizeRequestCaptureMonthlyArchive({ config, source: queries, month })));
      return;
    }
    throw cliError(
      "request_capture_archive_command_invalid",
      "capture-month-archive requires plan, run, catch-up, finalize, purge-plan, purge-verified, verify, query, read, or copy",
    );
  } catch (error) {
    console.error(`requestCaptureArchive.failureCode=${errorCodeFromUnknown(error)}`);
    process.exitCode = 1;
  }
}

async function runRequestHistoryArchiveCli(
  client: ReturnType<typeof createPostgresClientFromEnvironment>,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  const action = process.argv[3] ?? "catch-up";
  try {
    if (action === "catch-up") {
      console.log(JSON.stringify({ archives: await runRequestHistoryArchiveCatchUp({ config, client }) }));
      return;
    }
    if (action === "plan" || action === "run") {
      const month = cliOption("--month");
      console.log(JSON.stringify(await runRequestHistoryArchive({ config, client, ...(month ? { month } : {}), dryRun: action === "plan" || cliFlag("--dry-run") })));
      return;
    }
    if (action === "verify") {
      const month = requiredCliOption("--month");
      console.log(JSON.stringify(await verifyRequestHistoryArchive({ config, client, month })));
      return;
    }
    if (action === "finalize") {
      const month = requiredCliOption("--month");
      const manifest = await verifyRequestHistoryArchive({ config, client, month });
      // Database history tables are append-only by baseline. The unified
      // control plane records the verified closure; physical source deletion
      // remains a separately governed migration and is never implicit here.
      console.log(JSON.stringify({ archiveMonth: month, status: "verified", purge: "not-run", reason: "append_only_source_retention" , artifactCount: manifest.artifacts.length }));
      return;
    }
    throw cliError("request_history_archive_command_invalid", "request-history-archive requires plan, run, catch-up, verify, or finalize");
  } catch (error) {
    console.error(`requestHistoryArchive.failureCode=${errorCodeFromUnknown(error)}`);
    process.exitCode = 1;
  }
}

async function runUnifiedArchiveCli(
  queries: DbOpsVerificationQueries,
  client: ReturnType<typeof createPostgresClientFromEnvironment>,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  const pipeline = process.argv[3] ?? "all";
  const action = process.argv[4] ?? "catch-up";
  if (!["all", "capture", "history"].includes(pipeline)) throw cliError("archive_pipeline_invalid", "archive pipeline must be all, capture, or history");
  const result: Record<string, unknown> = { pipeline, action };
  if (pipeline === "capture" || pipeline === "all") {
    // The Capture CLI accepts the action as argv[3]; invoke the underlying
    // named implementation directly through a temporary argv-free adapter.
    result.capture = await runRequestCaptureMonthlyArchiveTask(client, queries, config, action);
  }
  if (pipeline === "history" || pipeline === "all") {
    const month = cliOption("--month");
    if (action === "catch-up") result.history = await runRequestHistoryArchiveCatchUp({ config, client });
    else if (action === "verify" || action === "finalize") {
      if (!month) throw cliError("request_history_archive_month_required", `${action} requires --month`);
      result.history = await verifyRequestHistoryArchive({ config, client, month });
    } else result.history = await runRequestHistoryArchive({ config, client, ...(month ? { month } : {}), dryRun: action === "plan" || cliFlag("--dry-run") });
  }
  console.log(JSON.stringify(result));
}

async function runRequestCaptureMonthlyArchiveTask(
  client: ReturnType<typeof createPostgresClientFromEnvironment>,
  queries: DbOpsVerificationQueries,
  config: Awaited<ReturnType<typeof loadConfig>>,
  action: string,
): Promise<unknown> {
  if (!["plan", "run", "catch-up", "verify", "finalize"].includes(action)) throw cliError("archive_action_invalid", "archive action must be plan, run, catch-up, verify, or finalize");
  assertSharedCaptureStorageForConfig(config);
  if (action === "catch-up") {
    const progress = createCaptureArchiveProgressReporter();
    progress.emitControl("catch_up_started");
    const reconciliation = new Map<string, Awaited<ReturnType<typeof reconcileStaleStartedRequestLogs>>>();
    const archives = await runRequestCaptureMonthlyArchiveCatchUp({
      config,
      source: queries,
      onProgress: progress.report,
      beforeArchiveMonth: async (month) => {
        reconciliation.set(month, await reconcileStaleStartedRequestLogs({ client, config, month }));
      },
    });
    const purges = config.requestCapture.archive.autoPurge
      ? await Promise.all(archives.filter((archive) => archive.status === "archived").map((archive) => finalizeRequestCaptureMonthlyArchive({ config, source: queries, month: archive.archiveMonth })))
      : [];
    const reportedArchives = archives.map((archive) => ({
      ...archive,
      ...(reconciliation.has(archive.archiveMonth) ? { reconciliation: reconciliation.get(archive.archiveMonth) } : {}),
    }));
    progress.emitControl("catch_up_completed");
    return { archives: reportedArchives, purges };
  }
  const month = cliOption("--month");
  if (action === "verify") {
    if (!month) throw cliError("request_capture_archive_month_required", "verify requires --month");
    return verifyConfiguredRequestCaptureMonthlyArchive({ config, month });
  }
  if (action === "finalize") {
    if (!month || !cliFlag("--execute")) throw cliError("request_capture_archive_finalize_execute_required", "finalize requires --month and --execute");
    return finalizeRequestCaptureMonthlyArchive({ config, source: queries, month });
  }
  const reconciliation = action === "run" && !cliFlag("--dry-run")
    ? await reconcileStaleStartedRequestLogs({
      client,
      config,
      month: planRequestCaptureArchiveMonth(month, new Date()).archiveMonth,
    })
    : undefined;
  const progress = createCaptureArchiveProgressReporter();
  const output = await runRequestCaptureMonthlyArchive({
    config,
    source: queries,
    ...(month ? { month } : {}),
    dryRun: action === "plan" || cliFlag("--dry-run"),
    localOnly: cliFlag("--local-only"),
    onProgress: progress.report,
  });
  return { ...output, ...(reconciliation ? { reconciliation } : {}) };
}

function createCaptureArchiveProgressReporter() {
  const operationId = `capture-archive-${randomUUID()}`;
  const startedAtMs = Date.now();
  const emit = (
    phase: string,
    archiveMonth: string | null,
    values: Partial<Omit<RequestCaptureMonthlyArchiveProgress, "archiveMonth" | "phase" | "elapsedMs">> = {},
  ): void => {
    const payload = {
      schema: "friday-relay.capture-archive-progress.v1",
      event: "progress",
      operationId,
      emittedAt: new Date().toISOString(),
      elapsedMs: Math.max(0, Date.now() - startedAtMs),
      phase,
      archiveMonth,
      recordsProcessed: values.recordsProcessed ?? 0,
      recordsTotal: values.recordsTotal ?? 0,
      sourceCompressedBytesProcessed: values.sourceCompressedBytesProcessed ?? 0,
      sourceCompressedBytesTotal: values.sourceCompressedBytesTotal ?? 0,
      framesCompleted: values.framesCompleted ?? 0,
      compressedBytes: values.compressedBytes ?? 0,
      ...(values.failureCode ? { failureCode: values.failureCode } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload)}\\n`);
  };
  return {
    report: (progress: RequestCaptureMonthlyArchiveProgress): void => {
      emit(progress.phase, progress.archiveMonth, progress);
    },
    emitControl: (phase: "catch_up_started" | "catch_up_completed" | "run_started", archiveMonth: string | null = null): void => {
      emit(phase, archiveMonth);
    },
  };
}

function cliFlag(name: string): boolean {
  return process.argv.includes(name);
}

function cliOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw cliError("cli_option_value_required", `${name} requires a value`);
  return value;
}

function requiredCliOption(name: string): string {
  const value = cliOption(name);
  if (!value) throw cliError("cli_option_value_required", `${name} requires a value`);
  return value;
}

function requiredCliInteger(name: string): number {
  const value = requiredCliOption(name);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw cliError("cli_option_value_invalid", `${name} requires a positive integer`);
  return Number(value);
}

async function handoverPostgresOwner(
  client: ReturnType<typeof createPostgresClientFromEnvironment>,
  currentOwnerUserId: string,
  nextOwnerUserId: string,
) {
  return client.withPrismaTransaction(async (transaction) => {
    const identity = new IdentityQueries(client, transaction);
    const authority = new AuthorityCommands(client, transaction);
    for (const userId of [currentOwnerUserId, nextOwnerUserId].sort()) {
      await transaction.$queryRaw`SELECT "id" FROM "user_controls" WHERE "id" = ${userId} FOR UPDATE`;
    }
    const [current, next] = await Promise.all([
      identity.decideUserAccess(currentOwnerUserId),
      identity.decideUserAccess(nextOwnerUserId),
    ]);
    if (!current?.enabled || !next?.enabled) throw new RelayError("platform_owner_handover_target_invalid", "Next Platform Owner must be an enabled user", 409);
    return authority.handoverBootstrapOwner({ currentOwnerUserId, nextOwnerUserId, actorUserId: currentOwnerUserId });
  }, 1, { isolationLevel: "Serializable" });
}

async function ensurePostgresBootstrapOwner(
  client: ReturnType<typeof createPostgresClientFromEnvironment>,
  config: Awaited<ReturnType<typeof loadConfig>>,
) {
  const canonicalEmail = EmailAddr.parse(config.bootstrap.ownerEmail);
  const identityQueries = new IdentityQueries(client);
  const existingOwnerId = await new AuthorityQueries(client).activeBootstrapPlatformOwnerUserId();
  const existingOwner = existingOwnerId ? await identityQueries.getUser(existingOwnerId) : undefined;
  const credentialFilePath = "/app/data/bootstrap-owner-credentials.txt";
  let credentialsPath: string | null = null;
  let temporaryPasswordHash: string | null = null;
  if (!existingOwner) {
    const existingAccount = await new IdentityQueries(client).findUserByEmail(canonicalEmail);
    if (existingAccount) throw cliError("bootstrap_owner_account_conflict", "Bootstrap owner email already belongs to a user without an active Platform Owner grant");
    const temporaryPassword = randomBytes(24).toString("base64url");
    temporaryPasswordHash = await createPasswordHash(temporaryPassword);
    credentialsPath = credentialFilePath;
    await writeFile(credentialsPath, [
      "Frely bootstrap owner credentials",
      `email: ${canonicalEmail.value}`,
      `temporaryPassword: ${temporaryPassword}`,
      `createdAt: ${new Date().toISOString()}`,
      "deleteAfterLogin: true",
      "",
    ].join("\n"), { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  try {
    return await client.withPrismaTransaction(async (transaction) => {
      const audit = new PrismaAuditEventAppender();
      const identityQueries = new IdentityQueries(client, transaction);
      const identity = new IdentityCommands(client, transaction, audit);
      const authorityQueries = new AuthorityQueries(client, transaction);
      const authority = new AuthorityCommands(client, transaction, audit);
      const tenancyQueries = new TenancyQueries(client, transaction);
      const tenancy = new TenancyCommands(client, transaction);
      const ownerId = await authorityQueries.activeBootstrapPlatformOwnerUserId();
      let owner = ownerId ? await identityQueries.getUser(ownerId) : undefined;
      if (owner && credentialsPath) throw cliError("bootstrap_owner_state_changed", "Bootstrap owner state changed after credential preparation");
      if (!owner && temporaryPasswordHash === null) throw cliError("bootstrap_owner_state_changed", "Bootstrap owner state changed before the transaction began");
      let bootstrapTeamCreated = false;
      let bootstrapTeamChanged = false;
      if (!owner) {
        const existingAccount = await identityQueries.findUserByEmail(canonicalEmail);
        if (existingAccount) throw cliError("bootstrap_owner_account_conflict", "Bootstrap owner email already belongs to a user without an active Platform Owner grant");
        const initialTeam = await tenancy.ensureBootstrapTeam({ id: "team_default", ownerUserId: "user_owner", name: "Default Team" });
        bootstrapTeamCreated = initialTeam.created;
        bootstrapTeamChanged = initialTeam.changed;
        owner = await identity.createUser({
          id: "user_owner",
          teamId: initialTeam.team.id,
          email: canonicalEmail,
          passwordHash: temporaryPasswordHash!,
          status: "enabled",
        });
        await identity.appendAudit({
          actor: { actorType: "system", actorId: "bootstrap-owner" },
          action: "user.create",
          resource: { resourceType: "user", resourceId: owner.id },
          result: "success",
          source: "system",
          metadata: { teamId: initialTeam.team.id, status: owner.status },
        });
      }
      const finalTeam = await tenancy.ensureBootstrapTeam({ id: "team_default", ownerUserId: owner.id, name: "Default Team" });
      bootstrapTeamCreated ||= finalTeam.created;
      bootstrapTeamChanged ||= finalTeam.changed;
      const existingMembership = await tenancyQueries.getMembership(finalTeam.team.id, owner.id);
      const membership = await tenancy.grantMembership(finalTeam.team.id, owner.id);
      const grantResult = await authority.ensureBootstrapOwner(owner.id, { actorType: "system", actorId: "bootstrap-owner" });
      if (bootstrapTeamChanged) {
        await audit.append(transaction, {
          actor: { actorType: "system", actorId: "bootstrap-owner" },
          action: bootstrapTeamCreated ? "team.create" : "team.update",
          resourceType: "team",
          resourceId: finalTeam.team.id,
          result: "success",
          source: "system",
          requestId: null,
          metadata: bootstrapTeamCreated
            ? { name: finalTeam.team.name, ownerId: finalTeam.team.ownerId, status: finalTeam.team.status }
            : { teamId: finalTeam.team.id, name: finalTeam.team.name, status: finalTeam.team.status },
        });
      }
      if (!existingMembership) {
        await audit.append(transaction, {
          actor: { actorType: "system", actorId: "bootstrap-owner" },
          action: "team_member.add",
          resourceType: "team_membership",
          resourceId: membership.id,
          result: "success",
          source: "system",
          requestId: null,
          metadata: { teamId: finalTeam.team.id, userId: owner.id },
        });
      }
      return {
        ownerId: owner.id,
        ownerEmail: owner.email,
        teamId: finalTeam.team.id,
        grantId: grantResult.grant.id,
        credentialFilePath,
        credentialsPath,
        credentialFileCreated: credentialsPath !== null,
        ownerCreated: credentialsPath !== null,
        created: credentialsPath !== null,
      };
    }, 3, { isolationLevel: "Serializable" });
  } catch (error) {
    if (credentialsPath) await unlink(credentialsPath).catch(() => undefined);
    throw error;
  }
}

async function assertAccessPointScopeIdempotencyMigrationPreflight(
  context: Parameters<typeof inspectAccessPointScopeIdempotencyMigration>[0],
): Promise<Awaited<ReturnType<typeof inspectAccessPointScopeIdempotencyMigration>>> {
  const result = await inspectAccessPointScopeIdempotencyMigration(context);
  if (!result.allowed) {
    throw cliError(
      "postgres_access_point_idempotency_migration_preflight_failed",
      `AccessPoint scope-idempotency migration preflight refused: reason=${result.reason}`,
    );
  }
  return result;
}

function cliError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function errorCodeFromUnknown(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "request_capture_archive_failed";
}
