import { RelayError } from "@frely/core";

const USD_UNITS_PER_CREDIT = 1_000_000n;
export const BILLING_MAX_INT64 = 9_223_372_036_854_775_807n;

export interface FrozenPriceUnits {
  inputPriceUnitsPer1M: bigint;
  cachedInputPriceUnitsPer1M: bigint;
  cacheWritePriceUnitsPer1M: bigint | null;
  outputPriceUnitsPer1M: bigint;
}

export interface InvocationUsageUnits {
  inputTokens: bigint;
  cachedInputTokens: bigint;
  cacheWriteTokens: bigint;
  outputTokens: bigint;
  totalTokens: bigint;
  source: "provider" | "response";
}

export interface InvocationPriceProfileInput extends FrozenPriceUnits {
  status: string;
  tiers: readonly InvocationPriceProfileTierInput[];
}

export interface InvocationPriceProfileTierInput extends FrozenPriceUnits {
  status: string;
  serviceTier: string;
  tierKey: string;
  minInputTokens: bigint;
  maxInputTokens: bigint | null;
}

export interface SelectedFrozenPriceProfile {
  units: FrozenPriceUnits;
  serviceTier: "standard" | "priority";
  tierKey: string;
  snapshotJson: string;
}

export function maximumInvocationChargeUnits(inputTokens: bigint, maxOutputTokens: bigint, price: FrozenPriceUnits): bigint {
  assertNonNegative(inputTokens, "inputTokens");
  assertNonNegative(maxOutputTokens, "maxOutputTokens");
  const worstInputPrice = [
    price.inputPriceUnitsPer1M,
    price.cachedInputPriceUnitsPer1M,
    price.cacheWritePriceUnitsPer1M ?? price.inputPriceUnitsPer1M,
  ].reduce((maximum, candidate) => candidate > maximum ? candidate : maximum, 0n);
  return checkedBillingAdd(
    tokenChargeUnits(inputTokens, worstInputPrice),
    tokenChargeUnits(maxOutputTokens, price.outputPriceUnitsPer1M),
  );
}

export function actualInvocationChargeUnits(usage: InvocationUsageUnits, price: FrozenPriceUnits): bigint {
  validateUsage(usage);
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens;
  if (uncachedInputTokens < 0n) throw new RelayError("invalid_provider_usage", "Input token billing partitions exceed input tokens", 500);
  return [
    tokenChargeUnits(uncachedInputTokens, price.inputPriceUnitsPer1M),
    tokenChargeUnits(usage.cachedInputTokens, price.cachedInputPriceUnitsPer1M),
    tokenChargeUnits(usage.cacheWriteTokens, price.cacheWritePriceUnitsPer1M ?? price.inputPriceUnitsPer1M),
    tokenChargeUnits(usage.outputTokens, price.outputPriceUnitsPer1M),
  ].reduce(checkedBillingAdd, 0n);
}

export function validateUsage(usage: InvocationUsageUnits): void {
  assertNonNegative(usage.inputTokens, "inputTokens");
  assertNonNegative(usage.cachedInputTokens, "cachedInputTokens");
  assertNonNegative(usage.cacheWriteTokens, "cacheWriteTokens");
  assertNonNegative(usage.outputTokens, "outputTokens");
  assertNonNegative(usage.totalTokens, "totalTokens");
  if (usage.totalTokens !== checkedTokenAdd(usage.inputTokens, usage.outputTokens)) throw new RelayError("invalid_provider_usage", "Provider total tokens must equal input plus output tokens", 500);
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens) throw new RelayError("invalid_provider_usage", "Input token billing partitions exceed input tokens", 500);
}

