import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { RelayError } from "@frely/core";

export const productionShadowRiskStateSchema = "friday-relay.production-shadow-risk-state.v1";

export type ProductionShadowRiskReason = "request_starts" | "in_flight" | "risk_budget";

export interface ProductionShadowRiskProfile {
  readonly canaryMaxWeightPercent: 5;
  readonly requestStarts: Readonly<{ limit: 6; windowSeconds: 60 }>;
  readonly maxInFlight: 2;
  readonly riskBudgetWindowSeconds: 86_400;
  readonly leaseTtlSeconds: 1_800;
  readonly maxReservedCreditUnits: number;
}

export interface ProductionShadowRiskLease {
  readonly reservationId: string;
  readonly reservedCreditUnits: number;
  settle(actualCreditUnits: number, nowMs?: number): void;
  closeUnknown(nowMs?: number): void;
}

export interface ProductionShadowRiskGuardLike {
  readonly enforced: boolean;
  selfCheck(): void;
  acquire(input: { reservedCreditUnits: number; nowMs?: number }): ProductionShadowRiskLease;
}

export interface AsyncProductionShadowRiskLease {
  readonly reservationId: string;
  readonly reservedCreditUnits: number;
  settle(actualCreditUnits: number, nowMs?: number): void | Promise<void>;
  closeUnknown(nowMs?: number): void | Promise<void>;
}

export interface AsyncProductionShadowRiskGuardLike {
  readonly enforced: boolean;
  selfCheck(): void | Promise<void>;
  acquire(input: { reservedCreditUnits: number; nowMs?: number }): AsyncProductionShadowRiskLease | Promise<AsyncProductionShadowRiskLease>;
}

interface RiskReservationState {
  id: string;
  status: "active" | "settled" | "conservative";
  reservedCreditUnits: number;
  settledCreditUnits: number | null;
  acquiredAtMs: number;
  expiresAtMs: number;
  terminalAtMs: number | null;
  terminalEvidenceDigest: string | null;
}

interface ProductionShadowRiskState {
  schema: typeof productionShadowRiskStateSchema;
  profileDigest: string;
  revision: number;
  windowStartedAtMs: number;
  requestStartsMs: number[];
  reservations: RiskReservationState[];
  updatedAt: string;
}

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const reservationPattern = /^rsv_[0-9a-f]{32}$/u;
// Six admitted starts per minute can produce 8,640 terminal reservations in one
// UTC day. Keep a small allowance for active leases carried across midnight.
const maximumDailyReservationRecords = 8_650;

export function fixedProductionShadowRiskProfile(maxReservedCreditUnits: number): ProductionShadowRiskProfile {
  if (!Number.isSafeInteger(maxReservedCreditUnits) || maxReservedCreditUnits <= 0) {
    throw new Error("max reserved Credit units must be a positive safe integer");
  }
  return Object.freeze({
    canaryMaxWeightPercent: 5,
    requestStarts: Object.freeze({ limit: 6, windowSeconds: 60 }),
    maxInFlight: 2,
    riskBudgetWindowSeconds: 86_400,
    leaseTtlSeconds: 1_800,
    maxReservedCreditUnits,
  });
}

