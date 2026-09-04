import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { Pool } from "pg";

export const verificationPostgresAdminUrlEnvironment = "FRIDAY_RELAY_VERIFY_POSTGRES_ADMIN_URL";
export const verificationPostgresDisposableUrlEnvironment = "FRIDAY_RELAY_VERIFY_POSTGRES_DISPOSABLE_URL";
export const verificationPostgresNoDockerEnvironment = "FRIDAY_RELAY_VERIFY_NO_DOCKER";

const maximumCommandOutputBytes = 32 * 1024 * 1024;
const localPostgresHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const unsafeDatabaseName = /(?:^|_)(?:llm|prod|production|shared|stg|staging)(?:_|$)/iu;
const disposableDatabaseName = /^friday_relay_verify_[a-z0-9_]+$/u;

type Spawn = typeof spawnSync;

interface AdminClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface PostgresVerificationRuntimeOptions {
  readonly verifier: string;
  readonly databases: readonly string[];
  readonly docker: {
    readonly image: string;
    readonly user: string;
    readonly password: string;
    readonly containerPrefix: string;
  };
  readonly allowSuppliedDisposableDatabase?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface PostgresVerificationRuntimeDependencies {
  readonly spawn?: Spawn;
  readonly adminClientFactory?: (connectionString: string) => AdminClient;
  readonly runId?: string;
}

export class PostgresVerificationRuntime {
  readonly mode: "docker" | "external-admin" | "external-disposable";
  private readonly urls = new Map<string, string>();
  private readonly ownedDatabases: string[] = [];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawn: Spawn;
  private readonly adminClientFactory: (connectionString: string) => AdminClient;
  private readonly containerName: string;
  private adminUrl: string | undefined;
  private started = false;

  private constructor(
    private readonly options: PostgresVerificationRuntimeOptions,
    dependencies: PostgresVerificationRuntimeDependencies,
  ) {
    this.environment = options.environment ?? process.env;
    this.spawn = dependencies.spawn ?? spawnSync;
    this.adminClientFactory = dependencies.adminClientFactory ?? ((connectionString) => new Pool({
      connectionString,
      max: 1,
      application_name: `friday-relay-${options.verifier}-verification-admin`,
    }));
    const runId = normalizeIdentifierPart(dependencies.runId ?? randomUUID().replaceAll("-", "").slice(0, 12));
    this.containerName = `${options.docker.containerPrefix}-${runId}`;
    this.mode = selectMode(this.environment, options.allowSuppliedDisposableDatabase === true);
  }

  static async start(
    options: PostgresVerificationRuntimeOptions,
    dependencies: PostgresVerificationRuntimeDependencies = {},
  ): Promise<PostgresVerificationRuntime> {
    assertLogicalDatabases(options.databases);
    const runtime = new PostgresVerificationRuntime(options, dependencies);
    try {
      await runtime.initialize(dependencies.runId);
      return runtime;
    } catch (error) {
      await runtime.cleanup().catch(() => undefined);
      throw error;
    }
  }

  connectionString(database: string): string {
    const value = this.urls.get(database);
    if (!value) throw new Error(`postgres_verification_database_unknown:${database}`);
    return value;
  }

  executeSql(database: string, sql: string): void {
    const result = this.psqlResult(database, ["-v", "ON_ERROR_STOP=1"], sql);
    this.assertCommandSucceeded("psql", result);
  }

  queryScalar(database: string, sql: string): string {
    const result = this.psqlResult(database, ["-At", "-v", "ON_ERROR_STOP=1", "-c", sql]);
    this.assertCommandSucceeded("psql", result);
    return result.stdout.trim();
  }

  psqlResult(database: string, args: readonly string[], input?: string): SpawnSyncReturns<string> {
    const url = this.connectionString(database);
    if (this.mode === "docker") {
      return this.spawn("docker", [
        "exec", ...(input === undefined ? [] : ["-i"]), this.containerName, "psql",
        "-U", this.options.docker.user, "-d", database, ...args,
      ], this.spawnOptions(input));
    }
    return this.spawn("psql", [...args], this.spawnOptions(input, postgresCliEnvironment(url, this.environment)));
  }

  schemaDump(database: string): string {
    const url = this.connectionString(database);
    const args = [
      "--schema-only", "--no-owner", "--no-privileges", "--schema=public",
      "--exclude-table=_prisma_migrations",
    ];
    const result = this.mode === "docker"
      ? this.spawn("docker", ["exec", this.containerName, "pg_dump", "-U", this.options.docker.user, ...args, database], this.spawnOptions())
      : this.spawn("pg_dump", args, this.spawnOptions(undefined, postgresCliEnvironment(url, this.environment)));
    this.assertCommandSucceeded("pg_dump", result);
    return result.stdout;
  }

