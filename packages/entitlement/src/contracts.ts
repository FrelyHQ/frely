import type { ScopeRef } from "@frely/core";
import type { ApiKeyPlanSourceRestrictionCandidatePage, ApiKeyPlanSourceRestrictionDecision, AccessPointAllowanceDecision, PartnerOperatingDecision, PartnerOperatingEntitlementSnapshot, PlanAccessPointEntitlementSnapshot, PlanDefinitionSnapshot, PlanSourceKey, PlanSubscriptionSnapshot, TeamProviderAccessDecision, TeamProviderAccessStateSnapshot, TeamProviderEntitlementSnapshot } from "./index.js";
import type { PersonalProviderEntitlementPeriodSnapshot, PersonalProviderSlotAccessDecision, PersonalProviderSlotSnapshot } from "./personal-provider-slots.js";

export interface PlanBudgetLimitInput { limitScope: "subscription" | "user"; metric: "tokens" | "amount"; limitValue: number; windowType: "fixed" | "cumulative"; windowSeconds: number | null; }
export interface PlanBudgetLimitSnapshot extends PlanBudgetLimitInput { id: string; planId: string; createdAt: string; }
export interface CreatePlanDefinitionCommand { id?: string; ownerId: string; scopeRef: ScopeRef; name: string; description: string | null; adminNote: string | null; durationSeconds: number; status?: "enabled" | "closed" | "disabled"; catalogStatus?: "listed" | "unlisted"; accessPointIds: string[]; budgetLimits: PlanBudgetLimitInput[]; financialTerms: { billingMode: "prepaid" | "paygo"; purchaseAmount: number; purchaseAmountUnits: bigint }; actorUserId: string; requestId?: string | null; }
export interface RevisePlanDefinitionCommand { name?: string; ownerId?: string; scopeRef?: ScopeRef; description?: string | null; adminNote?: string | null; durationSeconds?: number; status?: "enabled" | "closed" | "disabled"; catalogStatus?: "listed" | "unlisted"; accessPointIds?: string[]; budgetLimits?: PlanBudgetLimitInput[]; financialTerms?: { billingMode: "prepaid" | "paygo"; purchaseAmount: number; purchaseAmountUnits: bigint }; hasHistoricalReferences: boolean; hasOutstandingEntitlements: boolean; actorUserId: string; requestId?: string | null; }
export interface CreatePlanSubscriptionCommand { id?: string; planId: string; scopeRef: ScopeRef; source: string; purchasedByUserId?: string | null; fundingAccountId?: string | null; originCardId?: string | null; priority?: number; effectiveStart?: string; effectiveEnd?: string | null; allowClosedPlan?: boolean; actor: { actorType: "user" | "system"; actorId: string }; auditSource: "owner" | "web" | "system"; requestId?: string | null; }
export interface ReviseSubscriptionCompatibilityCommand { planId?: string; source?: string; scopeRef?: ScopeRef; purchasedByUserId?: string | null; fundingAccountId?: string | null; priority?: number; effectiveStart?: string; effectiveEnd?: string | null; subscriptionLifecycle?: "active" | "canceled"; actorUserId: string; requestId?: string | null; }
export interface TeamProviderEntitlementHistoryRow extends TeamProviderEntitlementSnapshot { buyerEmail: string | null; issuedByEmail: string | null; canceledByEmail: string | null; }
export interface CursorPageResult<T> { items: T[]; pageSize: number; hasMore: boolean; nextCursor: string | null; }