export function parseFrozenPriceUnits(json: string): FrozenPriceUnits {
  let value: unknown;
  try { value = JSON.parse(json) as unknown; } catch { throw new RelayError("invalid_price_snapshot", "Frozen price snapshot is invalid", 500); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("invalid_price_snapshot", "Frozen price snapshot is invalid", 500);
  const record = value as Record<string, unknown>;
  return {
    inputPriceUnitsPer1M: bigintField(record, "inputPriceUnitsPer1M"),
    cachedInputPriceUnitsPer1M: bigintField(record, "cachedInputPriceUnitsPer1M"),
    cacheWritePriceUnitsPer1M: record.cacheWritePriceUnitsPer1M === null ? null : bigintField(record, "cacheWritePriceUnitsPer1M"),
    outputPriceUnitsPer1M: bigintField(record, "outputPriceUnitsPer1M"),
  };
}

export function encodeFrozenPriceUnits(input: FrozenPriceUnits & { serviceTier: string; tierKey: string }): string {
  return JSON.stringify({
    schemaVersion: 1,
    currency: "USD",
    precision: 6,
    serviceTier: input.serviceTier,
    tierKey: input.tierKey,
    inputPriceUnitsPer1M: input.inputPriceUnitsPer1M.toString(),
    cachedInputPriceUnitsPer1M: input.cachedInputPriceUnitsPer1M.toString(),
    cacheWritePriceUnitsPer1M: input.cacheWritePriceUnitsPer1M?.toString() ?? null,
    outputPriceUnitsPer1M: input.outputPriceUnitsPer1M.toString(),
  });
}

export function frozenAccessPointPriceIds(json: string): string[] {
  let value: unknown;
  try { value = JSON.parse(json) as unknown; } catch { throw new RelayError("invalid_price_snapshot", "Frozen AccessPoint price snapshots are invalid", 500); }
  if (!Array.isArray(value)) throw new RelayError("invalid_price_snapshot", "Frozen AccessPoint price snapshots are invalid", 500);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RelayError("invalid_price_snapshot", "Frozen AccessPoint price snapshot is invalid", 500);
    const record = item as Record<string, unknown>;
    if (typeof record.priceId !== "string" || typeof record.snapshotJson !== "string") throw new RelayError("invalid_price_snapshot", "Frozen AccessPoint price identity is invalid", 500);
    parseFrozenPriceUnits(record.snapshotJson);
    return record.priceId;
  });
}

export function encodeFrozenPriceProfile(input: InvocationPriceProfileInput): string {
  if (input.status !== "enabled") throw new RelayError("billable_price_changed", "Billable price is no longer enabled", 409);
  const base = validatedFrozenUnits(input);
  const tiers = input.tiers
    .filter((tier) => tier.status === "enabled")
    .flatMap((tier) => {
      const serviceTier = storedProfileServiceTier(tier.serviceTier);
      if (!serviceTier) return [];
      if (!tier.tierKey || tier.tierKey.length > 100 || tier.minInputTokens < 0n
        || (tier.maxInputTokens !== null && tier.maxInputTokens < tier.minInputTokens)) {
        throw new RelayError("invalid_price_profile", "Frozen price tier identity or bounds are invalid", 500);
      }
      const units = validatedFrozenUnits(tier);
      return [{
        serviceTier,
        tierKey: tier.tierKey,
        minInputTokens: tier.minInputTokens.toString(),
        maxInputTokens: tier.maxInputTokens?.toString() ?? null,
        inputPriceUnitsPer1M: units.inputPriceUnitsPer1M.toString(),
        cachedInputPriceUnitsPer1M: units.cachedInputPriceUnitsPer1M.toString(),
        cacheWritePriceUnitsPer1M: units.cacheWritePriceUnitsPer1M?.toString() ?? null,
        outputPriceUnitsPer1M: units.outputPriceUnitsPer1M.toString(),
      }];
    })
    .sort((left, right) => left.serviceTier.localeCompare(right.serviceTier)
      || compareDecimalStrings(left.minInputTokens, right.minInputTokens)
      || left.tierKey.localeCompare(right.tierKey));
  return JSON.stringify({
    schemaVersion: 1,
    currency: "USD",
    precision: 6,
    base: {
      inputPriceUnitsPer1M: base.inputPriceUnitsPer1M.toString(),
      cachedInputPriceUnitsPer1M: base.cachedInputPriceUnitsPer1M.toString(),
      cacheWritePriceUnitsPer1M: base.cacheWritePriceUnitsPer1M?.toString() ?? null,
      outputPriceUnitsPer1M: base.outputPriceUnitsPer1M.toString(),
    },
    tiers,
  });
}

