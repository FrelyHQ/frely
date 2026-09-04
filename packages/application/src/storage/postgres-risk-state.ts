import { randomUUID } from "node:crypto";
import { RelayError } from "@frely/core";
import type { PostgresClientOwner, PostgresTransactionContext } from "@frely/postgres/server";

export const POSTGRES_SHADOW_RISK_SCHEMA = "friday-relay-postgres-shadow-risk-v1";
export const POSTGRES_SHADOW_RISK_STATE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "friday_relay_shadow_risk_state" (
    guard_id text PRIMARY KEY,
    profile_digest text NOT NULL,
    revision bigint NOT NULL,
    window_started_at_ms bigint NOT NULL,
    request_starts_json text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "friday_relay_shadow_risk_reservations" (
    reservation_id text PRIMARY KEY,
    guard_id text NOT NULL REFERENCES "friday_relay_shadow_risk_state" (guard_id) DEFERRABLE INITIALLY DEFERRED,
    status text NOT NULL CHECK (status IN ('active', 'settled', 'conservative')),
    reserved_credit_units bigint NOT NULL,
    settled_credit_units bigint,
    acquired_at_ms bigint NOT NULL,
    expires_at_ms bigint NOT NULL,
    terminal_at_ms bigint,
    terminal_evidence_digest text
  )`,
  `CREATE INDEX IF NOT EXISTS "friday_relay_shadow_risk_reservations_guard_status_idx"
    ON "friday_relay_shadow_risk_reservations" (guard_id, status, acquired_at_ms)`,
] as const;

export interface PostgresShadowRiskProfile {
  profileDigest: string;
  requestStartsLimit: number;
  requestStartsWindowMs: number;
  maxInFlight: number;
  riskBudgetWindowMs: number;
  leaseTtlMs: number;
  maxReservedCreditUnits: number;
}

export interface PostgresShadowRiskLease {
  readonly reservationId: string;
  readonly reservedCreditUnits: number;
  settle(actualCreditUnits: number, nowMs?: number): Promise<void>;
  closeUnknown(nowMs?: number): Promise<void>;
}

export interface PostgresShadowRiskInspection {
  profileDigest: string;
  revision: number;
  windowStartedAtMs: number;
  requestStarts: number;
  inFlight: number;
  reservedCreditUnits: number;
}

export class PostgresShadowRiskLimitError extends RelayError {
  readonly reason: "request_starts" | "in_flight" | "risk_budget";

  constructor(reason: PostgresShadowRiskLimitError["reason"], retryAfterSeconds: number) {
    super("request_risk_limit", "Request admission risk limit reached", 429, { reason, retryAfterSeconds });
    this.reason = reason;
  }
}

/**
 * Shared PG reservation state for the review-dev shadow/risk guard. All state
 * transitions lock the guard row first; callers must keep provider/Stripe/CPA
 * side effects outside these transactions.
 */
export class PostgresShadowRiskStateStore {
  constructor(
    private readonly database: PostgresClientOwner,
    private readonly guardId: string,
    private readonly profile: PostgresShadowRiskProfile,
  ) {
    assertIdentifier(guardId, "postgres_shadow_risk_guard_id_invalid");
    validateProfile(profile);
  }

  async initialize(nowMs = Date.now()): Promise<void> {
    const normalizedNow = normalizeNow(nowMs);
    const result = await this.database.query(
      `INSERT INTO "friday_relay_shadow_risk_state"
        (guard_id, profile_digest, revision, window_started_at_ms, request_starts_json, updated_at)
       VALUES ($1, $2, 1, $3, '[]', $4)
       ON CONFLICT (guard_id) DO NOTHING
       RETURNING guard_id`,
      [this.guardId, this.profile.profileDigest, windowStart(normalizedNow, this.profile.riskBudgetWindowMs), new Date(normalizedNow).toISOString()],
    );
    if (!result.rows[0]) throw new Error("postgres_shadow_risk_state_already_exists");
  }

  async selfCheck(): Promise<void> {
    const result = await this.database.query<RiskStateRow>(
      `SELECT guard_id, profile_digest, revision, window_started_at_ms, request_starts_json
       FROM "friday_relay_shadow_risk_state" WHERE guard_id = $1`,
      [this.guardId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("postgres_shadow_risk_state_missing");
    assertProfileDigest(row.profile_digest, this.profile.profileDigest);
    parseRequestStarts(row.request_starts_json);
  }

  async acquire(input: { reservedCreditUnits: number; nowMs?: number }): Promise<PostgresShadowRiskLease> {
    assertCreditUnits(input.reservedCreditUnits, "reserved Credit units");
    const reservationId = `rsv_${randomUUID().replaceAll("-", "")}`;
    const nowMs = normalizeNow(input.nowMs ?? Date.now());
    const reservation = await this.database.withRetriedTransaction(async (context) => {
      const state = await this.lockState(context);
      const rolled = rollState(state, nowMs, this.profile);
      if (rolled.window_started_at_ms !== state.window_started_at_ms) {
        await context.query(
          `DELETE FROM "friday_relay_shadow_risk_reservations"
           WHERE guard_id = $1 AND status <> 'active' AND terminal_at_ms IS NOT NULL AND terminal_at_ms < $2`,
          [this.guardId, rolled.window_started_at_ms],
        );
      }
      const starts = parseRequestStarts(rolled.request_starts_json).filter((startedAt) => startedAt > nowMs - this.profile.requestStartsWindowMs);
      if (starts.length >= this.profile.requestStartsLimit) {
        throw new PostgresShadowRiskLimitError("request_starts", retryAfterSeconds(nowMs, starts[0]! + this.profile.requestStartsWindowMs));
      }
      const active = await this.countReservations(context, "active");
      if (active >= this.profile.maxInFlight) {
        throw new PostgresShadowRiskLimitError("in_flight", Math.ceil(this.profile.requestStartsWindowMs / 1_000));
      }
      const exposure = await this.currentExposure(context);
      if (exposure + input.reservedCreditUnits > this.profile.maxReservedCreditUnits) {
        throw new PostgresShadowRiskLimitError("risk_budget", retryAfterSeconds(nowMs, rolled.window_started_at_ms + this.profile.riskBudgetWindowMs));
      }
      const next = {
        id: reservationId,
        reservedCreditUnits: input.reservedCreditUnits,
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + this.profile.leaseTtlMs,
      };
      starts.push(nowMs);
      await context.query(
        `INSERT INTO "friday_relay_shadow_risk_reservations"
          (reservation_id, guard_id, status, reserved_credit_units, settled_credit_units, acquired_at_ms, expires_at_ms, terminal_at_ms, terminal_evidence_digest)
         VALUES ($1, $2, 'active', $3, NULL, $4, $5, NULL, NULL)`,
        [next.id, this.guardId, next.reservedCreditUnits, next.acquiredAtMs, next.expiresAtMs],
      );
      await this.updateState(context, rolled, starts, nowMs);
      return next;
    });

    let closed = false;
    return {
      reservationId: reservation.id,
      reservedCreditUnits: reservation.reservedCreditUnits,
      settle: async (actualCreditUnits, terminalNowMs = Date.now()) => {
        if (closed) return;
        assertCreditUnits(actualCreditUnits, "settled Credit units");
        await this.finishReservation(reservation.id, "settled", actualCreditUnits, normalizeNow(terminalNowMs));
        closed = true;
      },
      closeUnknown: async (terminalNowMs = Date.now()) => {
        if (closed) return;
        await this.finishReservation(reservation.id, "conservative", null, normalizeNow(terminalNowMs));
        closed = true;
      },
    };
  }

  async recoverExpiredLease(input: { reservationId: string; terminalEvidenceDigest: string; nowMs?: number }): Promise<void> {
    assertReservationId(input.reservationId);
    assertDigest(input.terminalEvidenceDigest);
    const nowMs = normalizeNow(input.nowMs ?? Date.now());
    await this.database.withRetriedTransaction(async (context) => {
      await this.lockState(context);
      const result = await context.query<ReservationRow>(
        `SELECT reservation_id, status, expires_at_ms FROM "friday_relay_shadow_risk_reservations"
         WHERE reservation_id = $1 AND guard_id = $2 FOR UPDATE`,
        [input.reservationId, this.guardId],
      );
      const reservation = result.rows[0];
      if (!reservation || reservation.status !== "active") throw new Error("postgres_shadow_risk_reservation_not_active");
      if (nowMs < safeInteger(reservation.expires_at_ms, "postgres_shadow_risk_expiry_invalid")) throw new Error("postgres_shadow_risk_reservation_not_expired");
      await context.query(
        `UPDATE "friday_relay_shadow_risk_reservations"
         SET status = 'conservative', terminal_at_ms = $3, terminal_evidence_digest = $4
         WHERE reservation_id = $1 AND guard_id = $2 AND status = 'active'`,
        [input.reservationId, this.guardId, nowMs, input.terminalEvidenceDigest],
      );
      await this.bumpState(context, nowMs);
    });
  }

  async inspect(): Promise<PostgresShadowRiskInspection> {
    const stateResult = await this.database.query<RiskStateRow>(
      `SELECT guard_id, profile_digest, revision, window_started_at_ms, request_starts_json
       FROM "friday_relay_shadow_risk_state" WHERE guard_id = $1`,
      [this.guardId],
    );
    const state = stateResult.rows[0];
    if (!state) throw new Error("postgres_shadow_risk_state_missing");
    assertProfileDigest(state.profile_digest, this.profile.profileDigest);
    const reservations = await this.database.query<ReservationAggregateRow>(
      `SELECT COUNT(*) FILTER (WHERE status = 'active')::integer AS in_flight,
              COALESCE(SUM(CASE WHEN status = 'settled' THEN settled_credit_units ELSE reserved_credit_units END), 0)::bigint AS reserved_credit_units
       FROM "friday_relay_shadow_risk_reservations" WHERE guard_id = $1`,
      [this.guardId],
    );
    return {
      profileDigest: state.profile_digest,
      revision: safeInteger(state.revision, "postgres_shadow_risk_revision_invalid"),
      windowStartedAtMs: safeInteger(state.window_started_at_ms, "postgres_shadow_risk_window_invalid"),
      requestStarts: parseRequestStarts(state.request_starts_json).length,
      inFlight: Number(reservations.rows[0]?.in_flight ?? 0),
      reservedCreditUnits: safeInteger(reservations.rows[0]?.reserved_credit_units ?? 0, "postgres_shadow_risk_exposure_invalid"),
    };
  }

  private async finishReservation(reservationId: string, status: "settled" | "conservative", settledCreditUnits: number | null, nowMs: number): Promise<void> {
    await this.database.withRetriedTransaction(async (context) => {
      await this.lockState(context);
      const result = await context.query<{ status: string }>(
        `UPDATE "friday_relay_shadow_risk_reservations"
         SET status = $3, settled_credit_units = $4, terminal_at_ms = $5
         WHERE reservation_id = $1 AND guard_id = $2 AND status = 'active'
         RETURNING status`,
        [reservationId, this.guardId, status, settledCreditUnits, nowMs],
      );
      if (!result.rows[0]) throw new Error("postgres_shadow_risk_reservation_not_active");
      await this.bumpState(context, nowMs);
    });
  }

  private async lockState(context: PostgresTransactionContext): Promise<RiskStateRow> {
    const result = await context.query<RiskStateRow>(
      `SELECT guard_id, profile_digest, revision, window_started_at_ms, request_starts_json
       FROM "friday_relay_shadow_risk_state" WHERE guard_id = $1 FOR UPDATE`,
      [this.guardId],
    );
    const state = result.rows[0];
    if (!state) throw new Error("postgres_shadow_risk_state_missing");
    assertProfileDigest(state.profile_digest, this.profile.profileDigest);
    parseRequestStarts(state.request_starts_json);
    return state;
  }

  private async countReservations(context: PostgresTransactionContext, status: "active"): Promise<number> {
    const result = await context.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM "friday_relay_shadow_risk_reservations" WHERE guard_id = $1 AND status = $2`,
      [this.guardId, status],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async currentExposure(context: PostgresTransactionContext): Promise<number> {
    const result = await context.query<{ exposure: number }>(
      `SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN settled_credit_units ELSE reserved_credit_units END), 0)::bigint AS exposure
       FROM "friday_relay_shadow_risk_reservations" WHERE guard_id = $1`,
      [this.guardId],
    );
    return safeInteger(result.rows[0]?.exposure ?? 0, "postgres_shadow_risk_exposure_invalid");
  }

  private async updateState(context: PostgresTransactionContext, state: RiskStateRow, requestStarts: number[], nowMs: number): Promise<void> {
    await context.query(
      `UPDATE "friday_relay_shadow_risk_state"
       SET revision = revision + 1, window_started_at_ms = $2, request_starts_json = $3, updated_at = $4
       WHERE guard_id = $1`,
      [this.guardId, state.window_started_at_ms, JSON.stringify(requestStarts), new Date(nowMs).toISOString()],
    );
  }

  private async bumpState(context: PostgresTransactionContext, nowMs: number): Promise<void> {
    await context.query(
      `UPDATE "friday_relay_shadow_risk_state" SET revision = revision + 1, updated_at = $2 WHERE guard_id = $1`,
      [this.guardId, new Date(nowMs).toISOString()],
    );
  }
}

