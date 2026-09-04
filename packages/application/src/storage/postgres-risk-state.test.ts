import { describe, expect, test } from "vitest";
import type { PostgresClientOwner, PostgresTransactionContext } from "@frely/postgres/server";
import { PostgresShadowRiskLimitError, PostgresShadowRiskStateStore } from "./postgres-risk-state.js";

type State = { guardId: string; profileDigest: string; revision: number; windowStartedAtMs: number; requestStartsJson: string };
type Reservation = { id: string; guardId: string; status: string; reserved: number; settled: number | null; expiresAtMs: number };

class FakeRiskDatabase {
  state?: State;
  readonly reservations = new Map<string, Reservation>();

  async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    if (text.startsWith("INSERT INTO \"friday_relay_shadow_risk_state\"")) {
      if (this.state) return { rows: [], rowCount: 0 };
      this.state = { guardId: String(values[0]), profileDigest: String(values[1]), revision: 1, windowStartedAtMs: Number(values[2]), requestStartsJson: "[]" };
      return { rows: [{ guard_id: this.state.guardId } as unknown as T], rowCount: 1 };
    }
    if (text.includes("SELECT guard_id, profile_digest, revision, window_started_at_ms, request_starts_json")) {
      return { rows: this.state ? [{ guard_id: this.state.guardId, profile_digest: this.state.profileDigest, revision: this.state.revision, window_started_at_ms: this.state.windowStartedAtMs, request_starts_json: this.state.requestStartsJson } as unknown as T] : [], rowCount: this.state ? 1 : 0 };
    }
    if (text.includes("COUNT(*) FILTER")) {
      const rows = [...this.reservations.values()].filter((row) => row.guardId === String(values[0]));
      const exposure = rows.reduce((sum, row) => sum + (row.status === "settled" ? row.settled ?? 0 : row.reserved), 0);
      return { rows: [{ in_flight: rows.filter((row) => row.status === "active").length, reserved_credit_units: exposure } as unknown as T], rowCount: 1 };
    }
    if (text.includes("COUNT(*)::integer AS count")) {
      const count = [...this.reservations.values()].filter((row) => row.guardId === String(values[0]) && row.status === String(values[1])).length;
      return { rows: [{ count } as unknown as T], rowCount: 1 };
    }
    if (text.startsWith("SELECT COALESCE(SUM")) {
      const exposure = [...this.reservations.values()]
        .filter((row) => row.guardId === String(values[0]))
        .reduce((sum, row) => sum + (row.status === "settled" ? row.settled ?? 0 : row.reserved), 0);
      return { rows: [{ exposure } as unknown as T], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO \"friday_relay_shadow_risk_reservations\"")) {
      const row: Reservation = { id: String(values[0]), guardId: String(values[1]), status: "active", reserved: Number(values[2]), settled: null, expiresAtMs: Number(values[4]) };
      this.reservations.set(row.id, row);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE \"friday_relay_shadow_risk_state\"\n       SET revision")) {
      if (!this.state) throw new Error("fake_state_missing");
      this.state.revision += 1;
      this.state.windowStartedAtMs = Number(values[1]);
      this.state.requestStartsJson = String(values[2]);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE \"friday_relay_shadow_risk_state\" SET revision")) {
      if (!this.state) throw new Error("fake_state_missing");
      this.state.revision += 1;
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE \"friday_relay_shadow_risk_reservations\"")) {
      const id = String(values[0]);
      const row = this.reservations.get(id);
      if (!row || row.status !== "active") return { rows: [], rowCount: 0 };
      row.status = String(values[2]);
      row.settled = values[3] === null ? null : Number(values[3]);
      return { rows: [{ status: row.status } as unknown as T], rowCount: 1 };
    }
    if (text.startsWith("DELETE FROM \"friday_relay_shadow_risk_reservations\"")) return { rows: [], rowCount: 0 };
    throw new Error(`fake_query_unhandled:${text}`);
  }

  async withRetriedTransaction<T>(callback: (context: PostgresTransactionContext) => Promise<T>): Promise<T> {
    return callback({ query: (text, values) => this.query(text, values) as never, copyFrom: () => { throw new Error("not_used"); } });
  }
}

const profile = {
  profileDigest: `sha256:${"a".repeat(64)}`,
  requestStartsLimit: 2,
  requestStartsWindowMs: 60_000,
  maxInFlight: 1,
  riskBudgetWindowMs: 86_400_000,
  leaseTtlMs: 1_000,
  maxReservedCreditUnits: 10,
};

describe("PostgreSQL shared shadow risk state", () => {
  test("serializes reservation admission and terminal settlement through the shared state", async () => {
    const database = new FakeRiskDatabase();
    const store = new PostgresShadowRiskStateStore(database as unknown as PostgresClientOwner, "review-dev", profile);
    await store.initialize(0);
    await store.selfCheck();
    const lease = await store.acquire({ reservedCreditUnits: 3, nowMs: 1 });
    await expect(store.acquire({ reservedCreditUnits: 2, nowMs: 2 })).rejects.toBeInstanceOf(PostgresShadowRiskLimitError);
    await lease.settle(2, 3);
    await expect(store.inspect()).resolves.toMatchObject({ requestStarts: 1, inFlight: 0, reservedCreditUnits: 2 });
  });
});