export interface EntitlementContextQueries {
  getPlan(planId: string): Promise<PlanDefinitionSnapshot | undefined>;
  getSubscription(subscriptionId: string): Promise<PlanSubscriptionSnapshot | undefined>;
  listPlanAccessPoints(planId: string): Promise<PlanAccessPointEntitlementSnapshot[]>;
  listPlanBudgetLimitsForPlans(planIds: readonly string[]): Promise<Map<string, PlanBudgetLimitSnapshot[]>>;
  findActivePlanSubscriptions(scopeRef: ScopeRef, at?: string): Promise<PlanSubscriptionSnapshot[]>;
  decideAccessPointAllowance(scopeRef: ScopeRef, at?: string): Promise<AccessPointAllowanceDecision>;
  decideApiKeyPlanSourceRestriction(apiKeyId: string): Promise<ApiKeyPlanSourceRestrictionDecision>;
  pageApiKeyPlanSourceRestrictionCandidates(apiKeyId: string, input?: { query?: string; page?: number; pageSize?: number }, at?: string): Promise<ApiKeyPlanSourceRestrictionCandidatePage>;
  getTeamProviderAccessState(teamId: string, at?: string): Promise<TeamProviderAccessStateSnapshot>;
  getTeamProviderAccessStates(teamIds: readonly string[], at?: string): Promise<ReadonlyMap<string, TeamProviderAccessStateSnapshot>>;
  decideTeamProviderAccess(teamId: string, at?: string): Promise<TeamProviderAccessDecision>;
  decideTeamProviderAccesses(teamIds: readonly string[], at?: string): Promise<ReadonlyMap<string, TeamProviderAccessDecision>>;
  decidePartnerOperating(teamId: string, at?: string): Promise<PartnerOperatingDecision>;
  decidePartnerOperatings(teamIds: readonly string[], at?: string): Promise<ReadonlyMap<string, PartnerOperatingDecision>>;
  decideAccessPointRemovalPlanReferences(accessPointId: string): Promise<Readonly<{ allowed: boolean; enabledPlanId: string | null }>>;
  getTeamProviderEntitlement(entitlementId: string): Promise<TeamProviderEntitlementSnapshot | undefined>;
  getTeamProviderEntitlementForPurchase(purchaseId: string): Promise<TeamProviderEntitlementSnapshot | undefined>;
  cursorTeamProviderEntitlements(teamId: string, cursor?: string, requestedPageSize?: number): Promise<CursorPageResult<TeamProviderEntitlementHistoryRow>>;
  getPersonalProviderEntitlementPeriodForPurchase(purchaseId: string): Promise<PersonalProviderEntitlementPeriodSnapshot | undefined>;
  currentDatabaseTime(): Promise<string>;
  getPersonalProviderSlot(slotId: string, at?: string): Promise<PersonalProviderSlotSnapshot | undefined>;
  getPersonalProviderSlotForProvider(providerId: string, at?: string): Promise<PersonalProviderSlotSnapshot | undefined>;
  pagePersonalProviderSlotsForUser(userId: string, page?: number, pageSize?: number, at?: string): Promise<{ items: PersonalProviderSlotSnapshot[]; page: number; pageSize: number; total: number; totalPages: number }>;
  decidePersonalProviderSlotAccess(slotId: string, userId: string, at?: string): Promise<PersonalProviderSlotAccessDecision>;
  decidePersonalProviderAccess(providerId: string, at?: string): Promise<PersonalProviderSlotAccessDecision>;
  decidePersonalProviderAccesses(providerIds: readonly string[], at?: string): Promise<ReadonlyMap<string, PersonalProviderSlotAccessDecision>>;
}