export function productionShadowRiskProfileDigest(profile: ProductionShadowRiskProfile): string {
  validateProfile(profile);
  const canonical = JSON.stringify({
    canaryMaxWeightPercent: profile.canaryMaxWeightPercent,
    leaseTtlSeconds: profile.leaseTtlSeconds,
    maxInFlight: profile.maxInFlight,
    maxReservedCreditUnits: profile.maxReservedCreditUnits,
    requestStarts: {
      limit: profile.requestStarts.limit,
      windowSeconds: profile.requestStarts.windowSeconds,
    },
    riskBudgetWindowSeconds: profile.riskBudgetWindowSeconds,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export class DisabledProductionShadowRiskGuard implements ProductionShadowRiskGuardLike {
  readonly enforced = false;

  selfCheck(): void {}

  acquire(input: { reservedCreditUnits: number }): ProductionShadowRiskLease {
    assertCreditUnits(input.reservedCreditUnits, "reserved Credit units");
    return {
      reservationId: "rsv_disabled",
      reservedCreditUnits: input.reservedCreditUnits,
      settle: () => undefined,
      closeUnknown: () => undefined,
    };
  }
}

export class ProductionShadowRiskGuard implements ProductionShadowRiskGuardLike {
  readonly enforced = true;
  readonly statePath: string;
  readonly profile: ProductionShadowRiskProfile;
  readonly profileDigest: string;

  constructor(input: { statePath: string; profile: ProductionShadowRiskProfile }) {
    this.statePath = path.resolve(input.statePath);
    this.profile = fixedProductionShadowRiskProfile(input.profile.maxReservedCreditUnits);
    this.profileDigest = productionShadowRiskProfileDigest(this.profile);
  }

  static initialize(input: {
    statePath: string;
    profile: ProductionShadowRiskProfile;
    nowMs?: number;
  }): ProductionShadowRiskGuard {
    const guard = new ProductionShadowRiskGuard(input);
    const nowMs = normalizeNow(input.nowMs);
    mkdirPrivate(path.dirname(guard.statePath));
    const lock = guard.acquireStateLock();
    try {
      if (existsSync(guard.statePath)) throw new Error("Production shadow risk state already exists");
      guard.writeState({
        schema: productionShadowRiskStateSchema,
        profileDigest: guard.profileDigest,
        revision: 1,
        windowStartedAtMs: utcWindowStart(nowMs),
        requestStartsMs: [],
        reservations: [],
        updatedAt: new Date(nowMs).toISOString(),
      });
    } finally {
      lock.release();
    }
    return guard;
  }

  selfCheck(): void {
    this.failClosed(() => {
      const lock = this.acquireStateLock();
      try {
        this.readState();
      } finally {
        lock.release();
      }
    });
  }

  acquire(input: { reservedCreditUnits: number; nowMs?: number }): ProductionShadowRiskLease {
    assertCreditUnits(input.reservedCreditUnits, "reserved Credit units");
    const nowMs = normalizeNow(input.nowMs);
    const reservation = this.failClosed(() => {
      const lock = this.acquireStateLock();
      try {
        const state = this.rollWindow(this.readState(), nowMs);
        state.requestStartsMs = state.requestStartsMs.filter(
          (startedAt) => startedAt > nowMs - this.profile.requestStarts.windowSeconds * 1_000,
        );
        if (state.requestStartsMs.length >= this.profile.requestStarts.limit) {
          const retryAt = state.requestStartsMs[0]! + this.profile.requestStarts.windowSeconds * 1_000;
          throw riskLimitError("request_starts", retryAfterSeconds(nowMs, retryAt));
        }
        const activeReservations = state.reservations.filter((item) => item.status === "active");
        if (activeReservations.length >= this.profile.maxInFlight) {
          throw riskLimitError("in_flight", this.profile.requestStarts.windowSeconds);
        }
        const currentExposure = state.reservations.reduce(
          (sum, item) => sum + (item.status === "settled" ? item.settledCreditUnits! : item.reservedCreditUnits),
          0,
        );
        if (currentExposure + input.reservedCreditUnits > this.profile.maxReservedCreditUnits) {
          throw riskLimitError(
            "risk_budget",
            retryAfterSeconds(nowMs, state.windowStartedAtMs + this.profile.riskBudgetWindowSeconds * 1_000),
          );
        }
        const next: RiskReservationState = {
          id: `rsv_${randomUUID().replaceAll("-", "")}`,
          status: "active",
          reservedCreditUnits: input.reservedCreditUnits,
          settledCreditUnits: null,
          acquiredAtMs: nowMs,
          expiresAtMs: nowMs + this.profile.leaseTtlSeconds * 1_000,
          terminalAtMs: null,
          terminalEvidenceDigest: null,
        };
        state.requestStartsMs.push(nowMs);
        state.reservations.push(next);
        state.revision += 1;
        state.updatedAt = new Date(nowMs).toISOString();
        this.writeState(state);
        return next;
      } finally {
        lock.release();
      }
    });
    let closed = false;
    return {
      reservationId: reservation.id,
      reservedCreditUnits: reservation.reservedCreditUnits,
      settle: (actualCreditUnits, terminalNowMs) => {
        if (closed) return;
        assertCreditUnits(actualCreditUnits, "settled Credit units");
        this.finishReservation(reservation.id, "settled", actualCreditUnits, normalizeNow(terminalNowMs));
        closed = true;
      },
      closeUnknown: (terminalNowMs) => {
        if (closed) return;
        this.finishReservation(reservation.id, "conservative", null, normalizeNow(terminalNowMs));
        closed = true;
      },
    };
  }

  recoverExpiredLease(input: {
    reservationId: string;
    terminalEvidenceDigest: string;
    nowMs?: number;
  }): void {
    if (!reservationPattern.test(input.reservationId)) throw new Error("Risk reservation id is invalid");
    if (!digestPattern.test(input.terminalEvidenceDigest)) throw new Error("Terminal evidence digest is invalid");
    const nowMs = normalizeNow(input.nowMs);
    this.failClosed(() => {
      const lock = this.acquireStateLock();
      try {
        const state = this.rollWindow(this.readState(), nowMs);
        const reservation = state.reservations.find((item) => item.id === input.reservationId);
        if (!reservation || reservation.status !== "active") throw new Error("Active risk reservation was not found");
        if (nowMs < reservation.expiresAtMs) throw new Error("Risk reservation lease has not expired");
        reservation.status = "conservative";
        reservation.terminalAtMs = nowMs;
        reservation.terminalEvidenceDigest = input.terminalEvidenceDigest;
        state.revision += 1;
        state.updatedAt = new Date(nowMs).toISOString();
        this.writeState(state);
      } finally {
        lock.release();
      }
    });
  }

  inspect(): Readonly<{
    schema: "friday-relay.production-shadow-risk-inspect.v1";
    profileDigest: string;
    revision: number;
    windowStartedAt: string;
    requestStarts: number;
    inFlight: number;
    reservedCreditUnits: number;
  }> {
    return this.failClosed(() => {
      const lock = this.acquireStateLock();
      try {
        const state = this.readState();
        return Object.freeze({
          schema: "friday-relay.production-shadow-risk-inspect.v1" as const,
          profileDigest: state.profileDigest,
          revision: state.revision,
          windowStartedAt: new Date(state.windowStartedAtMs).toISOString(),
          requestStarts: state.requestStartsMs.length,
          inFlight: state.reservations.filter((item) => item.status === "active").length,
          reservedCreditUnits: state.reservations.reduce(
            (sum, item) => sum + (item.status === "settled" ? item.settledCreditUnits! : item.reservedCreditUnits),
            0,
          ),
        });
      } finally {
        lock.release();
      }
    });
  }

  private finishReservation(
    reservationId: string,
    status: "settled" | "conservative",
    settledCreditUnits: number | null,
    nowMs: number,
  ): void {
    this.failClosed(() => {
      const lock = this.acquireStateLock();
      try {
        const state = this.rollWindow(this.readState(), nowMs);
        const reservation = state.reservations.find((item) => item.id === reservationId);
        if (!reservation) throw new Error("Risk reservation was not found");
        if (reservation.status !== "active") return;
        reservation.status = status;
        reservation.settledCreditUnits = settledCreditUnits;
        reservation.terminalAtMs = nowMs;
        state.revision += 1;
        state.updatedAt = new Date(nowMs).toISOString();
        this.writeState(state);
      } finally {
        lock.release();
      }
    });
  }

  private readState(): ProductionShadowRiskState {
    if (!existsSync(this.statePath)) throw new Error("Production shadow risk state is missing");
    if ((statSync(this.statePath).mode & 0o777) !== 0o600) {
      throw new Error("Production shadow risk state must have mode 0600");
    }
    const state = JSON.parse(readFileSync(this.statePath, "utf8")) as unknown;
    validateState(state, this.profileDigest);
    return structuredClone(state);
  }

  private writeState(state: ProductionShadowRiskState): void {
    validateState(state, this.profileDigest);
    mkdirPrivate(path.dirname(this.statePath));
    const temporary = path.join(
      path.dirname(this.statePath),
      `.${path.basename(this.statePath)}.${process.pid}.${randomUUID()}.partial`,
    );
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.statePath);
      chmodSync(this.statePath, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private rollWindow(state: ProductionShadowRiskState, nowMs: number): ProductionShadowRiskState {
    const currentWindowStart = utcWindowStart(nowMs);
    if (state.windowStartedAtMs === currentWindowStart) return state;
    if (state.windowStartedAtMs > currentWindowStart) throw new Error("Production shadow risk state clock moved backwards");
    return {
      ...state,
      windowStartedAtMs: currentWindowStart,
      requestStartsMs: state.requestStartsMs.filter(
        (startedAt) => startedAt > nowMs - this.profile.requestStarts.windowSeconds * 1_000,
      ),
      reservations: state.reservations.filter((item) => item.status === "active"),
    };
  }

  private acquireStateLock(): { release(): void } {
    const lockPath = `${this.statePath}.lock`;
    mkdirPrivate(path.dirname(lockPath));
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch {
      throw new Error("Production shadow risk state lock is unavailable");
    }
    const token = randomUUID();
    try {
      writeFileSync(descriptor, `${JSON.stringify({
        schema: "friday-relay.production-shadow-risk-lock.v1",
        pid: process.pid,
        token,
      })}\n`);
    } finally {
      closeSync(descriptor);
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
          if (current.token === token) rmSync(lockPath, { force: true });
        } catch {
          // A missing or altered lock is a future self-check failure; never delete it blindly.
        }
      },
    };
  }

  private failClosed<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof ProductionShadowRiskLimitError) throw error;
      if (error instanceof RelayError && error.code === "request_risk_guard_unavailable") throw error;
      throw new RelayError(
        "request_risk_guard_unavailable",
        "Request admission is temporarily unavailable",
        503,
      );
    }
  }
}

