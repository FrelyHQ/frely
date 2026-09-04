import { lstatSync, readFileSync } from "node:fs";
import type { Writable } from "node:stream";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import { from as pgCopyFrom } from "pg-copy-streams";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";

export { Prisma, PrismaClient } from "./generated/prisma/client.js";

export interface PostgresClientOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: PoolConfig["ssl"];
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  applicationName?: string;
  statementTimeoutMillis?: number;
  lockTimeoutMillis?: number;
  idleInTransactionSessionTimeoutMillis?: number;
  transactionTimeoutMillis?: number;
  searchPath?: string;
  /** Optional diagnostic hook used by bounded local verification only. The
   * callback receives SQL text without bound parameter values. */
  queryObserver?: (observation: PostgresQueryObservation) => void;
}

export interface PostgresQueryObservation {
  readonly query: string;
  readonly duration: number;
}

export interface PostgresTransactionContext {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  copyFrom(text: string): Writable;
}

export interface PrismaTransactionOwner {
  withPrismaTransaction<T>(
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
    maxAttempts?: number,
    options?: PrismaTransactionOptions,
  ): Promise<T>;
}

export interface PrismaTransactionOptions {
  readonly isolationLevel?: PrismaTransactionIsolationLevel;
  readonly statementTimeoutMillis?: number;
}

export type PrismaTransactionIsolationLevel =
  | "ReadUncommitted"
  | "ReadCommitted"
  | "RepeatableRead"
  | "Serializable";

export interface PostgresHealth {
  backend: "postgres";
  ok: true;
}

export class PostgresClientOwner implements PrismaTransactionOwner {
  readonly backend = "postgres" as const;
  private readonly pool: Pool;
  readonly prisma: PrismaClient;
  readonly poolMax: number;
  readonly statementTimeoutMillis: number;
  readonly lockTimeoutMillis: number;
  readonly idleInTransactionSessionTimeoutMillis: number;
  readonly transactionTimeoutMillis: number;

  constructor(options: PostgresClientOptions) {
    const poolMax = options.max ?? 10;
    if (!Number.isSafeInteger(poolMax) || poolMax < 1 || poolMax > 256) throw new Error("postgres_pool_max_invalid");
    this.poolMax = poolMax;
    this.statementTimeoutMillis = boundedTimeout(options.statementTimeoutMillis ?? 30_000, "postgres_statement_timeout_invalid");
    this.lockTimeoutMillis = boundedTimeout(options.lockTimeoutMillis ?? 5_000, "postgres_lock_timeout_invalid");
    this.idleInTransactionSessionTimeoutMillis = boundedTimeout(options.idleInTransactionSessionTimeoutMillis ?? 60_000, "postgres_idle_transaction_timeout_invalid");
    this.transactionTimeoutMillis = boundedTimeout(options.transactionTimeoutMillis ?? 60_000, "postgres_transaction_timeout_invalid");
    const searchPath = normalizeSearchPath(options.searchPath ?? "public");
    const poolConfig: PoolConfig = {
      max: poolMax,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      allowExitOnIdle: false,
      ...(options.connectionString ? { connectionString: options.connectionString } : {}),
      ...(options.host ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.database ? { database: options.database } : {}),
      ...(options.user ? { user: options.user } : {}),
      ...(options.password ? { password: options.password } : {}),
      ...(options.ssl ? { ssl: options.ssl } : {}),
      ...(options.applicationName ? { application_name: options.applicationName } : {}),
      options: `-c search_path=${searchPath}`,
    };
    if (!poolConfig.connectionString && !poolConfig.host) throw new Error("postgres_connection_source_required");
    this.pool = new Pool(poolConfig);
    this.pool.on("connect", (poolClient) => {
      poolClient.setTypeParser(20, parsePostgresInt8);
    });
    const adapter = new PrismaPg(this.pool, { schema: searchPath });
    const prisma = options.queryObserver
      ? new PrismaClient({ adapter, log: [{ emit: "event", level: "query" }] })
      : new PrismaClient({ adapter });
    this.prisma = prisma;
    if (options.queryObserver) {
      (prisma as PrismaClient<"query">).$on("query", (event) => {
        options.queryObserver?.({ query: event.query, duration: event.duration });
      });
    }
  }

