import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { PostgresVerificationRuntime } from "./postgres-verification-runtime.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const postgresPackageRoot = join(packageRoot, "..", "postgres");
const prismaConfigPath = join(postgresPackageRoot, "prisma.config.ts");
const prismaBinPath = join(postgresPackageRoot, "node_modules", ".bin", "prisma");
const baselineMigrationName = "20260813000000_postgresql_baseline";
const moneyMigrationName = "20260813002000_usd_units_expand";
const migrationsRoot = join(postgresPackageRoot, "prisma", "migrations");
const postgresImage = process.env.FRIDAY_RELAY_PRISMA_BASELINE_POSTGRES_IMAGE ?? "postgres:16-alpine";
const postgresUser = "friday_baseline";
const postgresPassword = "friday_baseline_local_only";
const sourceDatabase = "friday_baseline_source";
const replayDatabase = "friday_baseline_replay";
const maximumCommandOutputBytes = 32 * 1024 * 1024;

async function main(): Promise<void> {
  const migrationNames = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migrations = await Promise.all(migrationNames.map(async (name) => ({
    name,
    sql: await readFile(join(migrationsRoot, name, "migration.sql"), "utf8"),
  })));
  if (migrations[0]?.name !== baselineMigrationName) throw new Error("prisma_baseline_migration_missing");

  const runtime = await PostgresVerificationRuntime.start({
    verifier: "prisma_baseline",
    databases: [sourceDatabase, replayDatabase],
    docker: { image: postgresImage, user: postgresUser, password: postgresPassword, containerPrefix: "friday-relay-prisma-baseline" },
  });

  try {
    const beforeMoney = migrations.filter((entry) => entry.name < moneyMigrationName).map((entry) => entry.sql).join("\n");
    const fromMoney = migrations.filter((entry) => entry.name >= moneyMigrationName).map((entry) => entry.sql).join("\n");
    runtime.executeSql(sourceDatabase, beforeMoney);
    runtime.executeSql(sourceDatabase, `
      INSERT INTO "budget_policies" ("id", "metric", "limit_value", "window_type", "window_seconds", "status", "created_at", "updated_at")
      VALUES ('budget_historical_amount', 'amount', 12.345678, 'cumulative', NULL, 'enabled', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z'),
             ('budget_historical_tokens', 'tokens', 42, 'cumulative', NULL, 'enabled', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z');
    `);
    runtime.executeSql(sourceDatabase, fromMoney);
    const historicalUnits = runtime.queryScalar(sourceDatabase, `SELECT "limit_amount_units"::text FROM "budget_policies" WHERE "id"='budget_historical_amount'`);
    if (historicalUnits !== "12345678") throw new Error(`historical_money_units_mismatch:${historicalUnits}`);
    const tokenShape = runtime.queryScalar(sourceDatabase, `SELECT ("limit_amount_units" IS NULL)::text FROM "budget_policies" WHERE "id"='budget_historical_tokens'`);
    if (tokenShape !== "true") throw new Error(`historical_token_budget_units_shape_mismatch:${tokenShape}`);

    const replayUrl = runtime.connectionString(replayDatabase);
    run("bun", [prismaBinPath, "migrate", "deploy", "--config", prismaConfigPath], undefined, {
      ...process.env,
      FRIDAY_RELAY_PG_CONNECTION_STRING: replayUrl,
    }, runtime);
    run("bun", [prismaBinPath, "migrate", "status", "--config", prismaConfigPath], undefined, {
      ...process.env,
      FRIDAY_RELAY_PG_CONNECTION_STRING: replayUrl,
    }, runtime);

    const sourceDump = normalizedSchemaDump(runtime, sourceDatabase);
    const replayDump = normalizedSchemaDump(runtime, replayDatabase);
    if (sourceDump !== replayDump) {
      throw new Error(`prisma_baseline_schema_mismatch:source=${sha256(sourceDump)}:replay=${sha256(replayDump)}`);
    }
    const businessTableCount = Number(runtime.queryScalar(replayDatabase, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'"));
    if (!Number.isSafeInteger(businessTableCount) || businessTableCount < 1) throw new Error("prisma_baseline_business_tables_missing");

    process.stdout.write(`${JSON.stringify({
      baselineMigration: baselineMigrationName,
      migrationHead: migrationNames.at(-1),
      migrations: migrationNames,
      businessTableCount,
      physicalSchemaSha256: sha256(sourceDump),
      historicalMoneyUnitsVerified: true,
    })}\n`);
  } finally {
    await runtime.cleanup();
  }
}

function normalizedSchemaDump(runtime: PostgresVerificationRuntime, database: string): string {
  return runtime.schemaDump(database)
    .split("\n")
    .filter((line) => !line.startsWith("\\restrict ") && !line.startsWith("\\unrestrict "))
    .join("\n");
}

function run(
  command: string,
  args: string[],
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: PostgresVerificationRuntime,
): string {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env,
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

await main();
