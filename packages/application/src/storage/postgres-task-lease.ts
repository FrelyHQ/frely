import type { QueryResultRow } from "pg";
import type { PostgresClientOwner, PostgresTransactionContext } from "@frely/postgres/server";

type QueryExecutor = Pick<PostgresClientOwner, "query"> | Pick<PostgresTransactionContext, "query">;

export interface PostgresTaskLease {
  taskKey: string;
  ownerId: string;
  fencingToken: number;
  leaseUntilMs: number;
}

export interface AcquirePostgresTaskLeaseInput {
  taskKey: string;
  ownerId: string;
  leaseDurationMs: number;
}

export const POSTGRES_TASK_LEASE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "friday_relay_task_leases" (
     task_key text PRIMARY KEY,
     owner_id text NOT NULL,
     fencing_token bigint NOT NULL,
     lease_until_ms bigint NOT NULL,
     updated_at_ms bigint NOT NULL
   )`,
] as const;

/**
 * Database-time lease/fencing primitive for bounded one-shot tasks.
 * Schema ownership belongs to database migrations; runtime code never creates
 * this table as part of task execution.
 */
export class PostgresTaskLeaseStore {
  constructor(private readonly executor: QueryExecutor) {}

  async acquire(input: AcquirePostgresTaskLeaseInput): Promise<PostgresTaskLease> {
    assertLeaseInput(input);
    const result = await this.executor.query<LeaseRow>(
      `WITH now AS (
         SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
       )
       INSERT INTO "friday_relay_task_leases" (task_key, owner_id, fencing_token, lease_until_ms, updated_at_ms)
       VALUES ($1, $2, 1, (SELECT now_ms + $3 FROM now), (SELECT now_ms FROM now))
       ON CONFLICT (task_key) DO UPDATE SET
         owner_id = EXCLUDED.owner_id,
         fencing_token = "friday_relay_task_leases".fencing_token + 1,
         lease_until_ms = (SELECT now_ms + $3 FROM now),
         updated_at_ms = (SELECT now_ms FROM now)
       WHERE "friday_relay_task_leases".lease_until_ms <= (SELECT now_ms FROM now)
       RETURNING task_key, owner_id, fencing_token, lease_until_ms`,
      [input.taskKey, input.ownerId, input.leaseDurationMs],
    );
    const row = result.rows[0];
    if (!row) throw new Error("postgres_task_lease_busy");
    return mapLease(row);
  }

  async renew(input: PostgresTaskLease, leaseDurationMs: number): Promise<PostgresTaskLease> {
    assertLeaseInput({ taskKey: input.taskKey, ownerId: input.ownerId, leaseDurationMs });
    const result = await this.executor.query<LeaseRow>(
      `WITH now AS (
         SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
       )
       UPDATE "friday_relay_task_leases"
       SET lease_until_ms = (SELECT now_ms + $4 FROM now),
           updated_at_ms = (SELECT now_ms FROM now)
       WHERE task_key = $1
         AND owner_id = $2
         AND fencing_token = $3
         AND lease_until_ms > (SELECT now_ms FROM now)
       RETURNING task_key, owner_id, fencing_token, lease_until_ms`,
      [input.taskKey, input.ownerId, input.fencingToken, leaseDurationMs],
    );
    const row = result.rows[0];
    if (!row) throw new Error("postgres_task_lease_lost");
    return mapLease(row);
  }

  async assertHeld(input: PostgresTaskLease): Promise<void> {
    const result = await this.executor.query<LeaseRow>(
      `SELECT task_key, owner_id, fencing_token, lease_until_ms
       FROM "friday_relay_task_leases"
       WHERE task_key = $1
         AND owner_id = $2
         AND fencing_token = $3
         AND lease_until_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint`,
      [input.taskKey, input.ownerId, input.fencingToken],
    );
    if (!result.rows[0]) throw new Error("postgres_task_lease_lost");
  }

  async release(input: PostgresTaskLease): Promise<void> {
    const result = await this.executor.query(
      `UPDATE "friday_relay_task_leases"
       SET owner_id = '', lease_until_ms = 0,
           updated_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       WHERE task_key = $1 AND owner_id = $2 AND fencing_token = $3
       RETURNING task_key`,
      [input.taskKey, input.ownerId, input.fencingToken],
    );
    if (!result.rows[0]) throw new Error("postgres_task_lease_lost");
  }

  async withLease<T>(input: AcquirePostgresTaskLeaseInput, callback: (lease: PostgresTaskLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire(input);
    try {
      return await callback(lease);
    } finally {
      await this.release(lease);
    }
  }

  async withRenewingLease<T>(
    input: AcquirePostgresTaskLeaseInput,
    callback: (lease: PostgresTaskLease, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let lease = await this.acquire(input);
    const controller = new AbortController();
    let renewalTimer: NodeJS.Timeout | undefined;
    let renewalInFlight: Promise<void> | undefined;
    let renewalFailure: unknown;
    let stopped = false;
    const scheduleRenewal = () => {
      if (stopped) return;
      renewalTimer = setTimeout(() => {
        renewalInFlight = this.renew(lease, input.leaseDurationMs).then((renewed) => {
          lease = renewed;
          scheduleRenewal();
        }).catch((error) => {
          renewalFailure = error;
          controller.abort(error);
        }).finally(() => { renewalInFlight = undefined; });
      }, Math.max(1_000, Math.floor(input.leaseDurationMs / 3)));
      renewalTimer.unref();
    };
    scheduleRenewal();
    try {
      const result = await callback(lease, controller.signal);
      if (renewalInFlight) await renewalInFlight;
      if (renewalFailure) throw renewalFailure;
      await this.assertHeld(lease);
      return result;
    } finally {
      stopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      if (renewalInFlight) await renewalInFlight;
      await this.release(lease).catch((error) => {
        if (!renewalFailure && !(error instanceof Error && error.message === "postgres_task_lease_lost")) throw error;
      });
    }
  }
}

interface LeaseRow extends QueryResultRow {
  task_key: string;
  owner_id: string;
  fencing_token: number | string;
  lease_until_ms: number | string;
}

function mapLease(row: LeaseRow): PostgresTaskLease {
  return {
    taskKey: row.task_key,
    ownerId: row.owner_id,
    fencingToken: safeInteger(row.fencing_token, "postgres_task_lease_fencing_token_invalid"),
    leaseUntilMs: safeInteger(row.lease_until_ms, "postgres_task_lease_until_invalid"),
  };
}

function assertLeaseInput(input: AcquirePostgresTaskLeaseInput): void {
  if (!input.taskKey || !input.ownerId) throw new Error("postgres_task_lease_identity_required");
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1 || input.leaseDurationMs > 86_400_000) {
    throw new Error("postgres_task_lease_duration_invalid");
  }
}

function safeInteger(value: number | string, errorCode: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(errorCode);
  return parsed;
}
