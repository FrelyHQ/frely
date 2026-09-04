import type {
  AccessPointPriceWorkbenchRow as ApplicationAccessPointPriceWorkbenchRow,
  ProviderCostWorkbenchRow as ApplicationProviderCostWorkbenchRow,
} from "@frely/ui-application/contracts";
import type {
  AccessPointPrice,
  AccessPointPriceWorkbenchInitialRow,
  PriceTierSummary,
  ProviderCostWorkbenchInitialRow,
  ProviderModelCost,
} from "../../../features/pricing";

interface WorkbenchPageInput<Row> {
  items: Row[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type ApplicationProviderModelCost = NonNullable<ApplicationProviderCostWorkbenchRow["enabledCost"]>;
type ApplicationAccessPointPrice = NonNullable<ApplicationAccessPointPriceWorkbenchRow["enabledPrice"]>;
type ApplicationPriceTier =
  | ApplicationProviderModelCost["tiers"][number]
  | ApplicationAccessPointPrice["tiers"][number];

export function providerCostWorkbenchPageData(page: WorkbenchPageInput<ApplicationProviderCostWorkbenchRow>) {
  return {
    items: page.items.map(toProviderWorkbenchRow),
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
  };
}

export function accessPointPriceWorkbenchPageData(page: WorkbenchPageInput<ApplicationAccessPointPriceWorkbenchRow>) {
  return {
    items: page.items.map(toAccessPointWorkbenchRow),
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
  };
}

export function toProviderWorkbenchRow(row: ApplicationProviderCostWorkbenchRow): ProviderCostWorkbenchInitialRow {
  return {
    id: `${row.providerId}:${row.providerModelName}`,
    providerId: row.providerId,
    providerName: row.providerName,
    providerModelName: row.providerModelName,
    displayName: row.displayName,
    modelStatus: row.modelStatus,
    enabledCost: row.enabledCost ? toProviderModelCost(row.enabledCost) : null,
  };
}

export function toAccessPointWorkbenchRow(row: ApplicationAccessPointPriceWorkbenchRow): AccessPointPriceWorkbenchInitialRow {
  const targetLabel = row.targetType === "provider-model"
    ? `${row.targetProviderId ?? "Missing Provider"}:${row.targetProviderModelName ?? "Missing Model"}`
    : row.targetType === "access-point"
      ? row.targetAccessPointName
        ? `AccessPoint:${row.targetAccessPointName}`
        : `Missing AccessPoint:${row.targetId ?? "unknown"}`
      : `${row.targetType}:${row.targetId ?? "unresolved"}`;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    scopeRef: row.scopeRef,
    targetLabel,
    targetReference: row.targetType === "provider-model"
      ? `${row.targetProviderId ?? ""}:${row.targetProviderModelName ?? ""}`
      : row.targetId,
    targetCost: row.targetCost
      ? "providerId" in row.targetCost
        ? toProviderModelCost(row.targetCost)
        : toAccessPointPrice(row.targetCost)
      : null,
    enabledPrice: row.enabledPrice ? toAccessPointPrice(row.enabledPrice) : null,
  };
}

function toProviderModelCost(cost: ApplicationProviderModelCost): ProviderModelCost {
  return {
    id: cost.id,
    providerId: cost.providerId,
    providerModelName: cost.providerModelName,
    inputPer1M: cost.inputPer1M,
    cachedInputPer1M: cost.cachedInputPer1M,
    cacheWritePer1M: cost.cacheWritePer1M,
    outputPer1M: cost.outputPer1M,
    tiers: cost.tiers.map(toPriceTierSummary),
    source: cost.source,
    status: cost.status,
    createdAt: cost.createdAt,
  };
}

function toAccessPointPrice(price: ApplicationAccessPointPrice): AccessPointPrice {
  return {
    id: price.id,
    accessPointId: price.accessPointId,
    inputPer1M: price.inputPer1M,
    cachedInputPer1M: price.cachedInputPer1M,
    cacheWritePer1M: price.cacheWritePer1M,
    outputPer1M: price.outputPer1M,
    tiers: price.tiers.map(toPriceTierSummary),
    status: price.status,
    createdAt: price.createdAt,
  };
}

function toPriceTierSummary(tier: ApplicationPriceTier): PriceTierSummary {
  return {
    serviceTier: tier.serviceTier,
    tierKey: tier.tierKey,
    minInputTokens: tier.minInputTokens,
    maxInputTokens: tier.maxInputTokens,
    inputPer1M: tier.inputPer1M,
    cachedInputPer1M: tier.cachedInputPer1M,
    cacheWritePer1M: tier.cacheWritePer1M,
    outputPer1M: tier.outputPer1M,
    status: tier.status,
  };
}
