import { RelayError } from "@frely/core";

interface AccessPointPriceLike {
  id: string;
  accessPointId: string;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  selectedServiceTier?: string;
  selectedTierKey?: string;
  selectedTier?: PriceTierSnapshotLike;
  effectiveTiers?: PriceTierSnapshotLike[];
}

interface ProviderModelCostLike {
  id: string;
  providerId: string;
  providerModelName: string;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  source: string;
  selectedServiceTier?: string;
  selectedTierKey?: string;
  selectedTier?: PriceTierSnapshotLike;
  effectiveTiers?: PriceTierSnapshotLike[];
}

interface PriceTierSnapshotLike {
  serviceTier?: string;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
}

export interface BillablePriceSnapshot {
  v: 1;
  id: string;
  ap: string;
  in: number;
  cin: number;
  cacheWritePer1M: number;
  out: number;
}

export interface TieredBillablePriceSnapshot {
  v: 2;
  id: string;
  ap: string;
  selectedServiceTier: string;
  selectedTierKey: string;
  selectedTier: PriceTierSnapshot;
  tiers: PriceTierSnapshot[];
}

export interface CacheWriteBillablePriceSnapshot extends Omit<TieredBillablePriceSnapshot, "v"> { v: 3 }
export interface NullableCacheWriteBillablePriceSnapshot extends Omit<TieredBillablePriceSnapshot, "v"> { v: 4 }

export interface CostPriceSnapshot {
  v: 1;
  id: string;
  p: string;
  m: string;
  in: number;
  cin: number;
  cacheWritePer1M: number;
  out: number;
  src: string;
}

export interface TieredCostPriceSnapshot {
  v: 2;
  id: string;
  p: string;
  m: string;
  src: string;
  selectedServiceTier: string;
  selectedTierKey: string;
  selectedTier: PriceTierSnapshot;
  tiers: PriceTierSnapshot[];
}

export interface CacheWriteCostPriceSnapshot extends Omit<TieredCostPriceSnapshot, "v"> { v: 3 }
export interface NullableCacheWriteCostPriceSnapshot extends Omit<TieredCostPriceSnapshot, "v"> { v: 4 }

export interface PriceTierSnapshot {
  serviceTier: string;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
}

// Billing events store compact immutable price facts. Keep these short keys
// stable within a version; hot-path reporting should use structured columns.
export function encodeBillablePriceSnapshot(price: AccessPointPriceLike): string {
  const selectedTier = price.selectedTier ?? flatTier(price);
  return JSON.stringify({
      v: 4,
      id: price.id,
      ap: price.accessPointId,
      selectedServiceTier: price.selectedServiceTier ?? "standard",
      selectedTierKey: price.selectedTierKey ?? "short_context",
      selectedTier: snapshotTier(selectedTier),
      tiers: (price.effectiveTiers ?? [selectedTier]).map(snapshotTier)
    } satisfies NullableCacheWriteBillablePriceSnapshot);
}

export function encodeCostPriceSnapshot(cost: ProviderModelCostLike): string {
  const selectedTier = cost.selectedTier ?? flatTier(cost);
  return JSON.stringify({
      v: 4,
      id: cost.id,
      p: cost.providerId,
      m: cost.providerModelName,
      src: cost.source,
      selectedServiceTier: cost.selectedServiceTier ?? "standard",
      selectedTierKey: cost.selectedTierKey ?? "short_context",
      selectedTier: snapshotTier(selectedTier),
      tiers: (cost.effectiveTiers ?? [selectedTier]).map(snapshotTier)
    } satisfies NullableCacheWriteCostPriceSnapshot);
}

export function decodeBillablePriceSnapshot(json: string): BillablePriceSnapshot | TieredBillablePriceSnapshot | CacheWriteBillablePriceSnapshot | NullableCacheWriteBillablePriceSnapshot {
  const value = parseSnapshot(json, "billable_price_snapshot_invalid");
  assertVersion(value, "billable_price_snapshot_version_unsupported", [1, 2, 3, 4]);
  if (value.v === 2 || value.v === 3 || value.v === 4) {
    const selectedTier = parseSnapshotTier(value.selectedTier, "billable_price_snapshot_invalid", Number(value.v));
    return {
      v: value.v,
      id: requiredString(value, "id", "billable_price_snapshot_invalid"),
      ap: requiredString(value, "ap", "billable_price_snapshot_invalid"),
      selectedServiceTier: requiredString(value, "selectedServiceTier", "billable_price_snapshot_invalid"),
      selectedTierKey: requiredString(value, "selectedTierKey", "billable_price_snapshot_invalid"),
      selectedTier,
      tiers: parseSnapshotTierArray(value.tiers, "billable_price_snapshot_invalid", Number(value.v))
    } as TieredBillablePriceSnapshot | CacheWriteBillablePriceSnapshot | NullableCacheWriteBillablePriceSnapshot;
  }
  return {
    v: 1,
    id: requiredString(value, "id", "billable_price_snapshot_invalid"),
    ap: requiredString(value, "ap", "billable_price_snapshot_invalid"),
    in: requiredFiniteNumber(value, "in", "billable_price_snapshot_invalid"),
    cin: requiredFiniteNumber(value, "cin", "billable_price_snapshot_invalid"),
    cacheWritePer1M: requiredFiniteNumber(value, "in", "billable_price_snapshot_invalid"),
    out: requiredFiniteNumber(value, "out", "billable_price_snapshot_invalid")
  };
}

