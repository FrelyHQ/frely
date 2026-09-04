import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import {
  PostgresVerificationRuntime,
  redactPostgresVerificationSecrets,
  verificationPostgresAdminUrlEnvironment,
  verificationPostgresDisposableUrlEnvironment,
} from "./postgres-verification-runtime.js";

const dockerOptions = {
  image: "postgres:16-alpine",
  user: "verifier",
  password: "local-only",
  containerPrefix: "friday-relay-verifier",
};

function successfulSpawn(stdout = ""): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
}

describe("PostgreSQL verification runtime", () => {
  test("uses an owned external database without spawning Docker and drops only that database", async () => {
    const commands: string[] = [];
    const queries: string[] = [];
    const spawn = vi.fn((command: string) => {
      commands.push(command);
      return successfulSpawn();
    }) as unknown as typeof spawnSync;
    const adminClientFactory = () => ({
      async connect() {},
      async query(sql: string) { queries.push(sql); },
      async end() {},
    });

    const runtime = await PostgresVerificationRuntime.start({
      verifier: "model_access",
      databases: ["friday_model_access"],
      docker: dockerOptions,
      environment: {
        [verificationPostgresAdminUrlEnvironment]: "postgresql://verify:secret-value@127.0.0.1:5432/postgres",
      },
    }, { spawn, adminClientFactory, runId: "fixed_run" });

    runtime.executeSql("friday_model_access", "SELECT 1");
    await runtime.cleanup();

    expect(runtime.mode).toBe("external-admin");
    expect(commands).toEqual(["psql"]);
    expect(commands).not.toContain("docker");
    expect(queries).toEqual([
      'CREATE DATABASE "friday_relay_verify_model_access_fixed_run_0_friday_model_acces"',
      'DROP DATABASE "friday_relay_verify_model_access_fixed_run_0_friday_model_acces" WITH (FORCE)',
    ]);
  });

  test("rejects remote, shared, and ambiguously supplied database URLs before command selection", async () => {
    await expect(PostgresVerificationRuntime.start({
      verifier: "model_access",
      databases: ["friday_model_access"],
      docker: dockerOptions,
      environment: {
        [verificationPostgresAdminUrlEnvironment]: "postgresql://verify:secret@postgres.shared.example/postgres",
      },
    })).rejects.toThrow("postgres_verification_remote_host_rejected");

    await expect(PostgresVerificationRuntime.start({
      verifier: "model_access",
      databases: ["friday_model_access"],
      docker: dockerOptions,
      allowSuppliedDisposableDatabase: true,
      environment: {
        [verificationPostgresDisposableUrlEnvironment]: "postgresql://verify:secret@localhost/friday_relay_production",
      },
    })).rejects.toThrow("postgres_verification_shared_database_rejected");

    await expect(PostgresVerificationRuntime.start({
      verifier: "model_access",
      databases: ["friday_model_access"],
      docker: dockerOptions,
      allowSuppliedDisposableDatabase: true,
      environment: {
        [verificationPostgresAdminUrlEnvironment]: "postgresql://verify:secret@localhost/postgres",
        [verificationPostgresDisposableUrlEnvironment]: "postgresql://verify:secret@localhost/friday_relay_verify_disposable",
      },
    })).rejects.toThrow("postgres_verification_url_source_ambiguous");
  });

  test("does not drop an explicitly supplied disposable application database", async () => {
    const queries: string[] = [];
    const spawn = vi.fn(() => successfulSpawn()) as unknown as typeof spawnSync;
    const runtime = await PostgresVerificationRuntime.start({
      verifier: "provider_invocation",
      databases: ["friday_invocation"],
      docker: dockerOptions,
      allowSuppliedDisposableDatabase: true,
      environment: {
        [verificationPostgresDisposableUrlEnvironment]: "postgresql://verify:secret@localhost/friday_relay_verify_supplied",
      },
    }, {
      spawn,
      adminClientFactory: () => ({
        async connect() {},
        async query(sql: string) { queries.push(sql); },
        async end() {},
      }),
    });

    await runtime.cleanup();

    expect(runtime.mode).toBe("external-disposable");
    expect(queries).toEqual(["SELECT 1"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test("retries Docker cleanup and releases anonymous volumes without losing ownership state", async () => {
    let removalAttempts = 0;
    const removalArgs: Array<readonly string[]> = [];
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      if (command !== "docker") return successfulSpawn();
      if (args[0] === "exec") return successfulSpawn("1\n");
      if (args[0] === "port") return successfulSpawn("127.0.0.1:54321\n");
      if (args[0] === "rm") {
        removalArgs.push(args);
        removalAttempts += 1;
        if (removalAttempts === 1) return { ...successfulSpawn(), status: 1, stderr: "temporary cleanup failure" };
      }
      return successfulSpawn("container-id\n");
    }) as unknown as typeof spawnSync;
    const runtime = await PostgresVerificationRuntime.start({
      verifier: "identity_tenancy",
      databases: ["identity_tenancy_fresh"],
      docker: dockerOptions,
      environment: {},
    }, { spawn, runId: "cleanup_retry" });

    await expect(runtime.cleanup()).rejects.toThrow("postgres_verification_container_cleanup_failed");
    await expect(runtime.cleanup()).resolves.toBeUndefined();
    expect(removalAttempts).toBe(2);
    expect(removalArgs).toEqual([
      ["rm", "--force", "--volumes", "friday-relay-verifier-cleanup_retry"],
      ["rm", "--force", "--volumes", "friday-relay-verifier-cleanup_retry"],
    ]);
  });

  test("redacts complete PostgreSQL URLs and passwords from failures", () => {
    const url = "postgresql://verify:secret-value@127.0.0.1:5432/friday_relay_verify_test";
    const redacted = redactPostgresVerificationSecrets(`failed ${url}; password=secret-value`, [url]);
    expect(redacted).not.toContain(url);
    expect(redacted).not.toContain("secret-value");
    expect(redacted).toContain("[REDACTED_POSTGRES_URL]");
  });
});
