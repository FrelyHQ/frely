import type * as applicationModels from "../application-model-contracts.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type PageResult } from "./pagination.js";

export type ProviderModelCost = applicationModels.ProviderModelCostsRow;
export type ProviderModelCostTier = applicationModels.ProviderModelCostTiersRow;
export type AccessPointPrice = applicationModels.AccessPointPricesRow;
export type AccessPointPriceTier = applicationModels.AccessPointPriceTiersRow;
export type PricingPlanAccessPointPrice = applicationModels.PlanAccessPointPricesRow;

export interface ProviderCostWorkbenchInput {
  page?: number;
  pageSize?: number;
  providerId?: string;
  modelStatus?: string;
  price?: "all" | "missing" | "has-enabled";
  query?: string;
}

export interface ProviderCostWorkbenchRow {
  providerId: string;
  providerName: string;
  providerModelName: string;
  displayName: string;
  modelStatus: string;
  enabledCost: (ProviderModelCost & { tiers: ProviderModelCostTier[] }) | null;
}

export interface ProviderCostWorkbenchPage extends PageResult<ProviderCostWorkbenchRow> {
  missingEnabledCostCount: number;
}

export interface AccessPointPriceWorkbenchInput {
  page?: number;
  pageSize?: number;
  status?: string;
  targetCost?: "all" | "missing" | "has-enabled";
  price?: "all" | "missing" | "has-enabled";
  query?: string;
}

export interface AccessPointPriceWorkbenchRow {
  id: string;
  scopeRef: string;
  name: string;
  description: string | null;
  targetType: string;
  targetId: string | null;
  targetProviderId: string | null;
  targetProviderModelName: string | null;
  status: string;
  targetAccessPointName: string | null;
  enabledPrice: (AccessPointPrice & { tiers: AccessPointPriceTier[] }) | null;
  targetCost: (ProviderModelCost & { tiers: ProviderModelCostTier[] }) | (AccessPointPrice & { tiers: AccessPointPriceTier[] }) | null;
}

export interface AccessPointPriceWorkbenchPage extends PageResult<AccessPointPriceWorkbenchRow> {
  missingEnabledPriceCount: number;
}

export interface PricingWorkbenchSummary {
  providerModelCount: number;
  missingEnabledProviderCostCount: number;
  accessPointCount: number;
  missingEnabledAccessPointPriceCount: number;
}
export interface ScopedAccessPointPriceRow extends AccessPointPrice {
  accessPointName: string;
  accessPointDescription: string | null;
  accessPointScopeRef: string;
}

type ProviderWorkbenchSqlRow = Omit<ProviderCostWorkbenchRow, "enabledCost">;
type AccessPointWorkbenchSqlRow = Omit<AccessPointPriceWorkbenchRow, "enabledPrice" | "targetCost">;
type ProviderCostWithTiers = ProviderModelCost & { tiers: ProviderModelCostTier[] };
type AccessPointPriceWithTiers = AccessPointPrice & { tiers: AccessPointPriceTier[] };
