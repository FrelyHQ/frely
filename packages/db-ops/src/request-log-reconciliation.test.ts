import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "@frely/config";
import type { PostgresClientOwner, PostgresTransactionContext } from "@frely/postgres/server";
import { afterEach, describe, expect, test } from "vitest";
import { reconcileStaleStartedRequestLogs } from "./request-log-reconciliation.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("stale PostgreSQL Request Log reconciliation", () => {
  test("reconciles only an old request with no execution, billing, lease, MCP, or Capture evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "request-log-reconciliation-"));
    roots.push(root);
    mkdirSync(join(root, "capture-v3"), { recursive: true, mode: 0o700 });
    const persisted = {
      id: "req_abandoned",
      status: "started",
      started_at: "2026-07-10T00:00:00.000Z",
      ended_at: null as string | null,
      error_code: null as string | null,
    };
    const transaction: PostgresTransactionContext = {
      query: async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes('FROM "request_logs" WHERE "id"')) {
          return result<Row>([persisted], 1);
        }
        if (sql.includes('UPDATE "request_logs"')) {
          persisted.status = "failed";
          persisted.error_code = String(values[1]);
          persisted.ended_at = String(values[2]);
          return result<Row>([{ id: "req_abandoned" }], 1);
        }
        if (sql.includes('DELETE FROM "request_execution_leases"')) return result<Row>([], 0);
        if (sql.includes('FROM "request_execution_leases"')) return result<Row>([{ present: false }], 1);
        if (sql.includes('AS request_execution_present')) {
          return result<Row>([{
            request_execution_present: false,
            request_execution_terminal_without_output: false,
            provider_attempt_present: false,
            provider_attempts_predispatch_only: false,
            provider_attempts_terminal_without_output: false,
            budget_claim_present: false,
            settlement_fact_present: false,
            mcp_execution_present: false,
          }], 1);
        }
        throw new Error("unexpected_test_query");
      },
      copyFrom: () => { throw new Error("copy_not_available"); },
    };
    const client = {
      query: async <Row extends Record<string, unknown>>() => result<Row>([
        { id: "req_abandoned", started_at: "2026-07-10T00:00:00.000Z" },
      ], 1),
      withTransaction: async <Value>(callback: (context: PostgresTransactionContext) => Promise<Value>) => callback(transaction),
    } as unknown as PostgresClientOwner;

    const observed = await reconcileStaleStartedRequestLogs({
      client,
      config: config(root),
      month: "2026-07",
      now: new Date("2026-08-15T00:00:00.000Z"),
    });

    expect(observed).toEqual({
      archiveMonth: "2026-07",
      cutoff: "2026-08-01T00:00:00.000Z",
      examined: 1,
      reconciled: 1,
      blockerCounts: {},
    });
    expect(persisted).toMatchObject({
      status: "failed",
      error_code: "request_lifecycle_abandoned",
      ended_at: "2026-08-15T00:00:00.000Z",
    });
  });

  test("closes only stale pre-dispatch attempts or a lost terminal Request Log projection without rewriting their evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "request-log-evidence-reconciliation-"));
    roots.push(root);
    mkdirSync(join(root, "capture-v3"), { recursive: true, mode: 0o700 });
    const persisted = new Map([
      ["req_predispatch", { id: "req_predispatch", status: "started", started_at: "2026-07-10T00:00:00.000Z", ended_at: null as string | null, error_code: null as string | null }],
      ["req_terminal_projection", { id: "req_terminal_projection", status: "started", started_at: "2026-07-11T00:00:00.000Z", ended_at: null as string | null, error_code: null as string | null }],
      ["req_settlement_fact", { id: "req_settlement_fact", status: "started", started_at: "2026-07-12T00:00:00.000Z", ended_at: null as string | null, error_code: null as string | null }],
    ]);
    const evidence = new Map<string, Record<string, boolean>>([
      ["req_predispatch", {
        request_execution_present: false,
        request_execution_terminal_without_output: false,
        provider_attempt_present: true,
        provider_attempts_predispatch_only: true,
        provider_attempts_terminal_without_output: false,
        budget_claim_present: false,
        settlement_fact_present: false,
        mcp_execution_present: false,
      }],
      ["req_terminal_projection", {
        request_execution_present: true,
        request_execution_terminal_without_output: true,
        provider_attempt_present: true,
        provider_attempts_predispatch_only: false,
        provider_attempts_terminal_without_output: true,
        budget_claim_present: true,
        settlement_fact_present: false,
        mcp_execution_present: false,
      }],
      ["req_settlement_fact", {
        request_execution_present: true,
        request_execution_terminal_without_output: true,
        provider_attempt_present: true,
        provider_attempts_predispatch_only: false,
        provider_attempts_terminal_without_output: true,
        budget_claim_present: true,
        settlement_fact_present: true,
        mcp_execution_present: false,
      }],
    ]);
    const transaction: PostgresTransactionContext = {
      query: async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
        const requestId = String(values[0]);
        if (sql.includes('FROM "request_logs" WHERE "id"')) {
          const row = persisted.get(requestId);
          return result<Row>(row ? [row] : [], row ? 1 : 0);
        }
        if (sql.includes('UPDATE "request_logs"')) {
          const row = persisted.get(requestId);
          if (!row) return result<Row>([], 0);
          row.status = "failed";
          row.error_code = String(values[1]);
          row.ended_at = String(values[2]);
          return result<Row>([{ id: requestId }], 1);
        }
        if (sql.includes('DELETE FROM "request_execution_leases"')) return result<Row>([], 1);
        if (sql.includes('FROM "request_execution_leases"')) return result<Row>([{ present: false }], 1);
        if (sql.includes('AS request_execution_present')) return result<Row>([evidence.get(requestId) ?? {}], 1);
        throw new Error("unexpected_test_query");
      },
      copyFrom: () => { throw new Error("copy_not_available"); },
    };
    const client = {
      query: async <Row extends Record<string, unknown>>() => result<Row>([
        { id: "req_predispatch", started_at: "2026-07-10T00:00:00.000Z" },
        { id: "req_terminal_projection", started_at: "2026-07-11T00:00:00.000Z" },
        { id: "req_settlement_fact", started_at: "2026-07-12T00:00:00.000Z" },
      ], 3),
      withTransaction: async <Value>(callback: (context: PostgresTransactionContext) => Promise<Value>) => callback(transaction),
    } as unknown as PostgresClientOwner;

    const observed = await reconcileStaleStartedRequestLogs({
      client,
      config: config(root),
      month: "2026-07",
      now: new Date("2026-08-15T00:00:00.000Z"),
    });

    expect(observed).toMatchObject({ examined: 3, reconciled: 2, blockerCounts: { request_execution_present: 1 } });
    expect([...persisted.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "req_predispatch", status: "failed", error_code: "request_lifecycle_abandoned" }),
      expect.objectContaining({ id: "req_terminal_projection", status: "failed", error_code: "request_lifecycle_abandoned" }),
      expect.objectContaining({ id: "req_settlement_fact", status: "started", error_code: null }),
    ]));
  });
});

function config(root: string): AppConfig {
  return {
    requestCapture: { hotDays: 90 },
    requestExecution: { leaseTtlSeconds: 1_800, staleAfterSeconds: 86_400 },
    archive: { directory: root, requireColdMount: false, history: { enabled: false, autoPurge: false, hotDays: 180, purgeBatchSize: 200 } },
  } as AppConfig;
}

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount: number) {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}
