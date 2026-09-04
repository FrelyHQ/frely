import path from "node:path";
import type { ShadowRiskOperations, ShadowRiskProfile, ShadowRiskStateStore } from "@frely/application/runtime";
import {
  DisabledProductionShadowRiskGuard,
  fixedProductionShadowRiskProfile,
  productionShadowRiskProfileDigest,
  type AsyncProductionShadowRiskGuardLike,
  ProductionShadowRiskGuard,
  type ProductionShadowRiskGuardLike,
} from "@frely/gateway-core";

const MODE_ENV = "FRIDAY_RELAY_PRODUCTION_SHADOW_RISK_GUARD";
const MAX_UNITS_ENV = "FRIDAY_RELAY_PRODUCTION_SHADOW_MAX_RESERVED_CREDIT_UNITS";

export function productionShadowRiskStatePath(databasePath: string): string {
  return path.join(path.dirname(path.resolve(databasePath)), "production-shadow-risk-guard", "state.json");
}

export function productionShadowRiskGuardFromEnvironment(
  databasePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): ProductionShadowRiskGuardLike {
  const mode = environment[MODE_ENV] ?? "disabled";
  if (mode === "disabled") return new DisabledProductionShadowRiskGuard();
  if (mode !== "enforced") throw new Error(`${MODE_ENV} must be disabled or enforced`);
  if (environment.FRIDAY_RELAY_DEPLOYMENT_ENVIRONMENT !== "review-dev") {
    throw new Error("Production shadow risk guard can only be enforced on review-dev");
  }
  const maxReservedCreditUnits = parseMaxReservedCreditUnits(environment[MAX_UNITS_ENV]);
  const guard = new ProductionShadowRiskGuard({
    statePath: productionShadowRiskStatePath(databasePath),
    profile: fixedProductionShadowRiskProfile(maxReservedCreditUnits),
  });
  guard.selfCheck();
  return guard;
}

export function initializeProductionShadowRiskGuard(
  databasePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): ProductionShadowRiskGuard {
  if (environment.FRIDAY_RELAY_DEPLOYMENT_ENVIRONMENT !== "review-dev") {
    throw new Error("Production shadow risk state can only be initialized on review-dev");
  }
  if (environment[MODE_ENV] !== "enforced") {
    throw new Error(`${MODE_ENV}=enforced is required to initialize production shadow risk state`);
  }
  return ProductionShadowRiskGuard.initialize({
    statePath: productionShadowRiskStatePath(databasePath),
    profile: fixedProductionShadowRiskProfile(parseMaxReservedCreditUnits(environment[MAX_UNITS_ENV])),
  });
}

export function productionShadowRiskGuardFromDatabaseEnvironment(
  operations: ShadowRiskOperations,
  environment: NodeJS.ProcessEnv = process.env,
): AsyncProductionShadowRiskGuardLike {
  const mode = environment[MODE_ENV] ?? "disabled";
  if (mode === "disabled") return new DisabledProductionShadowRiskGuard();
  if (mode !== "enforced") throw new Error(`${MODE_ENV} must be disabled or enforced`);
  assertLlmDevRiskEnvironment(environment);
  return new DatabaseProductionShadowRiskGuard(operations.createShadowRiskStateStore("review-dev", shadowRiskProfile(environment)));
}

export async function initializeDatabaseProductionShadowRiskGuard(
  operations: ShadowRiskOperations,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AsyncProductionShadowRiskGuardLike> {
  assertLlmDevRiskEnvironment(environment);
  if (environment[MODE_ENV] !== "enforced") {
    throw new Error(`${MODE_ENV}=enforced is required to initialize production shadow risk state`);
  }
  const store = operations.createShadowRiskStateStore("review-dev", shadowRiskProfile(environment));
  await store.initialize();
  return new DatabaseProductionShadowRiskGuard(store);
}

export async function inspectDatabaseProductionShadowRiskState(
  operations: ShadowRiskOperations,
  environment: NodeJS.ProcessEnv = process.env,
): ReturnType<ShadowRiskStateStore["inspect"]> {
  assertLlmDevRiskEnvironment(environment);
  return operations.createShadowRiskStateStore("review-dev", shadowRiskProfile(environment)).inspect();
}

function parseMaxReservedCreditUnits(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${MAX_UNITS_ENV} must be a positive integer with no default`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${MAX_UNITS_ENV} must be a safe integer`);
  return parsed;
}

function assertLlmDevRiskEnvironment(environment: NodeJS.ProcessEnv): void {
  if (environment.FRIDAY_RELAY_DEPLOYMENT_ENVIRONMENT !== "review-dev") {
    throw new Error("Production shadow risk state can only be used on review-dev");
  }
}

function shadowRiskProfile(environment: NodeJS.ProcessEnv): ShadowRiskProfile {
  const profile = fixedProductionShadowRiskProfile(parseMaxReservedCreditUnits(environment[MAX_UNITS_ENV]));
  return {
    profileDigest: productionShadowRiskProfileDigest(profile),
    requestStartsLimit: profile.requestStarts.limit,
    requestStartsWindowMs: profile.requestStarts.windowSeconds * 1_000,
    maxInFlight: profile.maxInFlight,
    riskBudgetWindowMs: profile.riskBudgetWindowSeconds * 1_000,
    leaseTtlMs: profile.leaseTtlSeconds * 1_000,
    maxReservedCreditUnits: profile.maxReservedCreditUnits,
  };
}

class DatabaseProductionShadowRiskGuard implements AsyncProductionShadowRiskGuardLike {
  readonly enforced = true;

  constructor(private readonly store: ShadowRiskStateStore) {}

  selfCheck(): Promise<void> {
    return this.store.selfCheck();
  }

  acquire(input: { reservedCreditUnits: number; nowMs?: number }): Promise<import("@frely/gateway-core").AsyncProductionShadowRiskLease> {
    return this.store.acquire(input);
  }
}
