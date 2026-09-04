import { RelayError } from "@frely/core";

export const USD_UNITS_PER_CREDIT = 1_000_000n;
export const BASIS_POINTS_PER_WHOLE = 10_000n;

export function parseUsdUnits(value: unknown, field = "amountUnits"): bigint {
  if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/u.test(value)) {
    throw new RelayError("invalid_money_units", `${field} must be a base-10 integer string`, 400);
  }
  const units = BigInt(value);
  assertPgBigInt(units, field);
  return units;
}

export function usdUnitsJson(units: bigint): string {
  assertPgBigInt(units, "amountUnits");
  return units.toString(10);
}

export function formatUsdUnits(units: bigint): string {
  assertPgBigInt(units, "amountUnits");
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / USD_UNITS_PER_CREDIT;
  const fraction = (absolute % USD_UNITS_PER_CREDIT).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction} USD`;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RelayError("invalid_integer_charge", "Charge operands must be non-negative with a positive denominator", 500);
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

export function tokenChargeUnits(tokens: bigint, priceUnitsPer1M: bigint): bigint {
  if (tokens < 0n || priceUnitsPer1M < 0n) throw new RelayError("invalid_integer_charge", "Tokens and price units must be non-negative", 500);
  return ceilDiv(tokens * priceUnitsPer1M, 1_000_000n);
}

export function applyBasisPointsFloor(units: bigint, basisPoints: bigint): bigint {
  if (units < 0n || basisPoints < 0n) throw new RelayError("invalid_basis_points", "Units and basis points must be non-negative", 500);
  return units * basisPoints / BASIS_POINTS_PER_WHOLE;
}

export function assertPgBigInt(value: bigint, field: string): void {
  if (value < -9_223_372_036_854_775_808n || value > 9_223_372_036_854_775_807n) {
    throw new RelayError("money_units_out_of_range", `${field} is outside PostgreSQL BIGINT range`, 400);
  }
}