  async health(): Promise<PostgresHealth> {
    await this.pool.query("SELECT 1");
    return { backend: "postgres", ok: true };
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values as unknown[] | undefined);
  }

  async withTransaction<T>(callback: (context: PostgresTransactionContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(this.statementTimeoutMillis)]);
      await client.query("SELECT set_config('lock_timeout', $1, true)", [String(this.lockTimeoutMillis)]);
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [String(this.idleInTransactionSessionTimeoutMillis)]);
      const result = await callback({
        query: <T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) => client.query<T>(text, values as unknown[] | undefined),
        copyFrom: (text: string) => client.query(pgCopyFrom(text)) as unknown as Writable,
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error; connection cleanup remains mandatory.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async withReadOnlyTransaction<T>(callback: (context: PostgresTransactionContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(this.statementTimeoutMillis)]);
      await client.query("SELECT set_config('lock_timeout', $1, true)", [String(this.lockTimeoutMillis)]);
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [String(this.idleInTransactionSessionTimeoutMillis)]);
      const result = await callback({
        query: <T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) => client.query<T>(text, values as unknown[] | undefined),
        copyFrom: () => { throw new Error("postgres_read_only_copy_forbidden"); },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error; connection cleanup remains mandatory.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Retries only database serialization/deadlock failures. The callback must
   * contain database work only; provider, Stripe, CPA and other external side
   * effects belong outside this helper. */
  async withRetriedTransaction<T>(callback: (context: PostgresTransactionContext) => Promise<T>, maxAttempts = 3): Promise<T> {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error("postgres_transaction_retry_limit_invalid");
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.withTransaction(callback);
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryablePostgresTransactionError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, 25 * 2 ** (attempt - 1))));
      }
    }
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
    await this.pool.end();
  }

  async withPrismaTransaction<T>(
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
    maxAttempts = 3,
    options: PrismaTransactionOptions = {},
  ): Promise<T> {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new Error("postgres_transaction_retry_limit_invalid");
    }
    const statementTimeoutMillis = options.statementTimeoutMillis === undefined
      ? this.statementTimeoutMillis
      : boundedTimeout(options.statementTimeoutMillis, "postgres_transaction_statement_timeout_invalid");
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('statement_timeout', ${String(statementTimeoutMillis)}, true)`;
          await transaction.$executeRaw`SELECT set_config('lock_timeout', ${String(this.lockTimeoutMillis)}, true)`;
          await transaction.$executeRaw`SELECT set_config('idle_in_transaction_session_timeout', ${String(this.idleInTransactionSessionTimeoutMillis)}, true)`;
          return callback(transaction);
        }, {
          isolationLevel: options.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: this.transactionTimeoutMillis,
        });
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryablePostgresTransactionError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, 25 * 2 ** (attempt - 1))));
      }
    }
  }
}

export function createPostgresClient(options: PostgresClientOptions): PostgresClientOwner {
  return new PostgresClientOwner(options);
}

export function createPostgresClientFromEnvironment(environment: NodeJS.ProcessEnv = process.env): PostgresClientOwner {
  const connectionString = resolvePostgresConnectionStringFromEnvironment(environment);
  return createPostgresClient({
    connectionString,
    applicationName: environment.FRIDAY_RELAY_PG_APPLICATION_NAME ?? "friday-relay",
    ...(environment.FRIDAY_RELAY_PG_POOL_MAX ? { max: Number(environment.FRIDAY_RELAY_PG_POOL_MAX) } : {}),
  });
}

export function resolvePostgresConnectionStringFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string {
  const direct = environment.FRIDAY_RELAY_PG_CONNECTION_STRING;
  const secretFile = environment.FRIDAY_RELAY_PG_CONNECTION_STRING_FILE;
  if (direct && secretFile) throw new Error("postgres_connection_string_secret_source_ambiguous");
  if (direct) return validatePostgresConnectionSecret(direct);
  if (!secretFile) throw new Error("postgres_connection_string_secret_required");
  if (!secretFile.startsWith("/") || secretFile.includes("\0")) throw new Error("postgres_connection_string_secret_file_invalid");
  const metadata = lstatSync(secretFile);
  const mode = metadata.mode & 0o777;
  const runtimeGroups = new Set<number>([
    ...(typeof process.getegid === "function" ? [process.getegid()] : []),
    ...(typeof process.getgroups === "function" ? process.getgroups() : []),
  ]);
  const inaccessibleGroupRead = (mode & 0o040) !== 0 && !runtimeGroups.has(metadata.gid);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (mode & 0o037) !== 0 || inaccessibleGroupRead) {
    throw new Error("postgres_connection_string_secret_file_permissions_invalid");
  }
  return validatePostgresConnectionSecret(readFileSync(secretFile, "utf8"));
}

export function isRetryablePostgresTransactionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; meta?: unknown };
  if (["40001", "40P01", "P2034"].includes(String(record.code))) return true;
  if (record.code !== "P2010" || !record.meta || typeof record.meta !== "object") return false;
  const driver = (record.meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (!driver || typeof driver !== "object") return false;
  const cause = (driver as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return false;
  const details = cause as { kind?: unknown; originalCode?: unknown; code?: unknown };
  return details.kind === "TransactionWriteConflict" || details.originalCode === "40001" || details.code === "40001";
}

function boundedTimeout(value: number, errorCode: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) throw new Error(errorCode);
  return value;
}

function normalizeSearchPath(value: string): string {
  const paths = value.split(",").map((path) => path.trim()).filter(Boolean);
  if (paths.length === 0 || paths.some((path) => !/^[a-z_][a-z0-9_]*$/iu.test(path))) throw new Error("postgres_search_path_invalid");
  return paths.join(",");
}

function parsePostgresInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("postgres_int8_outside_safe_integer");
  return parsed;
}

function validatePostgresConnectionSecret(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 4096 || normalized.includes("\n") || normalized.includes("\r")) {
    throw new Error("postgres_connection_string_secret_invalid");
  }
  return normalized;
}
