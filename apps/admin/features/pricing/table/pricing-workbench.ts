import type { TableSortDirection } from "@frely/ui/components/table";
import {
  createPriceDraftFromProfile,
  fillSupportedDraftFromReference,
  validatePriceDraft,
  type BasePriceDimensionKey,
  type PriceDimensionKey,
  type PriceDraft,
} from "../form/price-draft";
import type {
  AccessPoint,
  AccessPointPrice,
  AccessPointPriceWorkbenchRow,
  OpenAiReferencePrice,
  PriceFilter,
  ProviderCostWorkbenchRow,
  ProviderModelCost,
  ReferenceFilter,
} from "../types";

export type ProviderCostSortKey =
  | "providerModel"
  | "currentEnabled"
  | "reference"
  | "draftInput"
  | "draftCached"
  | "draftCacheWrite"
  | "draftOutput"
  | "status";
export type AccessPointPriceSortKey =
  | "accessPoint"
  | "target"
  | "targetCost"
  | "currentEnabled"
  | "draftInput"
  | "draftCached"
  | "draftCacheWrite"
  | "draftOutput"
  | "status";
export interface SortState<TKey extends string> {
  key: TKey;
  direction: TableSortDirection;
}

export const providerPriceColumnIds = ["providerModel", "profile", "currentEnabled", "reference", "draft", "status", "actions"] as const;
export const accessPointPriceColumnIds = ["accessPoint", "target", "profile", "targetCost", "currentEnabled", "draft", "status", "actions"] as const;

export function pricingRowId(row: { id: string }): string {
  return row.id;
}
const SORT_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function pageCount(totalRows: number, pageSize: number) {
  return Math.max(1, Math.ceil(totalRows / pageSize));
}
export function pageRows<TRow>(rows: TRow[], page: number, pageSize: number) {
  return rows.slice(page * pageSize, (page + 1) * pageSize);
}

type ProviderCostFilterRow = Pick<
  ProviderCostWorkbenchRow,
  "providerId" | "providerName" | "providerModelName" | "displayName" | "modelStatus" | "enabledCost" | "referencePrice"
>;