export function decodeCostPriceSnapshot(json: string): CostPriceSnapshot | TieredCostPriceSnapshot | CacheWriteCostPriceSnapshot | NullableCacheWriteCostPriceSnapshot {
  const value = parseSnapshot(json, "cost_price_snapshot_invalid");
  assertVersion(value, "cost_price_snapshot_version_unsupported", [1, 2, 3, 4]);
  if (value.v === 2 || value.v === 3 || value.v === 4) {
    const selectedTier = parseSnapshotTier(value.selectedTier, "cost_price_snapshot_invalid", Number(value.v));
    return {
      v: value.v,
      id: requiredString(value, "id", "cost_price_snapshot_invalid"),
      p: requiredString(value, "p", "cost_price_snapshot_invalid"),
      m: requiredString(value, "m", "cost_price_snapshot_invalid"),
      src: requiredString(value, "src", "cost_price_snapshot_invalid"),
      selectedServiceTier: requiredString(value, "selectedServiceTier", "cost_price_snapshot_invalid"),
      selectedTierKey: requiredString(value, "selectedTierKey", "cost_price_snapshot_invalid"),
      selectedTier,
      tiers: parseSnapshotTierArray(value.tiers, "cost_price_snapshot_invalid", Number(value.v))
    } as TieredCostPriceSnapshot | CacheWriteCostPriceSnapshot | NullableCacheWriteCostPriceSnapshot;
  }
  return {
    v: 1,
    id: requiredString(value, "id", "cost_price_snapshot_invalid"),
    p: requiredString(value, "p", "cost_price_snapshot_invalid"),
    m: requiredString(value, "m", "cost_price_snapshot_invalid"),
    in: requiredFiniteNumber(value, "in", "cost_price_snapshot_invalid"),
    cin: requiredFiniteNumber(value, "cin", "cost_price_snapshot_invalid"),
    cacheWritePer1M: requiredFiniteNumber(value, "in", "cost_price_snapshot_invalid"),
    out: requiredFiniteNumber(value, "out", "cost_price_snapshot_invalid"),
    src: requiredString(value, "src", "cost_price_snapshot_invalid")
  };
}

function parseSnapshot(json: string, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("snapshot must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new RelayError(code, error instanceof Error ? error.message : "Invalid price snapshot JSON", 500);
  }
}

function assertVersion(value: Record<string, unknown>, code: string, supported = [1]): void {
  if (!supported.includes(Number(value.v))) throw new RelayError(code, `Unsupported price snapshot version: ${String(value.v)}`, 500);
}

function requiredString(value: Record<string, unknown>, key: string, code: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw new RelayError(code, `Price snapshot field ${key} must be a non-empty string`, 500);
  return field;
}

function requiredFiniteNumber(value: Record<string, unknown>, key: string, code: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) throw new RelayError(code, `Price snapshot field ${key} must be a finite number`, 500);
  return field;
}

function snapshotTier(tier: PriceTierSnapshotLike): PriceTierSnapshot {
  return {
    serviceTier: tier.serviceTier ?? "standard",
    tierKey: tier.tierKey,
    minInputTokens: tier.minInputTokens,
    maxInputTokens: tier.maxInputTokens,
    inputPer1M: tier.inputPer1M,
    cachedInputPer1M: tier.cachedInputPer1M,
    cacheWritePer1M: tier.cacheWritePer1M,
    outputPer1M: tier.outputPer1M
  };
}

function parseSnapshotTier(value: unknown, code: string, version = 2): PriceTierSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError(code, "Price snapshot tier must be an object", 500);
  const record = value as Record<string, unknown>;
  return {
    serviceTier: requiredString(record, "serviceTier", code),
    tierKey: requiredString(record, "tierKey", code),
    minInputTokens: requiredInteger(record, "minInputTokens", code),
    maxInputTokens: nullableInteger(record, "maxInputTokens", code),
    inputPer1M: requiredFiniteNumber(record, "inputPer1M", code),
    cachedInputPer1M: requiredFiniteNumber(record, "cachedInputPer1M", code),
    cacheWritePer1M: version >= 4 ? nullableFiniteNumber(record, "cacheWritePer1M", code) : version === 3 ? requiredFiniteNumber(record, "cacheWritePer1M", code) : requiredFiniteNumber(record, "inputPer1M", code),
    outputPer1M: requiredFiniteNumber(record, "outputPer1M", code)
  };
}

function parseSnapshotTierArray(value: unknown, code: string, version = 2): PriceTierSnapshot[] {
  if (!Array.isArray(value)) throw new RelayError(code, "Price snapshot tiers must be an array", 500);
  return value.map((item) => parseSnapshotTier(item, code, version));
}

function flatTier(price: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number }): PriceTierSnapshotLike {
  return { serviceTier: "standard", tierKey: "short_context", minInputTokens: 0, maxInputTokens: null, inputPer1M: price.inputPer1M, cachedInputPer1M: price.cachedInputPer1M, cacheWritePer1M: price.cacheWritePer1M, outputPer1M: price.outputPer1M };
}

function nullableFiniteNumber(value: Record<string, unknown>, key: string, code: string): number | null {
  if (value[key] === null) return null;
  return requiredFiniteNumber(value, key, code);
}

function requiredInteger(value: Record<string, unknown>, key: string, code: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isInteger(field)) throw new RelayError(code, `Price snapshot field ${key} must be an integer`, 500);
  return field;
}

function nullableInteger(value: Record<string, unknown>, key: string, code: string): number | null {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "number" || !Number.isInteger(field)) throw new RelayError(code, `Price snapshot field ${key} must be null or an integer`, 500);
  return field;
}