export function selectFrozenPriceProfile(
  json: string,
  inputTokens: bigint,
  requestedServiceTier: string,
  requireServiceTier: boolean,
): SelectedFrozenPriceProfile {
  assertNonNegative(inputTokens, "inputTokens");
  const profile = parseFrozenPriceProfile(json);
  const requested = normalizedProfileServiceTier(requestedServiceTier);
  const matching = (serviceTier: "standard" | "priority") => profile.tiers
    .filter((tier) => tier.serviceTier === serviceTier
      && tier.minInputTokens <= inputTokens
      && (tier.maxInputTokens === null || tier.maxInputTokens >= inputTokens))
    .sort((left, right) => left.minInputTokens === right.minInputTokens
      ? left.tierKey.localeCompare(right.tierKey)
      : left.minInputTokens > right.minInputTokens ? -1 : 1)[0];
  const requestedTier = matching(requested);
  if (requireServiceTier && requested === "priority" && !requestedTier) {
    throw new RelayError("service_tier_price_not_configured", "No priority price tier is configured for this Provider usage", 500);
  }
  const standardTier = matching("standard");
  const firstStandardInput = profile.tiers
    .filter((tier) => tier.serviceTier === "standard")
    .reduce<bigint | null>((minimum, tier) => minimum === null || tier.minInputTokens < minimum ? tier.minInputTokens : minimum, null);
  const selected = requestedTier ?? standardTier;
  const units = selected?.units ?? (firstStandardInput === null || inputTokens < firstStandardInput ? profile.base : null);
  if (!units) throw new RelayError("price_tier_not_available", "No enabled price tier covers the Provider usage", 500);
  const serviceTier = selected?.serviceTier ?? "standard";
  const tierKey = selected?.tierKey ?? "short_context";
  return { units, serviceTier, tierKey, snapshotJson: encodeFrozenPriceUnits({ ...units, serviceTier, tierKey }) };
}

function parseFrozenPriceProfile(json: string): {
  base: FrozenPriceUnits;
  tiers: Array<{ serviceTier: "standard" | "priority"; tierKey: string; minInputTokens: bigint; maxInputTokens: bigint | null; units: FrozenPriceUnits }>;
} {
  let value: unknown;
  try { value = JSON.parse(json) as unknown; } catch { throw new RelayError("invalid_price_profile", "Frozen price profile is invalid", 500); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("invalid_price_profile", "Frozen price profile is invalid", 500);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.currency !== "USD" || record.precision !== 6
    || !record.base || typeof record.base !== "object" || Array.isArray(record.base) || !Array.isArray(record.tiers)) {
    throw new RelayError("invalid_price_profile", "Frozen price profile contract is invalid", 500);
  }
  const unitsFrom = (candidate: Record<string, unknown>): FrozenPriceUnits => validatedFrozenUnits({
    inputPriceUnitsPer1M: bigintField(candidate, "inputPriceUnitsPer1M"),
    cachedInputPriceUnitsPer1M: bigintField(candidate, "cachedInputPriceUnitsPer1M"),
    cacheWritePriceUnitsPer1M: candidate.cacheWritePriceUnitsPer1M === null ? null : bigintField(candidate, "cacheWritePriceUnitsPer1M"),
    outputPriceUnitsPer1M: bigintField(candidate, "outputPriceUnitsPer1M"),
  });
  const tiers = record.tiers.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RelayError("invalid_price_profile", "Frozen price tier is invalid", 500);
    const tier = item as Record<string, unknown>;
    if ((tier.serviceTier !== "standard" && tier.serviceTier !== "priority")
      || typeof tier.tierKey !== "string" || !tier.tierKey || tier.tierKey.length > 100) {
      throw new RelayError("invalid_price_profile", "Frozen price tier identity is invalid", 500);
    }
    const serviceTier: "standard" | "priority" = tier.serviceTier;
    const minInputTokens = bigintField(tier, "minInputTokens");
    const maxInputTokens = tier.maxInputTokens === null ? null : bigintField(tier, "maxInputTokens");
    if (maxInputTokens !== null && maxInputTokens < minInputTokens) throw new RelayError("invalid_price_profile", "Frozen price tier bounds are invalid", 500);
    return { serviceTier, tierKey: tier.tierKey, minInputTokens, maxInputTokens, units: unitsFrom(tier) };
  });
  return { base: unitsFrom(record.base as Record<string, unknown>), tiers };
}