export function filterProviderCostRows<TRow extends ProviderCostFilterRow>(
  rows: TRow[],
  filters: {
    providerId: string;
    modelStatus: string;
    price: PriceFilter;
    reference: ReferenceFilter;
    search: string;
  },
) {
  const search = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.providerId !== "all" && row.providerId !== filters.providerId) return false;
    if (filters.modelStatus !== "all" && row.modelStatus !== filters.modelStatus) return false;
    if (filters.price === "missing" && row.enabledCost) return false;
    if (filters.price === "has-enabled" && !row.enabledCost) return false;
    if (filters.reference === "matched" && !row.referencePrice) return false;
    if (filters.reference === "unmatched" && row.referencePrice) return false;
    if (!search) return true;
    return `${row.providerName} ${row.providerId} ${row.providerModelName} ${row.displayName}`.toLowerCase().includes(search);
  });
}
export function sortProviderCostRows(rows: ProviderCostWorkbenchRow[], sort: SortState<ProviderCostSortKey>) {
  return sortRows(rows, sort.direction, (left, right) => {
    switch (sort.key) {
      case "providerModel":
        return compareText(
          `${left.providerName} ${left.displayName} ${left.providerModelName}`,
          `${right.providerName} ${right.displayName} ${right.providerModelName}`,
        );
      case "currentEnabled":
        return compareNullableNumbers(priceTotal(left.enabledCost), priceTotal(right.enabledCost));
      case "reference":
        return compareNullableNumbers(referenceTotal(left.referencePrice), referenceTotal(right.referencePrice));
      case "draftInput":
        return compareNullableNumbers(draftValue(left.draft.inputPerMillionDisplay), draftValue(right.draft.inputPerMillionDisplay));
      case "draftCached":
        return compareNullableNumbers(draftValue(left.draft.cachedInputPerMillionDisplay), draftValue(right.draft.cachedInputPerMillionDisplay));
      case "draftCacheWrite":
        return compareNullableNumbers(draftValue(left.draft.cacheWritePerMillionDisplay), draftValue(right.draft.cacheWritePerMillionDisplay));
      case "draftOutput":
        return compareNullableNumbers(draftValue(left.draft.outputPerMillionDisplay), draftValue(right.draft.outputPerMillionDisplay));
      case "status":
        return compareText(
          `${left.modelStatus} ${left.enabledCost ? "priced" : "missing"}`,
          `${right.modelStatus} ${right.enabledCost ? "priced" : "missing"}`,
        );
    }
  });
}
export function sortAccessPointPriceRows(rows: AccessPointPriceWorkbenchRow[], sort: SortState<AccessPointPriceSortKey>) {
  return sortRows(rows, sort.direction, (left, right) => {
    switch (sort.key) {
      case "accessPoint":
        return compareText(`${left.name} ${left.scopeRef} ${left.id}`, `${right.name} ${right.scopeRef} ${right.id}`);
      case "target":
        return compareText(`${left.targetLabel} ${left.targetReference ?? ""}`, `${right.targetLabel} ${right.targetReference ?? ""}`);
      case "targetCost":
        return compareNullableNumbers(priceTotal(left.targetCost), priceTotal(right.targetCost));
      case "currentEnabled":
        return compareNullableNumbers(priceTotal(left.enabledPrice), priceTotal(right.enabledPrice));
      case "draftInput":
        return compareNullableNumbers(draftValue(left.draft.inputPerMillionDisplay), draftValue(right.draft.inputPerMillionDisplay));
      case "draftCached":
        return compareNullableNumbers(draftValue(left.draft.cachedInputPerMillionDisplay), draftValue(right.draft.cachedInputPerMillionDisplay));
      case "draftCacheWrite":
        return compareNullableNumbers(draftValue(left.draft.cacheWritePerMillionDisplay), draftValue(right.draft.cacheWritePerMillionDisplay));
      case "draftOutput":
        return compareNullableNumbers(draftValue(left.draft.outputPerMillionDisplay), draftValue(right.draft.outputPerMillionDisplay));
      case "status":
        return compareText(`${left.status} ${left.enabledPrice ? "priced" : "missing"}`, `${right.status} ${right.enabledPrice ? "priced" : "missing"}`);
    }
  });
}
function sortRows<TRow extends { id: string }>(rows: TRow[], direction: TableSortDirection, compare: (left: TRow, right: TRow) => number) {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => (compare(left, right) || compareText(left.id, right.id)) * factor);
}
function compareText(left: string, right: string) {
  return SORT_COLLATOR.compare(left, right);
}
function compareNullableNumbers(left: number | null, right: number | null) {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left - right;
}
function priceTotal(price: Pick<ProviderModelCost, "inputPer1M" | "cachedInputPer1M" | "cacheWritePer1M" | "outputPer1M"> | null) {
  return price ? price.inputPer1M + price.cachedInputPer1M + (price.cacheWritePer1M ?? 0) + price.outputPer1M : null;
}
function referenceTotal(price: Pick<OpenAiReferencePrice, "inputPerMillion" | "cachedInputPerMillion" | "cacheWritePerMillion" | "outputPerMillion"> | null) {
  return price ? price.inputPerMillion + (price.cachedInputPerMillion ?? 0) + (price.cacheWritePerMillion ?? 0) + price.outputPerMillion : null;
}
function draftValue(value: string) {
  const numeric = Number(value);
  return value.trim() && Number.isFinite(numeric) ? numeric : null;
}