export interface EntitlementContextCommands {
  createPlanDefinition(command: CreatePlanDefinitionCommand): Promise<PlanDefinitionSnapshot>;
  revisePlanDefinition(planId: string, command: RevisePlanDefinitionCommand): Promise<PlanDefinitionSnapshot>;
  retireUnreferencedPlan(planId: string, input: { hasHistoricalReferences: boolean; actorUserId: string; requestId?: string | null }): Promise<{ retired: boolean }>;
  createSubscription(command: CreatePlanSubscriptionCommand): Promise<PlanSubscriptionSnapshot>;
  createSubscriptionInTransaction(command: CreatePlanSubscriptionCommand): Promise<PlanSubscriptionSnapshot>;
  createSubscriptionUnits(command: Omit<CreatePlanSubscriptionCommand, "effectiveEnd"> & { units: number }): Promise<PlanSubscriptionSnapshot[]>;
  cancelSubscription(subscriptionId: string, input: { actorUserId: string; effectiveEnd?: string; requestId?: string | null }): Promise<PlanSubscriptionSnapshot>;
  reviseSubscriptionCompatibility(subscriptionId: string, command: ReviseSubscriptionCompatibilityCommand): Promise<PlanSubscriptionSnapshot>;
  deleteSubscriptionCompatibility(subscriptionId: string, input: { actorUserId: string; requestId?: string | null }): Promise<boolean>;
  grantTeamProviderEntitlement(input: { teamId: string; product: { id: string; code: string; version: number; displayName: string; durationSeconds: number }; actorOwnerUserId: string; idempotencyKey: string; requestId?: string | null }): Promise<{ entitlement: TeamProviderEntitlementSnapshot; replayed: boolean }>;
  createPurchasedTeamProviderEntitlement(input: { teamId: string; purchaseId: string; productId: string; productCode: string; productVersion: number; productDisplayName: string; buyerUserId: string; durationSeconds: number; effectiveAt: string; purchaseAmountUnits: bigint; requestId?: string | null }): Promise<{ entitlement: TeamProviderEntitlementSnapshot; replayed: boolean }>;
  cancelTeamProviderEntitlement(input: { entitlementId: string; actorOwnerUserId: string; reasonCode: string; requestId?: string | null }): Promise<TeamProviderEntitlementSnapshot>;
  createPartnerOperatingEntitlement(input: { sourceOrderId: string; ownerUserId: string; partnerTeamId: string; partnerPlanId: string; planSubscriptionId: string; effectiveStart: string; effectiveEnd: string; actor: { actorType: "user" | "system"; actorId: string }; requestId?: string | null }): Promise<{ entitlement: PartnerOperatingEntitlementSnapshot; replayed: boolean }>;
  createPurchasedPersonalProviderSlotFulfillment(input: { purchaseId: string; productId: string; productCode: string; productVersion: number; productDisplayName: string; buyerUserId: string; durationSeconds: number; purchaseAmountUnits: bigint; fulfilledAt: string; requestId?: string | null }): Promise<{ slot: PersonalProviderSlotSnapshot; period: PersonalProviderEntitlementPeriodSnapshot; replayed: boolean }>;
  lockPersonalProviderSlotForRenewal(slotId: string, userId: string, admittedAt: string): Promise<PersonalProviderSlotSnapshot>;
  renewPurchasedPersonalProviderSlotFulfillment(input: { slotId: string; purchaseId: string; productId: string; productCode: string; productVersion: number; productDisplayName: string; buyerUserId: string; durationSeconds: number; purchaseAmountUnits: bigint; renewalAdmittedAt: string; fulfilledAt: string; requestId?: string | null }): Promise<{ slot: PersonalProviderSlotSnapshot; period: PersonalProviderEntitlementPeriodSnapshot; replayed: boolean }>;
  requireActivePersonalProviderSlot(slotId: string, userId: string, at?: string): Promise<PersonalProviderSlotSnapshot>;
  includePersonalAccessPointInManagedPlan(input: { slotId: string; accessPointId: string; at?: string }): Promise<void>;
  detachPersonalAccessPointFromManagedPlan(input: { slotId: string; accessPointId: string }): Promise<void>;
  bindPersonalProviderToSlot(input: { slotId: string; userId: string; providerId: string; at?: string }): Promise<PersonalProviderSlotSnapshot>;
  finalizePersonalProviderSlotRetention(input: { slotId: string; at?: string; initiatedBy?: string | null; requestId?: string | null }): Promise<{ slot: PersonalProviderSlotSnapshot; replayed: boolean }>;
  replaceApiKeyPlanSourceRestriction(input: {
    apiKeyId: string;
    ownerUserId: string;
    mode: "all" | "restricted";
    sourceKeys: readonly PlanSourceKey[];
    teamScopeRefs: readonly ScopeRef[];
    actor: { actorType: "user"; actorId: string };
    auditSource: "web" | "owner";
    requestId?: string | null;
  }): Promise<ApiKeyPlanSourceRestrictionDecision>;
}

type AssertEntitlementCapabilitiesDisjoint<Value extends never> = Value;
type _EntitlementCapabilitiesDisjoint = AssertEntitlementCapabilitiesDisjoint<Extract<keyof EntitlementContextQueries, keyof EntitlementContextCommands>>;
