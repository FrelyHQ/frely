import type { ScopeRef } from "@frely/core";

export type AuthorityProductEffectCode = "team_create_unit" | "team_custom_provider_access" | "user_custom_provider_access";
export interface AuthorityProductTerms { displayName: string; effectCode: AuthorityProductEffectCode; grantUnits: number; purchaseAmountUnits: bigint; grantDurationSeconds: number; maxLifetimePurchasesPerUser: number | null; maxUnconsumedUnitsPerUser: number | null; maxCurrentOwnedTeams: number | null; maxLifetimeCreatedTeams: number | null; refundMode: "none" | "unused_by_owner"; refundDeadlineSeconds: number | null; settlementHoldSeconds: number; sellerScopeRef: ScopeRef; }
export interface AuthorityProductSnapshot extends AuthorityProductTerms { id: string; code: string; version: number; lifecycle: "draft" | "listed" | "closed"; createdByOwnerUserId: string; createdAt: string; updatedAt: string; }
export interface AuthorityPurchaseSnapshot { id: string; productId: string; buyerUserId: string; creditAccountId: string; productCode: string; productVersion: number; productDisplayName: string; effectCode: AuthorityProductEffectCode; grantUnits: number; purchaseAmountUnits: bigint; grantDurationSeconds: number; maxLifetimePurchasesPerUser: number | null; maxUnconsumedUnitsPerUser: number | null; maxCurrentOwnedTeams: number | null; maxLifetimeCreatedTeams: number | null; refundMode: "none" | "unused_by_owner"; refundDeadlineSeconds: number | null; settlementHoldSeconds: number; sellerScopeRef: ScopeRef; idempotencyKeyHash: string; requestHash: string; createdAt: string; }
export interface AuthorityRefundSnapshot { id: string; authorityPurchaseId: string; authorityGrantId: string; actorOwnerUserId: string; reasonCode: string; idempotencyKeyHash: string; requestHash: string; createdAt: string; }
export interface BillingAuthorityPurchaseResult { purchase: AuthorityPurchaseSnapshot; ledgerEventId: string; sellerSettlementRevenueId: string; replayed: boolean; }
export interface BillingAuthorityRefundResult { refund: AuthorityRefundSnapshot; creditLedgerEventId: string; sellerSettlementReversalId: string; replayed: boolean; }
export interface BillingPageResult<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number; }
export interface PlanFinancialTermsDecision { billingMode: "prepaid" | "paygo"; purchaseAmount: number; purchaseAmountUnits: bigint; }
export interface PlanSubscriptionPurchaseFunding { accountId: string; actorUserId: string; planId: string; sellerScopeRef: ScopeRef; billingMode: "prepaid" | "paygo"; amountPerUnit: bigint; unitCount: number; startingBalance: bigint; }
export interface PlanCommerceReferenceFacts { hasHistoricalReferences: boolean; hasOutstandingEntitlements: boolean; availableCardCount: number; activeOrFutureSubscriptionCount: number; }
export interface PlanAccessPointPriceTierInput { serviceTier?: string; tierKey?: string; minInputTokens: number; maxInputTokens?: number | null; inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M?: number | null; outputPer1M: number; status?: string; createdAt?: string; updatedAt?: string; }
export interface PlanAccessPointPriceOverride { accessPointId: string; inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M?: number | null; outputPer1M: number; tiers?: PlanAccessPointPriceTierInput[]; }

export interface BillingCommerceContextQueries {
  getAuthorityProduct(productId: string): Promise<AuthorityProductSnapshot | undefined>;
  findCurrentPersonalProviderProduct(): Promise<AuthorityProductSnapshot | undefined>;
  getAuthorityPurchase(purchaseId: string): Promise<AuthorityPurchaseSnapshot | undefined>;
  findAuthorityPurchaseReplay(input: { buyerUserId: string; idempotencyKey: string; requestShape: unknown }): Promise<AuthorityPurchaseSnapshot | undefined>;
  pageAuthorityProducts(page?: number, requestedPageSize?: number, purchasableOnly?: boolean): Promise<BillingPageResult<AuthorityProductSnapshot>>;
  searchTeamProviderProductCandidates(query?: string, page?: number): Promise<BillingPageResult<{ id: string; code: string; version: number; displayName: string; grantDurationSeconds: number }>>;
  getPlanCommerceReferenceFacts(planId: string, at?: string): Promise<PlanCommerceReferenceFacts>;
  validatePlanFinancialTerms(input: { billingMode: unknown; purchaseAmount: unknown }): PlanFinancialTermsDecision;
  classifyIdentityMigrationUser(userId: string): Promise<{ unsafeReferenceCount: number }>;
}

export interface BillingCommerceContextCommands {
  lockTeamProviderGrantProduct(productId: string): Promise<AuthorityProductSnapshot>;
  createAuthorityProductVersion(input: AuthorityProductTerms & { code: string; actorOwnerUserId: string; requestId?: string | null }): Promise<AuthorityProductSnapshot>;
  updateDraftAuthorityProduct(productId: string, input: AuthorityProductTerms & { actorOwnerUserId: string; requestId?: string | null }): Promise<AuthorityProductSnapshot>;
  listAuthorityProductVersion(productId: string, actorOwnerUserId: string, requestId?: string | null): Promise<AuthorityProductSnapshot>;
  closeAuthorityProduct(productId: string, actorOwnerUserId: string, requestId?: string | null): Promise<AuthorityProductSnapshot>;
  purchaseAuthorityProductFinancialFacts(input: { buyerUserId: string; productId: string; idempotencyKey: string; requestShape: unknown; expectedEffectCode: AuthorityProductEffectCode; authorityUnconsumedUnits: number; requestId?: string | null }): Promise<BillingAuthorityPurchaseResult>;
  findAuthorityRefundReplay(input: { purchaseId: string; actorOwnerUserId: string; reasonCode: string; idempotencyKey: string }): Promise<BillingAuthorityRefundResult | undefined>;
  lockAuthorityRefundCandidate(purchaseId: string): Promise<AuthorityPurchaseSnapshot>;
  refundAuthorityPurchaseFinancialFacts(input: { purchaseId: string; grantId: string; actorOwnerUserId: string; reasonCode: string; idempotencyKey: string; grantWasUnconsumedAndCanceled: true; requestId?: string | null }): Promise<BillingAuthorityRefundResult>;
  lockPlanSubscriptionPurchaseFunding(input: { accountId: string; planId: string; unitCount: number; actorUserId: string }): Promise<PlanSubscriptionPurchaseFunding>;
  completePlanSubscriptionPurchaseFunding(funding: PlanSubscriptionPurchaseFunding, subscriptions: ReadonlyArray<{ id: string; effectiveStart: string; effectiveEnd: string | null }>): Promise<string[]>;
  appendPlanAccessPointPriceOverrides(planId: string, overrides: ReadonlyArray<PlanAccessPointPriceOverride>): Promise<void>;
  configurePersonalAccessPointZeroPrice(input: { planId: string; accessPointId: string; actorUserId: string; requestId?: string | null }): Promise<{ accessPointPriceId: string; planAccessPointPriceId: string }>;
  ensurePersonalProviderModelZeroCost(input: { providerId: string; providerModelName: string; actorUserId: string; requestId?: string | null }): Promise<string>;
}

type AssertBillingCommerceCapabilitiesDisjoint<Value extends never> = Value;
type _BillingCommerceCapabilitiesDisjoint = AssertBillingCommerceCapabilitiesDisjoint<Extract<keyof BillingCommerceContextQueries, keyof BillingCommerceContextCommands>>;