  async cleanup(): Promise<void> {
    if (!this.started) return;
    if (this.mode === "docker") {
      const result = this.spawn(
        "docker",
        ["rm", "--force", "--volumes", this.containerName],
        this.spawnOptions(),
      );
      const detail = `${result.stdout}\n${result.stderr}`;
      if (result.error) throw new Error("postgres_verification_container_cleanup_failed");
      if (result.status !== 0 && !detail.includes("No such container")) {
        throw new Error(`postgres_verification_container_cleanup_failed:${result.status ?? "signal"}`);
      }
      this.started = false;
      return;
    }
    if (!this.adminUrl || this.ownedDatabases.length === 0) {
      this.started = false;
      return;
    }
    const admin = this.adminClientFactory(this.adminUrl);
    try {
      await admin.connect();
      for (const database of [...this.ownedDatabases].reverse()) {
        await admin.query(`DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`);
        const index = this.ownedDatabases.lastIndexOf(database);
        if (index >= 0) this.ownedDatabases.splice(index, 1);
      }
      this.started = false;
    } catch {
      throw new Error("postgres_verification_database_cleanup_failed");
    } finally {
      await admin.end().catch(() => undefined);
    }
  }

  redact(value: string): string {
    return redactPostgresVerificationSecrets(value, [this.adminUrl, ...this.urls.values()]);
  }

