import type { ScopeRef } from "@frely/core";
import type * as applicationModels from "../application-model-contracts.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type PageResult } from "./pagination.js";

export type AccessPoint = applicationModels.AccessPointsRow;
export type UserBaseAccessPointPrice = applicationModels.AccessPointPricesRow;
export type UserBaseAccessPointPriceTier = applicationModels.AccessPointPriceTiersRow;
export type UserPlanAccessPointPrice = applicationModels.PlanAccessPointPricesRow;
export type UserPlanAccessPointPriceTier = applicationModels.PlanAccessPointPriceTiersRow;

export interface AccessPointDirectoryInput { query?: string; page?: number; pageSize?: number; }
export interface AccessPointCandidate { id: string; name: string; description: string | null; scopeRef: string; exposedModel: string; status: string; }
export interface UserAvailableModelDirectoryInput { query?: string; page?: number; pageSize?: number; }
export interface UserAvailableModelDirectoryRow {
  accessPointId: string;
  displayName: string;
  description: string | null;
  apiFamily: string;
  exposedModel: string;
  subscriptionScopeRef: string;
  planId: string;
  planName: string;
  subscriptionId: string;
  effectivePrice: {
    source: "plan_access_point" | "access_point";
    price: (UserPlanAccessPointPrice | UserBaseAccessPointPrice) & { tiers: Array<UserPlanAccessPointPriceTier | UserBaseAccessPointPriceTier> };
    basePrice: (UserBaseAccessPointPrice & { tiers: UserBaseAccessPointPriceTier[] }) | null;
    planAccessPointPrice: (UserPlanAccessPointPrice & { tiers: UserPlanAccessPointPriceTier[] }) | null;
  } | null;
}
export interface UserAvailableModelMetrics { totalModels: number; apiFamilyCount: number; }
export interface ScopedAccessPointDirectoryRow extends AccessPoint {
  requestOverridesJson?: string;
  targetAccessPointName: string | null;
  enabledPrice: UserBaseAccessPointPrice | null;
}
export interface EffectiveTeamAccessPointRow {
  accessPointId: string;
  ownerId: string;
  scopeRef: ScopeRef;
  visibleToScopeRef: ScopeRef;
  displayName: string;
  description: string | null;
  apiFamily: string;
  exposedModel: string;
}
export interface UserAccessOrderDirectoryInput { page?: number; pageSize?: number; exposedModel?: string; }
export interface UserAccessOrderModelRow { exposedModel: string; sourceCount: number; }
export interface UserAccessOrderDirectoryRow {
  id: string;
  exposedModel: string;
  planId: string | null;
  planName: string;
  subscriptionScopeRef: string | null;
  position: number;
  currentSubscriptionId: string | null;
  status: "available" | "unavailable" | "invalid_configuration";
  configurationError: "overlapping_active_subscriptions" | "multiple_entry_access_points" | "entry_access_point_missing" | null;
  accessPoint: { id: string; name: string; description: string | null; exposedModel: string; apiFamily: string } | null;
}
export type UserAccessOrderPage = PageResult<UserAccessOrderDirectoryRow> & {
  previousOrderId: string | null;
  nextOrderId: string | null;
  mode: "replace" | "relative";
};
type ScopedAccessPointSqlRow = AccessPoint & {
  targetAccessPointName: string | null;
  enabledPriceId: string | null;
  enabledPriceAccessPointId: string | null;
  enabledPriceInputPer1M: number | null;
  enabledPriceCachedInputPer1M: number | null;
  enabledPriceCacheWritePer1M: number | null;
  enabledPriceOutputPer1M: number | null;
  enabledPriceStatus: string | null;
  enabledPriceCreatedAt: string | null;
  enabledPriceUpdatedAt: string | null;
};
