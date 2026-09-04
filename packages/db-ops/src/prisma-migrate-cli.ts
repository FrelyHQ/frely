import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolvePostgresPrismaRuntimeArtifacts } from "@frely/postgres/runtime-artifacts";
import { resolvePostgresConnectionStringFromEnvironment } from "@frely/postgres/server";

export interface PrismaCommandResult {
  status: number;
  outputDigest: string;
}

const {
  packageRoot: postgresPackageRoot,
  prismaCliEntry: prismaEntry,
  prismaConfig,
} = resolvePostgresPrismaRuntimeArtifacts();
const maximumOutputBytes = 16 * 1024 * 1024;

export function runPrismaMigrateStatus(environment: NodeJS.ProcessEnv = process.env): PrismaCommandResult {
  return runPrisma(["migrate", "status", "--config", prismaConfig], environment);
}

export function runPrismaMigrateDeploy(environment: NodeJS.ProcessEnv = process.env): PrismaCommandResult {
  const result = runPrisma(["migrate", "deploy", "--config", prismaConfig], environment);
  if (result.status !== 0) {
    throw new Error(`prisma_migrate_deploy_failed:${result.outputDigest}`);
  }
  return result;
}

export function runPrismaMigrateResolveRolledBack(
  migrationName: string,
  environment: NodeJS.ProcessEnv = process.env,
): PrismaCommandResult {
  if (!/^\d{14}_[a-z0-9_]+$/u.test(migrationName)) throw new Error("prisma_migrate_resolve_name_invalid");
  const result = runPrisma(["migrate", "resolve", "--rolled-back", migrationName, "--config", prismaConfig], environment);
  if (result.status !== 0) {
    throw new Error(`prisma_migrate_resolve_failed:${result.outputDigest}`);
  }
  return result;
}

function runPrisma(args: string[], environment: NodeJS.ProcessEnv): PrismaCommandResult {
  const connectionString = resolvePostgresConnectionStringFromEnvironment(environment);
  const result = spawnSync(process.execPath, [prismaEntry, ...args], {
    cwd: postgresPackageRoot,
    env: { ...environment, FRIDAY_RELAY_PG_CONNECTION_STRING: connectionString },
    encoding: "utf8",
    maxBuffer: maximumOutputBytes,
  });
  if (result.error) throw result.error;
  const status = result.status;
  if (status === null || !Number.isInteger(status)) throw new Error("prisma_migrate_command_interrupted");
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    status,
    outputDigest: `sha256:${createHash("sha256").update(output).digest("hex")}`,
  };
}
