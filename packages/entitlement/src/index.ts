import type { ScopeRef } from "@frely/core";

export * from "./personal-provider-slots.js";

export interface PlanRef { readonly id: string; }
export interface SubscriptionRef { readonly id: string; }
export interface PlanSourceKey { readonly planId: string; readonly subscriptionScopeRef: ScopeRef; }

export interface ApiKeyPlanSourceCandidate {
  readonly planId: string;
  readonly planName: string;
  readonly planVersion: number;
  readonly subscriptionScopeRef: ScopeRef;
  readonly current: boolean;
  readonly selected: boolean;
}

export interface ApiKeyTeamScopeCandidate {
  readonly teamId: string;
  readonly teamName: string;
  readonly scopeRef: ScopeRef;
  readonly current: boolean;
  readonly selected: boolean;
}

export interface ApiKeyPlanSourceRestrictionCandidatePage {
  readonly apiKeyId: string;
  readonly sources: readonly ApiKeyPlanSourceCandidate[];
  readonly teams: readonly ApiKeyTeamScopeCandidate[];
  readonly page: number;
  readonly pageSize: number;
  readonly hasMoreSources: boolean;
  readonly hasMoreTeams: boolean;
  readonly nextPage: number | null;
}

export type PlanLifecycle = "enabled" | "closed" | "disabled";
export type SubscriptionLifecycle = "active" | "canceled";