class ProductionShadowRiskLimitError extends RelayError {
  readonly retryAfterSeconds: number;
  readonly riskReason: ProductionShadowRiskReason;

  constructor(reason: ProductionShadowRiskReason, retryAfter: number) {
    super("request_risk_limit_exceeded", "Request cannot be admitted at this time", 429);
    this.retryAfterSeconds = retryAfter;
    this.riskReason = reason;
  }
}

function riskLimitError(reason: ProductionShadowRiskReason, retryAfter: number): ProductionShadowRiskLimitError {
  return new ProductionShadowRiskLimitError(reason, Math.max(1, Math.ceil(retryAfter)));
}

function validateProfile(profile: ProductionShadowRiskProfile): void {
  if (
    profile.canaryMaxWeightPercent !== 5
    || profile.requestStarts.limit !== 6
    || profile.requestStarts.windowSeconds !== 60
    || profile.maxInFlight !== 2
    || profile.riskBudgetWindowSeconds !== 86_400
    || profile.leaseTtlSeconds !== 1_800
  ) {
    throw new Error("Production shadow risk profile fixed limits cannot be changed at runtime");
  }
  assertCreditUnits(profile.maxReservedCreditUnits, "max reserved Credit units", false);
}

function validateState(value: unknown, expectedProfileDigest: string): asserts value is ProductionShadowRiskState {
  assertObject(value, "production shadow risk state");
  assertExactKeys(value, [
    "schema",
    "profileDigest",
    "revision",
    "windowStartedAtMs",
    "requestStartsMs",
    "reservations",
    "updatedAt",
  ], "production shadow risk state");
  if (value.schema !== productionShadowRiskStateSchema) throw new Error("Production shadow risk state schema is unsupported");
  if (value.profileDigest !== expectedProfileDigest) throw new Error("Production shadow risk profile digest mismatch");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error("Production shadow risk state revision is invalid");
  if (!Number.isSafeInteger(value.windowStartedAtMs) || Number(value.windowStartedAtMs) < 0) throw new Error("Production shadow risk window is invalid");
  if (!Array.isArray(value.requestStartsMs) || value.requestStartsMs.length > 6) throw new Error("Production shadow request starts are invalid");
  for (const startedAt of value.requestStartsMs) {
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error("Production shadow request start is invalid");
  }
  if (!Array.isArray(value.reservations) || value.reservations.length > maximumDailyReservationRecords) {
    throw new Error("Production shadow risk reservations are invalid");
  }
  const ids = new Set<string>();
  for (const reservation of value.reservations) {
    validateReservation(reservation);
    if (ids.has(reservation.id)) throw new Error("Production shadow risk reservation ids must be unique");
    ids.add(reservation.id);
  }
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) throw new Error("Production shadow risk update time is invalid");
}