interface RiskStateRow {
  guard_id: string;
  profile_digest: string;
  revision: number;
  window_started_at_ms: number;
  request_starts_json: string;
}

interface ReservationRow {
  reservation_id: string;
  status: string;
  expires_at_ms: number;
}

interface ReservationAggregateRow {
  in_flight: number;
  reserved_credit_units: number;
}

function rollState(state: RiskStateRow, nowMs: number, profile: PostgresShadowRiskProfile): RiskStateRow {
  const currentWindow = windowStart(nowMs, profile.riskBudgetWindowMs);
  const existingWindow = safeInteger(state.window_started_at_ms, "postgres_shadow_risk_window_invalid");
  if (existingWindow > currentWindow) throw new Error("postgres_shadow_risk_clock_moved_backwards");
  return existingWindow === currentWindow
    ? state
    : { ...state, window_started_at_ms: currentWindow, request_starts_json: "[]" };
}

function validateProfile(profile: PostgresShadowRiskProfile): void {
  assertDigest(profile.profileDigest);
  for (const [key, value] of Object.entries(profile)) {
    if (key === "profileDigest") continue;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("postgres_shadow_risk_profile_invalid");
  }
}

function assertIdentifier(value: string, errorCode: string): void {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(value)) throw new Error(errorCode);
}

function assertReservationId(value: string): void {
  if (!/^rsv_[0-9a-f]{32}$/u.test(value)) throw new Error("postgres_shadow_risk_reservation_id_invalid");
}

function assertDigest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error("postgres_shadow_risk_profile_digest_invalid");
}

function assertProfileDigest(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("postgres_shadow_risk_profile_digest_mismatch");
}

function assertCreditUnits(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function safeInteger(value: unknown, errorCode: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(errorCode);
  return parsed;
}

function normalizeNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("postgres_shadow_risk_now_invalid");
  return value;
}

function windowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

function parseRequestStarts(value: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("postgres_shadow_risk_request_starts_invalid");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0)) throw new Error("postgres_shadow_risk_request_starts_invalid");
  return parsed as number[];
}

function retryAfterSeconds(nowMs: number, retryAtMs: number): number {
  return Math.max(1, Math.ceil((retryAtMs - nowMs) / 1_000));
}
