import type * as applicationModels from "../application-model-contracts.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type PageResult } from "./pagination.js";

export type PlanDefinition = applicationModels.PlansRow;
export type PlanBudgetLimitRow = applicationModels.PlanBudgetLimitsRow;
export type PlanAccessPointPrice = applicationModels.PlanAccessPointPricesRow;
export type PlanAccessPointPriceTier = applicationModels.PlanAccessPointPriceTiersRow;
export type PlanBaseAccessPointPrice = applicationModels.AccessPointPricesRow;
export type PlanBaseAccessPointPriceTier = applicationModels.AccessPointPriceTiersRow;
export type PlanSubscriptionRow = applicationModels.PlanSubscriptionsRow;
export interface TeamPlanSubscriptionDirectoryRow {
  id: string;
  planId: string;
  source: string;
  scopeRef: string;
  priority: number;
  effectiveStart: string;
  effectiveEnd: string | null;
  subscriptionLifecycle: string;
  createdAt: string;
  templateName: string | null;
  templateVersion: number | null;
  billingMode: string | null;
  planStatus: string | null;
  purchaseAmount: number | null;
  durationSeconds: number | null;
  budgetLimitCount: number;
  accessPointCount: number;
  budgetLimitPreviewJson: string;
  accessPointPreviewJson: string;
}
export type TeamPlanStatusFilter = "enabled" | "closed" | "disabled" | "all";
export interface ActivePlanIdentity {
  subscriptionId: string;
  planId: string;
  scopeRef: string;
  source: string;
  priority: number;
  effectiveStart: string;
  effectiveEnd: string | null;
  subscriptionLifecycle: string;
  planName: string;
  planVersion: number;
  billingMode: string;
  purchaseAmount: number;
  durationSeconds: number;
  planStatus: string;
}

export interface PlanDirectoryInput {
  page?: number;
  pageSize?: number;
  query?: string;
  status?: string;
}

export interface PlanDirectoryRow extends PlanDefinition {
  budgetLimitCount: number;
  accessPointCount: number;
  accessPointNames: string[];
  availableCardCount: number;
  activeOrFutureSubscriptionCount: number;
}

export interface PlanCandidate {
  id: string;
  name: string;
  version: number;
  billingMode: string;
  planStatus: string;
}

export interface AdminCardPlanCandidate {
  id: string;
  name: string;
  version: number;
  durationSeconds: number;
}

export interface UserPlanStoreRow {
  id: string;
  name: string;
  version: number;
  description: string | null;
  purchaseAmount: number;
  durationSeconds: number;
  accessPointCount: number;
  paymentListings: UserPlanPaymentListing[];
}

export interface UserPlanPaymentListing {
  id: string;
  planId: string;
  paymentChannelId: string;
  channelDisplayName: string;
  paymentNetwork: string;
  paymentAsset: string;
  settlementMode: string;
  priceAmountUnits: number;
}

export interface PrimaryAmountBudgetLimit {
  limitValue: number;
  windowType: string;
  windowSeconds: number | null;
}

export interface PlanAccessPointRelationRow {
  relationId: string;
  planId: string;
  accessPointId: string;
  ownerId: string;
  name: string;
  description: string | null;
  scopeRef: string;
  apiFamily: string;
  exposedModel: string;
  status: string;
  createdAt: string;
  basePrice: (PlanBaseAccessPointPrice & { tiers: PlanBaseAccessPointPriceTier[] }) | null;
  effectivePrice: {
    source: "access_point" | "plan_access_point";
    price: (PlanBaseAccessPointPrice & { tiers: PlanBaseAccessPointPriceTier[] }) | (PlanAccessPointPrice & { tiers: PlanAccessPointPriceTier[] });
    basePrice: (PlanBaseAccessPointPrice & { tiers: PlanBaseAccessPointPriceTier[] }) | null;
    planAccessPointPrice: (PlanAccessPointPrice & { tiers: PlanAccessPointPriceTier[] }) | null;
  } | null;
}

export interface PlanAccessPointCandidate {
  id: string;
  ownerId: string;
  scopeRef: string;
  name: string;
  description: string | null;
  apiFamily: string;
  exposedModel: string;
  status: string;
  basePrice: (PlanBaseAccessPointPrice & { tiers: PlanBaseAccessPointPriceTier[] }) | null;
}

export interface PlanRelationSummary {
  accessPointCount: number;
  budgetLimitCount: number;
  subscriptionBudgetLimitCount: number;
  userBudgetLimitCount: number;
  tokenBudgetLimitCount: number;
  amountBudgetLimitCount: number;
}