function validateReservation(value: unknown): asserts value is RiskReservationState {
  assertObject(value, "production shadow risk reservation");
  assertExactKeys(value, [
    "id",
    "status",
    "reservedCreditUnits",
    "settledCreditUnits",
    "acquiredAtMs",
    "expiresAtMs",
    "terminalAtMs",
    "terminalEvidenceDigest",
  ], "production shadow risk reservation");
  if (!reservationPattern.test(String(value.id ?? ""))) throw new Error("Production shadow risk reservation id is invalid");
  if (!["active", "settled", "conservative"].includes(String(value.status))) throw new Error("Production shadow risk reservation status is invalid");
  assertCreditUnits(value.reservedCreditUnits, "reserved Credit units");
  if (value.status === "settled") assertCreditUnits(value.settledCreditUnits, "settled Credit units");
  else if (value.settledCreditUnits !== null) throw new Error("Unsettled risk reservation cannot store settled Credit units");
  for (const field of ["acquiredAtMs", "expiresAtMs"]) {
    if (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0) throw new Error(`Production shadow risk ${field} is invalid`);
  }
  if (Number(value.expiresAtMs) <= Number(value.acquiredAtMs)) throw new Error("Production shadow risk lease expiry is invalid");
  if (value.status === "active") {
    if (value.terminalAtMs !== null || value.terminalEvidenceDigest !== null) throw new Error("Active risk reservation cannot contain terminal evidence");
  } else if (!Number.isSafeInteger(value.terminalAtMs) || Number(value.terminalAtMs) < Number(value.acquiredAtMs)) {
    throw new Error("Terminal risk reservation time is invalid");
  }
  if (value.terminalEvidenceDigest !== null && !digestPattern.test(String(value.terminalEvidenceDigest))) {
    throw new Error("Terminal risk evidence digest is invalid");
  }
}

function mkdirPrivate(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedSet.has(key));
  if (extra) throw new Error(`${name} contains unsupported field: ${extra}`);
  const missing = allowed.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new Error(`${name} is missing required field: ${missing}`);
}

function assertCreditUnits(value: unknown, name: string, allowZero = true): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) throw new Error(`${name} are invalid`);
}

function normalizeNow(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Risk guard time is invalid");
  return now;
}

function utcWindowStart(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function retryAfterSeconds(nowMs: number, retryAtMs: number): number {
  return Math.max(1, Math.ceil((retryAtMs - nowMs) / 1_000));
}
