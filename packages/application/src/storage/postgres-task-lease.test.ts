import { describe, expect, test } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { PostgresTaskLeaseStore } from "./postgres-task-lease.js";

class FakeQueryExecutor {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  private readonly responses: unknown[][];

  constructor(...responses: unknown[][]) {
    this.responses = responses;
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    this.calls.push({ text, values: values ?? [] });
    return {
      rows: (this.responses.shift() ?? []) as T[],
      command: "SELECT",
      rowCount: 0,
      oid: 0,
      fields: [],
    };
  }
}

describe("PostgreSQL one-shot task lease fencing", () => {
  test("acquires, renews, verifies and releases a database-time lease", async () => {
    const executor = new FakeQueryExecutor(
      [{ task_key: "settlement", owner_id: "review-dev", fencing_token: "7", lease_until_ms: "1234" }],
      [{ task_key: "settlement", owner_id: "review-dev", fencing_token: 7, lease_until_ms: 2345 }],
      [{ task_key: "settlement", owner_id: "review-dev", fencing_token: 7, lease_until_ms: 2345 }],
      [{ task_key: "settlement" }],
    );
    const store = new PostgresTaskLeaseStore(executor);
    const lease = await store.acquire({ taskKey: "settlement", ownerId: "review-dev", leaseDurationMs: 30_000 });
    expect(lease).toEqual({ taskKey: "settlement", ownerId: "review-dev", fencingToken: 7, leaseUntilMs: 1234 });
    const renewed = await store.renew(lease, 30_000);
    expect(renewed.leaseUntilMs).toBe(2345);
    await expect(store.assertHeld(renewed)).resolves.toBeUndefined();
    await expect(store.release(renewed)).resolves.toBeUndefined();
    expect(executor.calls.some(({ text }) => text.includes("clock_timestamp()"))).toBe(true);
    expect(executor.calls[0]?.text).not.toContain('OR "friday_relay_task_leases".owner_id');
  });

  test("rejects a lost fencing token and invalid lease duration", async () => {
    const executor = new FakeQueryExecutor([]);
    const store = new PostgresTaskLeaseStore(executor);
    await expect(store.acquire({ taskKey: "", ownerId: "owner", leaseDurationMs: 1 })).rejects.toThrow(/identity_required/u);
    await expect(store.acquire({ taskKey: "task", ownerId: "owner", leaseDurationMs: 0 })).rejects.toThrow(/duration_invalid/u);
    await expect(store.assertHeld({ taskKey: "task", ownerId: "owner", fencingToken: 1, leaseUntilMs: 1 })).rejects.toThrow(/lease_lost/u);
  });
});