export interface PlanDefinitionSnapshot {
  readonly id: string;
  readonly ownerId: string;
  readonly scopeRef: ScopeRef;
  readonly name: string;
  readonly version: number;
  readonly description: string | null;
  readonly adminNote: string | null;
  readonly billingMode: "prepaid" | "paygo";
  readonly purchaseAmount: number;
  readonly durationSeconds: number;
  readonly planStatus: PlanLifecycle;
  readonly catalogStatus: "listed" | "unlisted";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanSubscriptionSnapshot {
  readonly id: string;
  readonly planId: string;
  readonly source: string;
  readonly scopeRef: ScopeRef;
  readonly purchasedByUserId: string | null;
  readonly fundingAccountId: string | null;
  readonly originCardId: string | null;
  readonly priority: number;
  readonly effectiveStart: string;
  readonly effectiveEnd: string | null;
  readonly subscriptionLifecycle: SubscriptionLifecycle;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanAccessPointEntitlementSnapshot {
  readonly id: string;
  readonly planId: string;
  readonly accessPointId: string;
  readonly createdAt: string;
}

export interface TeamProviderEntitlementSnapshot {
  readonly id: string;
  readonly teamId: string;
  readonly sourceKind: string;
  readonly sourceAuthorityPurchaseId: string | null;
  readonly sourceAuthorityProductId: string | null;
  readonly sourceProductCodeSnapshot: string | null;
  readonly sourceProductVersionSnapshot: number | null;
  readonly sourceProductDisplayNameSnapshot: string | null;
  readonly buyerUserId: string | null;
  readonly issuedByUserId: string | null;
  readonly effectiveStart: string;
  readonly effectiveEnd: string | null;
  readonly lifecycle: string;
  readonly canceledAt: string | null;
  readonly canceledByUserId: string | null;
  readonly cancelReasonCode: string | null;
  readonly createdAt: string;
}

export interface PartnerOperatingEntitlementSnapshot {
  readonly id: string;
  readonly sourceOrderId: string;
  readonly ownerUserId: string;
  readonly partnerTeamId: string;
  readonly partnerPlanId: string;
  readonly planSubscriptionId: string;
  readonly effectiveStart: string;
  readonly effectiveEnd: string;
  readonly lifecycle: string;
  readonly createdAt: string;
}

/** First paid Provider product release: one active paid entitlement grants a
 * bounded 100-AccessPoint allowance for its owning ScopeRef. Multiple active
 * facts are deliberately resolved by maximum, not addition. */
export const PAID_ACCESS_POINT_LIMIT = 100;

export type AccessPointAllowanceDecision =
  | Readonly<{
      kind: "allowed";
      scopeRef: ScopeRef;
      maxAccessPoints: number;
      source: "paid_provider_entitlement";
    }>
  | Readonly<{
      kind: "denied";
      scopeRef: ScopeRef;
      maxAccessPoints: null;
      source: "none";
    }>;

/** Request-time policy snapshot for an API key's Plan source visibility. */
export type ApiKeyPlanSourceRestrictionDecision =
  | Readonly<{
      mode: "all";
      apiKeyId: string;
      sourceKeys: readonly never[];
      teamScopeRefs: readonly never[];
      source: "modernization_03_compatibility";
    }>
  | Readonly<{
      mode: "restricted";
      apiKeyId: string;
      sourceKeys: readonly PlanSourceKey[];
      teamScopeRefs: readonly ScopeRef[];
      source: "api_key_plan_source_restriction";
    }>;

export type TeamProviderAccessDecision =
  | Readonly<{ kind: "allowed"; state: "active" | "permanent"; entitlementId: string; effectiveEnd: string | null }>
  | Readonly<{ kind: "denied"; state: "not_entitled" | "scheduled" | "expired"; nextEffectiveStart: string | null; latestEffectiveEnd: string | null }>;

/** Compatibility projection for existing Admin/Web/Gateway outcomes. */
export type TeamProviderAccessStateSnapshot =
  | Readonly<{ state: "not_entitled"; entitlement: null; nextEntitlement: null; latestEffectiveEnd: null }>
  | Readonly<{ state: "active" | "permanent"; entitlement: TeamProviderEntitlementSnapshot; nextEntitlement: TeamProviderEntitlementSnapshot | null; latestEffectiveEnd: string | null }>
  | Readonly<{ state: "scheduled"; entitlement: null; nextEntitlement: TeamProviderEntitlementSnapshot; latestEffectiveEnd: string | null }>
  | Readonly<{ state: "expired"; entitlement: null; nextEntitlement: null; latestEffectiveEnd: string | null }>;

export type PartnerOperatingDecision =
  | Readonly<{ kind: "allowed"; entitlementId: string; subscriptionId: string; effectiveEnd: string }>
  | Readonly<{ kind: "denied"; state: "not_partner" | "inactive"; latestEffectiveEnd: string | null }>;

export const ENTITLEMENT_CONTEXT_CONTRACT = Object.freeze({
  owner: "plan_subscription_allowance_restriction",
  compatibilityDefaults: Object.freeze({ accessPointAllowance: "paid_provider_bounded", apiKeyPlanSourceRestriction: "all" }),
  persistence: Object.freeze({ plan: "controlled-lifecycle", subscription: "controlled-lifecycle", teamProvider: "controlled-lifecycle", partner: "controlled-lifecycle" }),
});

export function paidAccessPointAllowance(scopeRef: ScopeRef): AccessPointAllowanceDecision {
  return Object.freeze({ kind: "allowed", scopeRef, maxAccessPoints: PAID_ACCESS_POINT_LIMIT, source: "paid_provider_entitlement" });
}

export function deniedAccessPointAllowance(scopeRef: ScopeRef): AccessPointAllowanceDecision {
  return Object.freeze({ kind: "denied", scopeRef, maxAccessPoints: null, source: "none" });
}

export function allApiKeyPlanSources(apiKeyId: string): ApiKeyPlanSourceRestrictionDecision {
  return Object.freeze({ mode: "all", apiKeyId, sourceKeys: Object.freeze([]), teamScopeRefs: Object.freeze([]), source: "modernization_03_compatibility" });
}

export function restrictedApiKeyPlanSources(
  apiKeyId: string,
  sourceKeys: readonly PlanSourceKey[],
  teamScopeRefs: readonly ScopeRef[],
): ApiKeyPlanSourceRestrictionDecision {
  return Object.freeze({
    mode: "restricted",
    apiKeyId,
    sourceKeys: Object.freeze(sourceKeys.map((source) => Object.freeze({ ...source }))),
    teamScopeRefs: Object.freeze([...teamScopeRefs]),
    source: "api_key_plan_source_restriction",
  });
}

export function apiKeyPlanSourceRestrictionWritesEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment.FRIDAY_RELAY_API_KEY_PLAN_SOURCE_RESTRICTION_WRITES_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
