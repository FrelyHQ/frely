import type { PriceDraft } from "./form/price-draft";

export type Tone = "good" | "warn" | "bad" | "neutral" | "info";
export type PriceFilter = "all" | "missing" | "has-enabled";
export type ReferenceFilter = "all" | "matched" | "unmatched";

export interface Provider {
  id: string;
  name: string;
}
export interface ProviderModel {
  providerId: string;
  providerModelName: string;
  displayName: string;
  status: string;
}
export interface PriceTierSummary {
  serviceTier?: string;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  status: string;
}
export interface ProviderModelCost {
  id: string;
  providerId: string;
  providerModelName: string;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  tiers?: PriceTierSummary[];
  source: string;
  status: string;
  createdAt: string;
}
export interface AccessPoint {
  id: string;
  scopeRef: string;
  name: string;
  description: string | null;
  targetType: string;
  targetId: string | null;
  targetProviderId: string | null;
  targetProviderModelName: string | null;
  status: string;
}
export interface AccessPointPrice {
  id: string;
  accessPointId: string;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  tiers?: PriceTierSummary[];
  status: string;
  createdAt: string;
}
export interface OpenAiReferenceContextPrice {
  serviceTier: "standard" | "batch" | "flex" | "priority";
  context: "short_context" | "long_context";
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number | null;
  cacheWritePer1M: number | null;
  outputPer1M: number;
}
export interface OpenAiReferencePrice {
  source: "openai-official";
  model: string;
  displayName: string;
  inputPerMillion: number;
  cachedInputPerMillion: number | null;
  cacheWritePerMillion: number | null;
  outputPerMillion: number;
  contextPrices?: OpenAiReferenceContextPrice[];
  sourceUrl: string;
  fetchedAt: string;
}
export interface OpenAiReferencePriceTable {
  source: "openai-official-reference";
  sourceUrl: string;
  fetchedAt: string;
  items: OpenAiReferencePrice[];
}
export interface OwnerProfitSummary {
  salesAmount: number;
  sourceCostAmount: number;
  providerCostAmount: number;
  profitAmount: number;
}
export interface ProviderCostWorkbenchRow {
  id: string;
  providerId: string;
  providerName: string;
  providerModelName: string;
  displayName: string;
  modelStatus: string;
  enabledCost: ProviderModelCost | null;
  referencePrice: OpenAiReferencePrice | null;
  draft: PriceDraft;
}
export interface AccessPointPriceWorkbenchRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  scopeRef: string;
  targetLabel: string;
  targetReference: string | null;
  targetCost: ProviderModelCost | AccessPointPrice | null;
  enabledPrice: AccessPointPrice | null;
  draft: PriceDraft;
}
export type ProviderCostWorkbenchInitialRow = Omit<ProviderCostWorkbenchRow, "referencePrice" | "draft">;
export type AccessPointPriceWorkbenchInitialRow = Omit<AccessPointPriceWorkbenchRow, "draft">;

export interface PricingWorkbenchState {
  providerPage: number;
  providerPageSize: number;
  providerId: string;
  providerModelStatus: string;
  providerPrice: PriceFilter;
  providerQuery: string;
  accessPointPage: number;
  accessPointPageSize: number;
  accessPointStatus: string;
  accessPointTargetCost: PriceFilter;
  accessPointPrice: PriceFilter;
  accessPointQuery: string;
}

export interface PricingWorkbenchPage {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface PricingInitialData {
  providers: Provider[];
  providerModels: ProviderModel[];
  providerModelCosts: ProviderModelCost[];
  accessPoints: AccessPoint[];
  accessPointPrices: AccessPointPrice[];
  globalOwnerProfit: OwnerProfitSummary;
}