  private async initialize(requestedRunId: string | undefined): Promise<void> {
    if (this.mode === "docker") {
      await this.initializeDocker();
      return;
    }
    if (this.mode === "external-disposable") {
      if (this.options.databases.length !== 1) throw new Error("postgres_verification_disposable_url_requires_single_database");
      const supplied = requireSafePostgresUrl(
        this.environment[verificationPostgresDisposableUrlEnvironment],
        "disposable",
      );
      const database = databaseFromUrl(supplied);
      if (!disposableDatabaseName.test(database)) throw new Error("postgres_verification_disposable_database_name_invalid");
      this.urls.set(this.options.databases[0]!, supplied.toString());
      await this.assertReachable(supplied.toString());
      this.started = true;
      return;
    }

    const admin = requireSafePostgresUrl(this.environment[verificationPostgresAdminUrlEnvironment], "admin");
    const adminDatabase = databaseFromUrl(admin);
    if (adminDatabase !== "postgres" && !/^friday_relay_verify_admin(?:_[a-z0-9_]+)?$/u.test(adminDatabase)) {
      throw new Error("postgres_verification_admin_database_name_invalid");
    }
    this.adminUrl = admin.toString();
    const runId = normalizeIdentifierPart(requestedRunId ?? randomUUID().replaceAll("-", "").slice(0, 12));
    const verifier = normalizeIdentifierPart(this.options.verifier);
    const client = this.adminClientFactory(this.adminUrl);
    try {
      await client.connect();
      for (const [index, logicalDatabase] of this.options.databases.entries()) {
        const database = boundedDatabaseName(`friday_relay_verify_${verifier}_${runId}_${index}_${normalizeIdentifierPart(logicalDatabase)}`);
        await client.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
        this.ownedDatabases.push(database);
        this.urls.set(logicalDatabase, urlWithDatabase(admin, database));
      }
      this.started = true;
    } catch {
      await this.cleanupOwnedAfterInitializationFailure(client);
      throw new Error("postgres_verification_database_create_failed");
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async initializeDocker(): Promise<void> {
    const firstDatabase = this.options.databases[0]!;
    const result = this.spawn("docker", [
      "run", "--detach", "--rm", "--name", this.containerName,
      "-e", `POSTGRES_USER=${this.options.docker.user}`,
      "-e", `POSTGRES_PASSWORD=${this.options.docker.password}`,
      "-e", `POSTGRES_DB=${firstDatabase}`,
      "-p", "127.0.0.1::5432", this.options.docker.image,
    ], this.spawnOptions());
    this.assertCommandSucceeded("docker", result);
    this.started = true;
    await this.waitForDockerPostgres(firstDatabase);
    const portResult = this.spawn("docker", ["port", this.containerName, "5432/tcp"], this.spawnOptions());
    this.assertCommandSucceeded("docker", portResult);
    const port = portResult.stdout.trim().split(":").at(-1) ?? "";
    if (!/^\d+$/u.test(port)) throw new Error("postgres_verification_postgres_port_invalid");
    for (const database of this.options.databases) {
      this.urls.set(database, `postgresql://${encodeURIComponent(this.options.docker.user)}:${encodeURIComponent(this.options.docker.password)}@127.0.0.1:${port}/${database}`);
    }
    for (const database of this.options.databases.slice(1)) {
      const createResult = this.spawn("docker", ["exec", this.containerName, "createdb", "-U", this.options.docker.user, database], this.spawnOptions());
      this.assertCommandSucceeded("createdb", createResult);
    }
  }

  private async waitForDockerPostgres(database: string): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = this.spawn("docker", [
        "exec", this.containerName, "psql", "-At", "-U", this.options.docker.user, "-d", database, "-c", "SELECT 1",
      ], this.spawnOptions());
      if (result.status === 0 && result.stdout.trim() === "1") return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("postgres_verification_postgres_not_ready");
  }

  private async assertReachable(connectionString: string): Promise<void> {
    const client = this.adminClientFactory(connectionString);
    try {
      await client.connect();
      await client.query("SELECT 1");
    } catch {
      throw new Error("postgres_verification_disposable_database_unreachable");
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async cleanupOwnedAfterInitializationFailure(client: AdminClient): Promise<void> {
    for (const database of [...this.ownedDatabases].reverse()) {
      await client.query(`DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`).catch(() => undefined);
    }
    this.ownedDatabases.length = 0;
  }

  private spawnOptions(input?: string, env: NodeJS.ProcessEnv = this.environment) {
    return { encoding: "utf8" as const, env, input, maxBuffer: maximumCommandOutputBytes };
  }

  private assertCommandSucceeded(command: string, result: SpawnSyncReturns<string>): void {
    if (result.error || result.status !== 0) {
      const detail = this.redact([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
      throw new Error(`postgres_verification_${command}_failed:${result.status ?? "signal"}${detail ? `\n${detail}` : ""}`);
    }
  }
}

export function redactPostgresVerificationSecrets(value: string, urls: readonly (string | undefined)[] = []): string {
  let redacted = value;
  for (const rawUrl of urls) {
    if (!rawUrl) continue;
    redacted = redacted.replaceAll(rawUrl, "[REDACTED_POSTGRES_URL]");
    try {
      const parsed = new URL(rawUrl);
      const password = decodeURIComponent(parsed.password);
      if (password) redacted = redacted.replaceAll(password, "[REDACTED]");
    } catch {
      // Invalid URLs are rejected by the caller; redaction remains best-effort here.
    }
  }
  return redacted.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/giu, "[REDACTED_POSTGRES_URL]");
}

function selectMode(environment: NodeJS.ProcessEnv, allowDisposable: boolean): PostgresVerificationRuntime["mode"] {
  const admin = environment[verificationPostgresAdminUrlEnvironment]?.trim();
  const disposable = environment[verificationPostgresDisposableUrlEnvironment]?.trim();
  if (admin && disposable) throw new Error("postgres_verification_url_source_ambiguous");
  if (disposable && !allowDisposable) throw new Error("postgres_verification_disposable_url_not_supported");
  if (admin) return "external-admin";
  if (disposable) return "external-disposable";
  if (environment[verificationPostgresNoDockerEnvironment] === "1") {
    throw new Error("postgres_verification_external_url_required");
  }
  return "docker";
}

function requireSafePostgresUrl(value: string | undefined, kind: "admin" | "disposable"): URL {
  if (!value?.trim()) throw new Error(`postgres_verification_${kind}_url_required`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`postgres_verification_${kind}_url_invalid`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(`postgres_verification_${kind}_url_protocol_invalid`);
  }
  if (!localPostgresHosts.has(parsed.hostname)) throw new Error("postgres_verification_remote_host_rejected");
  if (!parsed.username || !databaseFromUrl(parsed)) throw new Error(`postgres_verification_${kind}_url_incomplete`);
  const database = databaseFromUrl(parsed);
  if (kind === "disposable" && unsafeDatabaseName.test(database)) {
    throw new Error("postgres_verification_shared_database_rejected");
  }
  return parsed;
}

function postgresCliEnvironment(connectionString: string, baseEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const parsed = new URL(connectionString);
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    PGHOST: parsed.hostname.replace(/^\[|\]$/gu, ""),
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: databaseFromUrl(parsed),
  };
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) environment.PGSSLMODE = sslMode;
  return environment;
}

function databaseFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//u, ""));
}

function urlWithDatabase(admin: URL, database: string): string {
  const result = new URL(admin);
  result.pathname = `/${database}`;
  return result.toString();
}

function normalizeIdentifierPart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (!normalized) throw new Error("postgres_verification_identifier_invalid");
  return normalized;
}

function boundedDatabaseName(value: string): string {
  return value.length <= 63 ? value : value.slice(0, 63).replace(/_+$/u, "");
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error("postgres_verification_database_identifier_invalid");
  return `"${value}"`;
}

function assertLogicalDatabases(databases: readonly string[]): void {
  if (databases.length === 0 || new Set(databases).size !== databases.length) {
    throw new Error("postgres_verification_database_set_invalid");
  }
  for (const database of databases) quoteIdentifier(database);
}