function validatedFrozenUnits(input: FrozenPriceUnits): FrozenPriceUnits {
  for (const value of [input.inputPriceUnitsPer1M, input.cachedInputPriceUnitsPer1M, input.outputPriceUnitsPer1M]) {
    if (value < 0n || value > BILLING_MAX_INT64) throw new RelayError("invalid_price_profile", "Frozen price units must fit a non-negative signed 64-bit integer", 500);
  }
  if (input.cacheWritePriceUnitsPer1M !== null && (input.cacheWritePriceUnitsPer1M < 0n || input.cacheWritePriceUnitsPer1M > BILLING_MAX_INT64)) {
    throw new RelayError("invalid_price_profile", "Frozen Cache write price units must be null or fit a non-negative signed 64-bit integer", 500);
  }
  return { ...input };
}

function normalizedProfileServiceTier(value: string): "standard" | "priority" {
  return String(value).trim().toLowerCase().replaceAll("-", "_") === "priority" ? "priority" : "standard";
}

function storedProfileServiceTier(value: string): "standard" | "priority" | null {
  const normalized = String(value).trim().toLowerCase().replaceAll("-", "_");
  return normalized === "standard" || normalized === "priority" ? normalized : null;
}

function compareDecimalStrings(left: string, right: string): number {
  return left.length === right.length ? left.localeCompare(right) : left.length - right.length;
}

function tokenChargeUnits(tokens: bigint, priceUnitsPer1M: bigint): bigint {
  if (tokens < 0n || tokens > BILLING_MAX_INT64 || priceUnitsPer1M < 0n || priceUnitsPer1M > BILLING_MAX_INT64) {
    throw new RelayError("invalid_integer_charge", "Tokens and price units must fit non-negative signed 64-bit integers", 500);
  }
  if (tokens === 0n || priceUnitsPer1M === 0n) return 0n;
  const result = (tokens * priceUnitsPer1M + USD_UNITS_PER_CREDIT - 1n) / USD_UNITS_PER_CREDIT;
  if (result > BILLING_MAX_INT64) throw new RelayError("invalid_integer_charge", "Calculated charge exceeds signed 64-bit Billing units", 500);
  return result;
}

function checkedBillingAdd(left: bigint, right: bigint): bigint {
  const result = left + right;
  if (left < 0n || right < 0n || result > BILLING_MAX_INT64) throw new RelayError("invalid_integer_charge", "Calculated charge exceeds signed 64-bit Billing units", 500);
  return result;
}

function checkedTokenAdd(left: bigint, right: bigint): bigint {
  const result = left + right;
  if (left < 0n || right < 0n || result > BILLING_MAX_INT64) throw new RelayError("invalid_provider_usage", "Provider token usage exceeds signed 64-bit storage", 500);
  return result;
}

function bigintField(record: Record<string, unknown>, field: string): bigint {
  const value = record[field];
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new RelayError("invalid_price_snapshot", `${field} is invalid`, 500);
  return BigInt(value);
}

function assertNonNegative(value: bigint, field: string): void {
  if (value < 0n || value > BILLING_MAX_INT64) throw new RelayError("invalid_provider_usage", `${field} must fit a non-negative signed 64-bit integer`, 500);
}