export function updatePriceDraftField(draft: PriceDraft, field: BasePriceDimensionKey, value: string): PriceDraft {
  return { ...draft, [field]: value };
}
export function updatePriceDraftTier(draft: PriceDraft, tierIndex: number, field: PriceDimensionKey, value: string): PriceDraft {
  const tiers = [...draft.tiers];
  const tier = tiers[tierIndex];
  if (tier) tiers[tierIndex] = { ...tier, [field]: value };
  return { ...draft, tiers };
}
export function fillProviderDraftsFromReference(
  rows: ProviderCostWorkbenchRow[],
  referenceByModel: Map<string, OpenAiReferencePrice>,
  markupPercent: number,
  current: Record<string, PriceDraft>,
  targetIds: Set<string>,
) {
  const next = { ...current };
  for (const row of rows) {
    if (!targetIds.has(row.id)) continue;
    const reference = referenceByModel.get(normalizeModelName(row.providerModelName)) ?? referenceByModel.get(normalizeModelName(row.displayName));
    if (reference) next[row.id] = fillSupportedDraftFromReference(row.draft, reference, markupPercent);
  }
  return next;
}
export function fillAccessPointDraftsFromTargetCosts(
  rows: AccessPointPriceWorkbenchRow[],
  markupPercent: number,
  current: Record<string, PriceDraft>,
  targetIds: Set<string>,
) {
  const next = { ...current };
  for (const row of rows) if (targetIds.has(row.id) && row.targetCost) next[row.id] = createPriceDraftFromProfile(row.targetCost, markupPercent);
  return next;
}
export function countChangedDrafts(previous: Record<string, PriceDraft>, next: Record<string, PriceDraft>) {
  return Object.entries(next).filter(([key, draft]) => JSON.stringify(previous[key]) !== JSON.stringify(draft)).length;
}
export function latestEnabledProviderModelCosts(costs: ProviderModelCost[]) {
  const latest = new Map<string, ProviderModelCost>();
  for (const cost of costs) {
    if (cost.status !== "enabled") continue;
    const key = providerModelKey(cost.providerId, cost.providerModelName);
    const current = latest.get(key);
    if (!current || compareLatestPrice(cost, current) > 0) latest.set(key, cost);
  }
  return latest;
}
export function latestEnabledAccessPointPrices(prices: AccessPointPrice[]) {
  const latest = new Map<string, AccessPointPrice>();
  for (const price of prices) {
    if (price.status !== "enabled") continue;
    const current = latest.get(price.accessPointId);
    if (!current || compareLatestPrice(price, current) > 0) latest.set(price.accessPointId, price);
  }
  return latest;
}
function compareLatestPrice(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
export function buildReferencePriceMap(items: OpenAiReferencePrice[]) {
  const result = new Map<string, OpenAiReferencePrice>();
  for (const item of items) {
    result.set(normalizeModelName(item.model), item);
    result.set(normalizeModelName(item.displayName), item);
  }
  const gpt56 = result.get("gpt-5-6");
  if (gpt56) {
    for (const alias of ["gpt-5-6-luna", "gpt-5-6-sol", "gpt-5-6-terra"]) result.set(alias, gpt56);
  }
  return result;
}
export function resolveAccessPointDirectTarget(
  accessPoint: AccessPoint,
  byId: Map<string, AccessPoint>,
):
  | { type: "provider-model"; providerId: string; providerModelName: string }
  | { type: "access-point"; accessPoint: AccessPoint }
  | null {
  if (accessPoint.targetType === "provider-model" && accessPoint.targetProviderId && accessPoint.targetProviderModelName) {
    return {
      type: "provider-model",
      providerId: accessPoint.targetProviderId,
      providerModelName: accessPoint.targetProviderModelName,
    };
  }
  if (accessPoint.targetType === "access-point" && accessPoint.targetId) {
    const target = byId.get(accessPoint.targetId);
    return target ? { type: "access-point", accessPoint: target } : null;
  }
  return null;
}
export function targetLabelForAccessPoint(accessPoint: AccessPoint) {
  return accessPoint.targetType === "access-point"
    ? accessPoint.targetId
      ? `AccessPoint:${accessPoint.targetId}`
      : "Missing AccessPoint target"
    : "Missing Provider model target";
}
export function providerModelKey(providerId: string, model: string) {
  return `${providerId}:${model}`;
}
export function numericPricePayload(input: PriceDraft) {
  return validatePriceDraft(input).payload;
}
export function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 4,
  }).format(value);
}
export function validMarkupPercent(value: string): number | null {
  const markup = Number(value);
  return Number.isFinite(markup) && markup >= -100 ? markup : null;
}
export function normalizeModelName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
