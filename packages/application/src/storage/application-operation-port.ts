import { type AccessPointRequestOverrides, type AccessPointSelectorId, type AccessPointTargetType, type PlatformRole, type ProviderCredentialFailureReason, type ProviderFailureClass, type ScopeRef, type TeamRole, type UserRoleBindingStatus } from "@frely/core";
import type { AuditInput } from "@frely/audit";
import type {
    RequestCaptureDownloadSlot,
    RequestCaptureSetting,
    RequestLog,
    RequestLogArchive,
    RequestLogArchiveEntry,
    RequestLogArchiveEntryFilter,
    RequestLogListFilter,
} from "@frely/capture";
export type {
    RequestCaptureDownloadSlot,
    RequestCaptureSetting,
    RequestLog,
    RequestLogArchive,
    RequestLogArchiveEntry,
    RequestLogArchiveEntryFilter,
    RequestLogListFilter,
} from "@frely/capture";
import type * as applicationModels from "./application-model-contracts.js";
import type { AuditActor, AuditSource } from "./audit.js";
import type { ApiKeyPlanSourceRestrictionDecision } from "@frely/entitlement";
import { type PlanBudgetLimitInput } from "./plan-budget-limits.js";
import { type DirectoryPageSize } from "./queries/pagination.js";
import type { UserCardInventoryStatusFilter } from "./queries/credits.js";
import type { ActiveDomainBinding } from "./domain-binding.js";
import type { InstancePublicHost } from "./public-host.js";
import { TEAM_DELETION_ARCHIVE_DOMAINS } from "./runtime-domain.js";
export { ACCESS_POINT_DESCRIPTION_MAX_LENGTH, assertCpaInstanceId, assertOrderedPlanSourceConfiguration, billingHistoryReference, cardActivationBatchView, cardActivationCodeSafeView, creditUnitsToUsd, CREDIT_UNITS_PER_USD, DEFAULT_CPA_INSTANCE_ID, isPlanRuntimeEnabled, normalizeAccessPointDescription, normalizeTeamMembershipRoles, TEAM_DELETION_RETENTION_DAYS, TEAM_DELETION_ARCHIVE_DOMAINS, teamMembershipRoles, teamNotEmptyError, usdToCreditUnits, } from "./runtime-domain.js";
export type { BudgetLimitScope, BudgetMetric, BudgetWindowType, PlanBudgetLimitInput } from "./plan-budget-limits.js";
export type Team = applicationModels.TeamsRow;
export type TeamDeletionLifecycle = applicationModels.TeamDeletionLifecyclesRow;
export type TeamDeletionArchiveDomain = (typeof TEAM_DELETION_ARCHIVE_DOMAINS)[number];
export interface TeamDeletionArchiveProof {
    requestId: string;
    teamId: string;
    manifestId: string;
    manifestObjectKey: string;
    manifestSha256: string;
    coverage: TeamDeletionArchiveDomain[];
    archivedAt: string;
}
export type User = applicationModels.UsersRow;
export type WebAuthnUserHandle = applicationModels.WebauthnUserHandlesRow;
export type PasskeyCredential = applicationModels.PasskeyCredentialsRow;
export type WebAuthnCeremony = applicationModels.WebauthnCeremoniesRow;
export interface TeamMemberSummary {
    id: string;
    email: string;
    status: string;
    apiKeyLimit: number;
    createdAt: string;
    membershipRolesJson: string;
    apiKeyCount: number;
    lastSeenAt: string | null;
    isPlatformOwner: number;
}
export type BootstrapOwnerGrant = applicationModels.AuthorityGrantsRow;
export type TeamInviteLink = applicationModels.TeamInviteLinksRow;
export type WebRegistrationSetting = applicationModels.WebRegistrationSettingsRow;
export type TeamMembership = applicationModels.TeamMembershipsRow;
export type ResourcePermission = applicationModels.ResourcePermissionsRow;
export type ApiKey = applicationModels.ApiKeysRow;
export type CpaInstance = applicationModels.CpaInstancesRow;
export type Provider = applicationModels.ProvidersRow;
export interface ProviderDeletionState {
    providerId: string;
    hasAccessPointReferences: boolean;
    hasOnlineBillingHistory: boolean;
    credentialCleared: boolean;
    retained: boolean;
}
export type ProviderBinding = Omit<applicationModels.ProviderBindingsRow, "authMethod" | "credentialOwnership" | "syncStatus"> & {
    authMethod: "oauth" | "api-key" | "credential-import";
    credentialOwnership: "cpa-managed" | "linked";
    syncStatus: "cleared" | "error" | "pending" | "ready";
};
export type ProviderModel = applicationModels.ProviderModelsRow;
export type AccessPoint = applicationModels.AccessPointsRow & {
    requestOverridesJson: string;
};
export type AccessPointTarget = applicationModels.AccessPointTargetsRow;
export interface AccessPointRoutingTargetInput {
    id?: string;
    type: AccessPointTargetType;
    targetAccessPointId?: string | null;
    targetProviderId?: string | null;
    targetProviderModelName?: string | null;
    position: number;
    status?: "enabled" | "disabled";
}
export interface AccessPointRoutingInput {
    selector: {
        id: AccessPointSelectorId;
        behaviorVersion: 1;
        config?: unknown;
    };
    requestOverrides?: unknown;
    targets: AccessPointRoutingTargetInput[];
    expectedRoutingRevision?: number;
}
export interface AccessPointWithRouting extends AccessPoint {
    routing: {
        selector: {
            id: AccessPointSelectorId;
            behaviorVersion: 1;
            config: unknown;
        };
        requestOverrides: AccessPointRequestOverrides;
        targets: AccessPointTarget[];
        routingRevision: number;
    };
}
export type ProviderModelCostTier = applicationModels.ProviderModelCostTiersRow;
export type AccessPointPriceTier = applicationModels.AccessPointPriceTiersRow;
export type PlanAccessPointPriceTier = applicationModels.PlanAccessPointPriceTiersRow;
export type ProviderModelCost = applicationModels.ProviderModelCostsRow & {
    tiers?: ProviderModelCostTier[];
};
export type AccessPointPrice = applicationModels.AccessPointPricesRow & {
    tiers?: AccessPointPriceTier[];
};
export type PlanAccessPointPrice = applicationModels.PlanAccessPointPricesRow & {
    tiers?: PlanAccessPointPriceTier[];
};
export type BillableAccessPointPrice = AccessPointPrice | PlanAccessPointPrice;
export type PlanDefinition = applicationModels.PlansRow;
export type PlanSubscription = applicationModels.PlanSubscriptionsRow;
export type Card = applicationModels.CardsRow;
export type CardTransfer = applicationModels.CardTransfersRow;
export type AdminGrantBatch = applicationModels.AdminGrantBatchesRow;
export type AdminGrantBatchItem = applicationModels.AdminGrantBatchItemsRow;
export type CardActivationBatch = applicationModels.CardActivationBatchesRow;
export type CardActivationCode = applicationModels.CardActivationCodesRow;
export type CardActivationBatchView = Omit<CardActivationBatch, "exportSeedCiphertext" | "exportKeyVersion" | "idempotencyKeyHash" | "requestHash" | "createdByUserId">;
export type CardActivationCodeSafeView = Omit<CardActivationCode, "codeHash">;
export type AdminGrantActionType = "subscription" | "plan_card" | "credit_card";
export interface AdminGrantBatchItemView extends AdminGrantBatchItem {
    targetEmail: string;
}
export interface AdminGrantBatchDetail {
    batch: AdminGrantBatch;
    items: AdminGrantBatchItemView[];
    total: number;
}
export type CardType = "plan" | "credit";
export type CardIssuanceType = "purchase" | "admin_grant" | "external_activation";
export type CardStatus = "available" | "used" | "expired" | "replaced" | "invalidated";
export type CardView = Card & {
    status: CardStatus;
    replacedByCardId: string | null;
};
export type StripeWebhookEvent = applicationModels.StripeWebhookEventsRow;
export type BillingEvent = applicationModels.BillingEventsRow;
export interface PlanCardReplacementResult {
    sourcePlanId: string;
    targetPlanId: string;
    replacedCount: number;
}
export interface CardBreakage {
    cardId: string;
    cardType: CardType;
    amountUnits: number;
    beneficiaryScopeRef: ScopeRef;
    expiresAt: string;
}
export type CardActivationCodeStatus = "available" | "redeemed" | "revoked" | "expired";
export interface CardActivationCodeView extends Omit<CardActivationCode, "codeHash"> {
    status: CardActivationCodeStatus;
}
export interface CardActivationBatchDetail {
    batch: CardActivationBatch;
    codes: CardActivationCodeView[];
    totalCodes: number;
    page: number;
    pageSize: number;
    totalPages: number;
    stats: CardActivationStats;
}
export interface CardActivationStats {
    total: number;
    available: number;
    redeemed: number;
    revoked: number;
    expired: number;
    redemptionRate: number;
}
export interface CardActivationPreview {
    batchId: string;
    referenceCode: string;
    cardType: CardType;
    plan: {
        id: string;
        name: string;
        version: number;
        expiresInDays: number;
    } | null;
    credit: {
        productId: string;
        name: string;
        amountUnits: number;
        expiresInDays: number;
    } | null;
    redeemExpiresAt: string;
}
export interface CardActivationRedeemResult {
    outcome: "created" | "already_redeemed";
    card: Card;
}
export type CardUseResult = {
    card: Card;
    cardType: "plan";
    subscription: PlanSubscription;
} | {
    card: Card;
    cardType: "credit";
    account: CreditAccount;
    ledgerEvent: CreditLedgerEvent;
};
export type SellerSettlementEvent = applicationModels.SellerSettlementEventsRow;
export type UserModelPlanScopeOrder = applicationModels.UserModelPlanScopeOrdersRow;
export type PlanAccessPoint = applicationModels.PlanAccessPointsRow;
export type PlanBudgetLimitRow = applicationModels.PlanBudgetLimitsRow;
export type BudgetPolicy = applicationModels.BudgetPoliciesRow;
export type ScopeBudgetPolicy = applicationModels.ScopeBudgetPoliciesRow;
export type GovernanceBudgetPolicy = applicationModels.GovernanceBudgetPoliciesRow;
export type ScopeGovernanceBudgetPolicy = applicationModels.ScopeGovernanceBudgetPoliciesRow;
export type RateLimitPolicy = applicationModels.RateLimitPoliciesRow;
export type ScopeRateLimitPolicy = applicationModels.ScopeRateLimitPoliciesRow;
export type RequestExecutionLease = applicationModels.RequestExecutionLeasesRow;
export type RequestProviderAttempt = applicationModels.RequestProviderAttemptsRow;
export type IngressPluginSetting = applicationModels.IngressPluginSettingsRow;
export type PipelinePluginSetting = applicationModels.PipelinePluginSettingsRow;
export interface IngressPluginInvocation {
    id: string;
    version: number;
    success: boolean | null;
}
export type PipelinePluginOutcome = "applied" | "noop" | "denied" | "failed" | "fallback";
export interface PipelinePluginInvocation {
    pluginId: string;
    behaviorVersion: number;
    hook: string;
    instanceRevision: string;
    outcome: PipelinePluginOutcome;
}
export interface PipelinePluginSnapshotV1 {
    schemaVersion: 1;
    planRevision: string;
    invocations: PipelinePluginInvocation[];
}
export declare const PENDING_PIPELINE_PLUGIN_SNAPSHOT: PipelinePluginSnapshotV1;
export interface RequestLogResolutionFields {
    teamId?: string | null;
    planId?: string | null;
    planSubscriptionId?: string | null;
    entryAccessPointId?: string | null;
    billingScopeRef?: string | null;
    providerId?: string | null;
    tarModel?: string | null;
}
export type BillingProviderCostArchive = applicationModels.BillingProviderCostArchivesRow & {
    status: "generated" | "uploaded" | "verified" | "purged";
};
export type BillingProviderCostArchiveEntry = applicationModels.BillingProviderCostArchiveEntriesRow;
export type ProviderRetirementArchive = applicationModels.ProviderRetirementArchivesRow;
export type BillingHistoryRef = applicationModels.BillingHistoryRefsRow;
export type BillingAccessPointEdge = applicationModels.BillingAccessPointEdgesRow;
export type BillingProviderCostEvent = applicationModels.BillingProviderCostEventsRow;
export type CreditAccount = applicationModels.CreditAccountsRow;
export type CreditLedgerEvent = applicationModels.CreditLedgerEventsRow;
export type CreditProduct = applicationModels.CreditProductsRow;
export type PaymentChannel = applicationModels.PaymentChannelsRow;
export type PaymentChannelInstructionAttachment = applicationModels.PaymentChannelInstructionAttachmentsRow;
export type PlanPaymentListing = applicationModels.PlanPaymentListingsRow;
export type CreditProductListing = applicationModels.CreditProductListingsRow;
export type CreditTopup = applicationModels.CreditTopupsRow;
export type CreditTopupAttachment = applicationModels.CreditTopupAttachmentsRow;
export type PlanPurchaseOrder = Omit<applicationModels.PlanPurchaseOrdersRow, "paymentKind"> & {
    paymentKind: "credit_balance" | "payment_listing";
};
export type PlanPurchaseOrderStatus = PlanPurchaseOrder["status"];
export interface PlanPurchaseResult {
    order: PlanPurchaseOrder;
    card: Card | null;
    ledgerEvent: CreditLedgerEvent | null;
    subscription: PlanSubscription | null;
    replayed: boolean;
}
export interface PlanPurchaseOrderPage {
    items: PlanPurchaseOrder[];
    page: number;
    pageSize: DirectoryPageSize;
    total: number;
    totalPages: number;
}
export type CreditTransferPolicy = applicationModels.CreditTransferPoliciesRow;
export type AuditLog = applicationModels.AuditLogsRow & {
    metadata: unknown;
};
export type RefreshToken = applicationModels.RefreshTokensRow;
export type OidcAuthorizationCode = applicationModels.OidcAuthorizationCodesRow;
export type OidcAccessToken = applicationModels.OidcAccessTokensRow;
export type OidcRefreshToken = applicationModels.OidcRefreshTokensRow;
export type AbuseRateLimitCounter = applicationModels.AbuseRateLimitCountersRow;
export interface AbuseRateLimitDecision {
    allowed: boolean;
    retryAfterSeconds: number;
}
export interface AbuseRateLimitRule {
    id: string;
    bucket: string;
    subjectHashes: string[];
    limit: number;
    windowSeconds: number;
}
export interface AbuseMultiRateLimitDecision extends AbuseRateLimitDecision {
    deniedRuleIds: string[];
}
export interface TeamInviteLinkCreateResult {
    inviteLink: TeamInviteLink;
    outcome: "created" | "already_active";
}
export type CreditTopupStatus = "pending_payment" | "pending_review" | "expired" | "payment_failed" | "cancelled" | "rejected" | "credited" | "fulfilled" | "reversed";
export type PlanSubscriptionEffectiveState = "current" | "future" | "ended";
export interface PlanSubscriptionListFilter {
    subscriptionId?: string;
    planId?: string;
    scopeType?: "global" | "team" | "user";
    scopeRef?: ScopeRef;
    subscriptionLifecycle?: string;
    source?: string;
    effectiveState?: PlanSubscriptionEffectiveState;
    effectiveAt?: string;
}
export interface PlanSubscriptionCandidate {
    value: string;
    label: string;
    description: string;
    billingMode?: "prepaid" | "paygo";
    purchaseAmount?: number;
    durationSeconds?: number;
    balance?: number;
}
export interface PlanSubscriptionCandidatePage {
    items: PlanSubscriptionCandidate[];
    total: number;
}
export interface EffectiveAccessPointEntry {
    accessPointId: string;
    ownerId: string;
    scopeRef: ScopeRef;
    visibleToScopeRef: ScopeRef;
    displayName: string;
    description: string | null;
    apiFamily: string;
    exposedModel: string;
}
export interface PriceInput {
    inputPer1M: number;
    cachedInputPer1M: number;
    cacheWritePer1M?: number | null;
    outputPer1M: number;
    tiers?: PriceTierInput[];
}
export interface PriceTierInput {
    serviceTier?: PriceServiceTier | string;
    tierKey?: string;
    minInputTokens: number;
    maxInputTokens?: number | null;
    inputPer1M: number;
    cachedInputPer1M: number;
    cacheWritePer1M?: number | null;
    outputPer1M: number;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
}
export type PriceServiceTier = "standard" | "batch" | "flex" | "priority";
export interface PlanAccessPointPriceOverrideInput extends PriceInput {
    accessPointId: string;
}
export interface EffectivePlanAccessPointPrice {
    price: BillableAccessPointPrice;
    source: "access_point" | "plan_access_point";
    basePrice: AccessPointPrice | null;
    planAccessPointPrice: PlanAccessPointPrice | null;
}
export interface EffectivePlanAccessPointPriceBatchItem {
    planId: string;
    accessPointId: string;
    effectivePrice: EffectivePlanAccessPointPrice;
}
export interface ScopeBudgetPolicyAssignment extends ScopeBudgetPolicy {
    budgetPolicy: BudgetPolicy;
}
export type PlanBudgetLimit = Omit<PlanBudgetLimitRow, "windowType"> & Omit<PlanBudgetLimitInput, "windowType"> & {
    windowType: "fixed" | "cumulative";
};
export interface ScopeGovernanceBudgetPolicyAssignment extends ScopeGovernanceBudgetPolicy {
    governanceBudgetPolicy: GovernanceBudgetPolicy;
}
export interface ScopeRateLimitPolicyAssignment extends ScopeRateLimitPolicy {
    rateLimitPolicy: RateLimitPolicy;
}
export interface PlanTemplate {
    id: string;
    ownerId: string;
    scopeRef: ScopeRef;
    name: string;
    version: number;
    description: string | null;
    adminNote: string | null;
    billingMode: PlanBillingMode;
    purchaseAmount: number;
    durationSeconds: number;
    status: PlanStatus;
    catalogStatus: PlanCatalogStatus;
    createdAt: string;
    updatedAt: string;
}
export interface Plan {
    id: string;
    planTemplateId: string;
    source: string;
    scopeRef: ScopeRef;
    purchasedByUserId: string | null;
    fundingAccountId: string | null;
    priority: number;
    effectiveStart: string;
    effectiveEnd: string;
    status: string;
    createdAt: string;
    updatedAt: string;
}
export interface ActivePlanSubscription {
    scopeRef: ScopeRef;
    subscription: PlanSubscription;
    plan: PlanDefinition;
    budgetLimits: PlanBudgetLimit[];
}
export interface BudgetUsageRecovery {
    nextRecoveryAt: string | null;
    nextRecoveryValue: number | null;
    fullRecoveryAt: string | null;
}
export interface BudgetUsageWindowSummary {
    key: string;
    usedTokens: number;
    usedAmount: number;
    recovery: BudgetUsageRecovery;
}
export interface BudgetUsageWindowInput {
    key: string;
    /** Set only when summarizing several scopes in one bounded query. */
    scopeRef?: ScopeRef;
    metric: "tokens" | "amount";
    windowType: "rolling" | "fixed" | "cumulative";
    windowSeconds: number | null;
    start: string;
    end: string;
    periodEnd?: string;
    nextResetAt: string | null;
    endExclusive?: boolean;
}
export interface PlanBudgetUsageLimit {
    limit: PlanBudgetLimit;
    periodStart: string;
    periodEnd: string;
    nextResetAt: string | null;
    usedTokens: number;
    usedAmount: number;
}
export interface PlanBudgetUsageSource extends ActivePlanSubscription {
    applicableModels: string[];
    limits: PlanBudgetUsageLimit[];
}
export type PlanSubscriptionUsageMode = "current" | "at_end" | "not_started";
export interface PlanBudgetLimitUsageView {
    limitScope: "subscription" | "user";
    metric: "tokens" | "amount";
    windowType: "fixed" | "cumulative";
    windowSeconds: number | null;
    periodStart: string | null;
    periodEnd: string | null;
    limitValue: number;
    usedValue: number | null;
    remainingValue: number | null;
    percentUsed: number | null;
    exhausted: boolean | null;
    targetUser: {
        id: string;
        label: string;
    } | null;
    nextResetAt: string | null;
}
export interface PlanBudgetSourceView {
    subscriptionId: string;
    planId: string;
    planName: string;
    planVersion: number;
    billingMode: PlanBillingMode;
    scopeRef: ScopeRef;
    subscriptionLifecycle: string;
    effectiveState: PlanSubscriptionEffectiveState;
    source: string;
    priority: number;
    effectiveStart: string;
    effectiveEnd: string | null;
    usageMode: PlanSubscriptionUsageMode;
    usageReferenceAt: string | null;
    applicableModels: string[];
    limits: PlanBudgetLimitUsageView[];
    userLimitCount: number;
    nextPeriodStart: string | null;
}
export interface OrderedPlanSource {
    order: UserModelPlanScopeOrder;
    subscription: PlanSubscription | null;
    plan: PlanDefinition;
    accessPoint: AccessPoint | null;
    configurationError: OrderedPlanSourceConfigurationError | null;
}
export type OrderedPlanSourceConfigurationError = "overlapping_active_subscriptions" | "multiple_entry_access_points" | "entry_access_point_missing";
export interface OrderedPlanSourceCursor {
    position: number;
    id: string;
}
export interface OrderedPlanSourcePage {
    items: OrderedPlanSource[];
    nextCursor: OrderedPlanSourceCursor | null;
}
export type PlanBillingMode = "prepaid" | "paygo";
export type PlanStatus = "enabled" | "closed" | "disabled";
export type PlanCatalogStatus = "listed" | "unlisted";
export type TeamMembershipRole = "viewer" | "billing" | "manager";
export type ResourcePermissionSubjectType = "user" | "team" | "team_role" | "member";
export type ManagementPermissionAction = "team.read" | "team.member.read" | "team.member.update" | "team.usage.read" | "team.billing.read" | "team.credit.read" | "team.provider.create" | "team.access_point.create" | "team.ap_price.append" | "team.invite_link.create";
export interface TeamDeleteBlocker {
    code: string;
    count: number;
}
export interface TeamDeletionAssessment {
    teamId: string;
    deletable: boolean;
    removableOwnerMembershipId: string | null;
    blockers: TeamDeleteBlocker[];
}
export type TeamDirectorySort = "name" | "status" | "members" | "access" | "ownerPermissions" | "createdAt";
export type TeamDirectorySortDirection = "asc" | "desc";
export type TeamDirectoryRow = Team & {
    memberCount: number;
    teamAccessCount: number;
    inheritedAccessCount: number;
};
export interface TeamDirectoryPage {
    rows: TeamDirectoryRow[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
}
export interface TeamDirectoryMetrics {
    totalTeams: number;
    activeTeams: number;
    activeUsers: number;
    apiKeyCount: number;
    totalTokens: number;
    totalCost: number;
    totalBudget: number;
}
export declare class ApplicationOperationPort {
    resolveEnabledPublicHost(hostname: string): InstancePublicHost | null;
    resolveActiveDomainBinding(hostname: string): ActiveDomainBinding | null;
    pageOwnerApiKeyDirectory(input?: import("./queries/api-keys.js").OwnerApiKeyDirectoryInput, at?: string): import("./queries/pagination.js").PageResult<import("./queries/api-keys.js").OwnerApiKeyDirectoryRow>;
    getOwnerApiKeyDirectoryMetrics(): import("./queries/api-keys.js").OwnerApiKeyDirectoryMetrics;
    pageAdminCreditUserAccounts(input?: import("./queries/credits.js").CreditAccountDirectoryInput): import("./queries/pagination.js").PageResult<import("./queries/credits.js").UserCreditAccountDirectoryRow>;
    pageAdminNonUserCreditAccounts(input?: import("./queries/credits.js").CreditAccountDirectoryInput): import("./queries/pagination.js").PageResult<import("./queries/credits.js").NonUserCreditAccountDirectoryRow>;
    getAdminCreditDirectorySummary(): import("./queries/credits.js").CreditDirectorySummary;
    pageScopedAccessPointDirectory(scopeRef: string, page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/access-points.js").ScopedAccessPointDirectoryRow>;
    pagePlanSubscriptionsForScope(scopeRef: string, page?: number, planStatus?: import("./queries/plans.js").TeamPlanStatusFilter, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/plans.js").TeamPlanSubscriptionDirectoryRow>;
    pageUserAccessOrder(userId: string, input?: {
        page?: number;
        pageSize?: number;
        exposedModel?: string;
    }, at?: string): import("./queries/access-points.js").UserAccessOrderPage;
    pageUserAccessOrderModels(userId: string, page?: number, pageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/access-points.js").UserAccessOrderModelRow>;
    pageUserApiKeyDirectory(userId: string, input?: {
        query?: string;
        page?: number;
        pageSize?: number;
    }, at?: string): import("./queries/pagination.js").PageResult<import("./queries/api-keys.js").UserApiKeyDirectoryRow>;
    getUserApiKeyDetail(userId: string, apiKeyId: string): import("./queries/api-keys.js").UserApiKeyDetailRow | undefined;
    getUserApiKeyDirectoryMetrics(userId: string, at?: string): import("./queries/api-keys.js").UserApiKeyDirectoryMetrics;
    pageUserAvailableModels(userId: string, input?: {
        query?: string;
        page?: number;
        pageSize?: number;
    }, at?: string, restriction?: ApiKeyPlanSourceRestrictionDecision): import("./queries/pagination.js").PageResult<import("./queries/access-points.js").UserAvailableModelDirectoryRow>;
    getUserAvailableModelMetrics(userId: string, at?: string): import("./queries/access-points.js").UserAvailableModelMetrics;
    getActivePlanIdentity(scopeRefs: ScopeRef[], at?: string): import("./queries/plans.js").ActivePlanIdentity | undefined;
    getPrimarySubscriptionAmountLimit(planId: string): PlanBudgetLimit | undefined;
    pageBudgetLimits(planId: string, page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        createdAt: string;
        id: string;
        limitScope: string;
        limitValue: number;
        metric: string;
        planId: string;
        windowSeconds: number | null;
        windowType: string;
    }>;
    pagePlanAccessPoints(planId: string, page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/plans.js").PlanAccessPointRelationRow>;
    pagePlanDirectory(input?: import("./queries/plans.js").PlanDirectoryInput, at?: string): import("./queries/pagination.js").PageResult<import("./queries/plans.js").PlanDirectoryRow>;
    pagePlanSubscriptions(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        createdAt: string;
        effectiveEnd: string | null;
        effectiveStart: string;
        fundingAccountId: string | null;
        id: string;
        originCardId: string | null;
        planId: string;
        priority: number;
        purchasedByUserId: string | null;
        scopeRef: string;
        source: string;
        subscriptionLifecycle: string;
        updatedAt: string;
    }>;
    pageTeamProviderDirectory(scopeRef: string, page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/providers.js").TeamProviderDirectoryRow>;
    pageUserStore(userId: string, page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/plans.js").UserPlanStoreRow>;
    pagePurchasableAuthorityProducts(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        code: string;
        createdAt: string;
        createdByOwnerUserId: string;
        displayName: string;
        effectCode: string;
        grantDurationSeconds: number;
        grantUnits: number;
        id: string;
        lifecycle: string;
        maxCurrentOwnedTeams: number | null;
        maxLifetimeCreatedTeams: number | null;
        maxLifetimePurchasesPerUser: number | null;
        maxUnconsumedUnitsPerUser: number | null;
        purchaseAmountUnits: number;
        refundDeadlineSeconds: number | null;
        refundMode: string;
        sellerScopeRef: string;
        settlementHoldSeconds: number;
        updatedAt: string;
        version: number;
    }>;
    pageAuthorityProducts(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        code: string;
        createdAt: string;
        createdByOwnerUserId: string;
        displayName: string;
        effectCode: string;
        grantDurationSeconds: number;
        grantUnits: number;
        id: string;
        lifecycle: string;
        maxCurrentOwnedTeams: number | null;
        maxLifetimeCreatedTeams: number | null;
        maxLifetimePurchasesPerUser: number | null;
        maxUnconsumedUnitsPerUser: number | null;
        purchaseAmountUnits: number;
        refundDeadlineSeconds: number | null;
        refundMode: string;
        sellerScopeRef: string;
        settlementHoldSeconds: number;
        updatedAt: string;
        version: number;
    }>;
    searchTeamProviderProductCandidates(query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/authority.js").AuthorityProductCandidate>;
    pageResourcePermissions(resourceType: string, resourceId: string, page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/teams.js").ResourcePermissionDirectoryRow>;
    searchUserCandidates(query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/users.js").UserCandidate>;
    searchNonMemberUserCandidates(teamId: string, query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/users.js").UserCandidate>;
    searchTeamCandidates(query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/teams.js").TeamCandidate>;
    searchApiKeyCandidates(query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/api-keys.js").ApiKeyCandidate>;
    searchBudgetPolicyCandidates(query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/budgets.js").BudgetPolicyCandidate>;
    searchGovernanceBudgetPolicyCandidates(query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/budgets.js").BudgetPolicyCandidate>;
    searchAdminCardCandidates(userId: string, query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/plans.js").AdminCardPlanCandidate>;
    searchPlanReplacementCandidates(sourcePlanId: string, query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/plans.js").PlanCandidate>;
    pageProviderDirectory(input?: import("./queries/providers.js").ProviderDirectoryInput): import("./queries/pagination.js").PageResult<import("./queries/providers.js").ProviderDirectoryRow>;
    searchProviderCandidates(query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/providers.js").ProviderCandidate>;
    pageProviderModels(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        createdAt: string;
        displayName: string;
        id: string;
        providerId: string;
        providerModelName: string;
        status: string;
        updatedAt: string;
    }>;
    getProviderDirectorySummary(): import("./queries/providers.js").ProviderDirectorySummary;
    pageAccessPointDirectory(input?: import("./queries/access-points.js").AccessPointDirectoryInput): import("./queries/pagination.js").PageResult<{
        apiFamily: string;
        createdAt: string;
        description: string | null;
        exposedModel: string;
        fallbackOrder: number;
        id: string;
        name: string;
        ownerId: string;
        priority: number;
        routingRevision: number;
        scopeRef: string;
        selectorBehaviorVersion: number;
        selectorConfigJson: string;
        selectorId: string;
        status: string;
        targetId: string | null;
        targetModel: string;
        targetProviderId: string | null;
        targetProviderModelName: string | null;
        targetType: string;
        updatedAt: string;
        weight: number;
    }>;
    searchAccessPointCandidates(query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/access-points.js").AccessPointCandidate>;
    pageEffectiveAccessPointsForTeam(teamId: string, page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/access-points.js").EffectiveTeamAccessPointRow>;
    pageScopedAccessPointPrices(scopeRef: string, page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/pricing.js").ScopedAccessPointPriceRow>;
    pageProviderModelCosts(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        cacheWritePer1M: number | null;
        cachedInputPer1M: number;
        createdAt: string;
        id: string;
        inputPer1M: number;
        outputPer1M: number;
        providerId: string;
        providerModelName: string;
        source: string;
        status: string;
        updatedAt: string;
    }>;
    pageAccessPointPrices(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        accessPointId: string;
        cacheWritePer1M: number | null;
        cachedInputPer1M: number;
        createdAt: string;
        id: string;
        inputPer1M: number;
        outputPer1M: number;
        status: string;
        updatedAt: string;
    }>;
    pagePlanAccessPointPrices(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        accessPointId: string;
        cacheWritePer1M: number | null;
        cachedInputPer1M: number;
        createdAt: string;
        id: string;
        inputPer1M: number;
        outputPer1M: number;
        planId: string;
        status: string;
        updatedAt: string;
    }>;
    pageUserAuthorityGrants(userId: string, page?: number, at?: string, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/authority.js").UserAuthorityGrantRow>;
    hasAvailableUserGrant(userId: string, at?: string): boolean;
    pageUserCreditCatalog(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/credits.js").UserCreditCatalogProduct>;
    pageCreditAccounts(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        balanceSnapLedgerEventId: string | null;
        balanceSnapUnits: number;
        balanceSnapUpdatedAt: string | null;
        createdAt: string;
        id: string;
        scopeRef: string;
        status: string;
        updatedAt: string;
    }>;
    pageCardTransfers(referenceCode?: string, page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/credits.js").UserCardTransferRow>;
    pageCreditProducts(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        adminNote: string | null;
        code: string;
        createdAt: string;
        creditedAmountUnits: number;
        description: string | null;
        displayName: string;
        displayOrder: number;
        id: string;
        status: string;
    }>;
    pagePaymentChannels(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/credits.js").OwnerPaymentChannelRow>;
    pageCreditProductListings(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        createdAt: string;
        id: string;
        paymentChannelId: string;
        priceAmountUnits: number;
        productId: string;
        status: string;
    }>;
    pageCreditTransferPolicies(page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<{
        createdAt: string;
        id: string;
        scopeRef: string;
        transferOutEnabled: boolean;
        updatedAt: string;
        updatedBy: string | null;
    }>;
    searchCreditProductCandidates(query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/credits.js").CreditProductCandidate>;
    searchPaymentChannelCandidates(query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/credits.js").PaymentChannelCandidate>;
    pageUserCardInventory(userId: string, page?: number, at?: string, requestedPageSize?: number, inventoryStatus?: UserCardInventoryStatusFilter): import("./queries/pagination.js").PageResult<import("./queries/credits.js").UserCardInventoryItem>;
    pageUserPlanCards(userId: string, planId: string, page?: number, at?: string, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/credits.js").UserCardRow>;
    pageUserCardTransfers(userId: string, page?: number, requestedPageSize?: number): import("./queries/pagination.js").PageResult<import("./queries/credits.js").UserCardTransferRow>;
    getTopupAttachment(topupId: string, attachmentId: string, userId?: string): import("./queries/credits.js").CreditTopupAttachmentRow | undefined;
    isEnabledPaymentChannelListed(channelId: string): boolean;
    pageTopupAttachments(topupId: string, input?: {
        userId?: string;
        purpose?: string;
        page?: number;
        pageSize?: number;
    }): import("./queries/pagination.js").PageResult<import("./queries/credits.js").CreditTopupAttachmentRow>;
    cursorUserTopups(userId: string, cursor?: string, requestedPageSize?: number): import("./queries/pagination.js").CursorPageResult<import("./queries/credits.js").UserCreditTopupHistoryRow>;
    cursorAdminTopups(cursor?: string, userId?: string, status?: string, requestedPageSize?: number): import("./queries/pagination.js").CursorPageResult<import("./queries/credits.js").AdminCreditTopupHistoryRow>;
    cursorCreditLedger(accountId: string, cursor?: string, requestedPageSize?: number): import("./queries/pagination.js").CursorPageResult<import("./queries/credits.js").CreditLedgerHistoryRow>;
    searchActiveTeamSubscriptionCandidates(input: import("./queries/plan-usage.js").TeamSubscriptionCandidateInput): import("./queries/plan-usage.js").TeamSubscriptionCandidatePage;
    pageTeamMemberUsage(input: import("./queries/plan-usage.js").TeamMemberPlanUsageInput): import("./queries/plan-usage.js").TeamMemberPlanUsagePage;
    pageUserTeamDirectory(userId: string, input?: {
        query?: string;
        page?: number;
        pageSize?: number;
    }): import("./queries/teams.js").UserTeamDirectoryPage;
    userNavigationSummary(userId: string): import("./queries/teams.js").UserTeamNavigationSummary;
    getUserTeamIdentity(userId: string, teamId: string): import("./queries/teams.js").UserTeamIdentityRow | undefined;
    getUserDirectoryFacts(input: {
        memberTeamIds?: string[];
        usageTeamIds?: string[];
        billingTeamIds?: string[];
    }, at?: string): import("./queries/teams.js").UserTeamDirectoryFacts;
    pageTeamMemberSummaries(teamId: string, page?: number, pageSize?: number): import("./queries/users.js").TeamMemberPage;
    pageOwnerUserDirectory(input?: {
        query?: string;
        page?: number;
        pageSize?: number;
        sort?: "user" | "team" | "role" | "status" | "apiKeys" | "lastSeen" | "createdAt";
        direction?: "asc" | "desc";
    }): import("./queries/users.js").OwnerUserDirectoryPage;
    getOwnerUserDirectoryMetrics(): import("./queries/users.js").OwnerUserDirectoryMetrics;
    pageAdminTeamDirectory(input?: {
        query?: string;
        page?: number;
        pageSize?: number;
        sort?: "name" | "status" | "members" | "access" | "ownerPermissions" | "createdAt";
        direction?: "asc" | "desc";
    }): import("./queries/teams.js").TeamDirectoryPage;
    getAdminTeamDirectoryMetrics(at?: string): import("./queries/teams.js").TeamDirectoryMetrics;
    getTeamMemberSummary(teamId: string, userId: string): import("./queries/users.js").TeamMemberSummary | undefined;
    getTeamDetailCounts(teamId: string): import("./queries/teams.js").TeamDetailCounts;
    pagePublicHosts(page?: number, pageSize?: number): import("./public-host.js").InstancePublicHostPage;
    getPublicHostRecord(id: string): InstancePublicHost | undefined;
    findPublicHostRecordByHostname(hostname: string): InstancePublicHost | undefined;
    hasDomainBindingHostname(hostname: string): boolean;
    createPublicHostRecord(row: InstancePublicHost): InstancePublicHost;
    updatePublicHostRecord(input: {
        id: string;
        enabled: boolean;
        updatedByUserId: string;
        updatedAt: string;
    }): InstancePublicHost | undefined;
    deletePublicHostRecord(id: string): boolean;
    listTeams(): Team[];
    getTeam(id: string): Team | undefined;
    getWebRegistrationSetting(): WebRegistrationSetting | undefined;
    updateWebRegistrationSetting(input: {
        defaultTeamId: string | null;
        registrationInviteLinkId: string | null;
        updatedByUserId: string;
    }): WebRegistrationSetting;
    getTeamDeletionLifecycle(id: string): TeamDeletionLifecycle | undefined;
    getActiveTeamDeletion(teamId: string): TeamDeletionLifecycle | undefined;
    isTeamAvailable(teamId: string): boolean;
    requestTeamDeletion(teamId: string, requestedByUserId: string, requestedAt?: string): TeamDeletionLifecycle;
    cancelTeamDeletion(teamId: string, cancelledAt?: string): TeamDeletionLifecycle;
    verifyTeamDeletionArchive(input: TeamDeletionArchiveProof): TeamDeletionLifecycle;
    markTeamDeletionArchiveFailed(requestId: string): TeamDeletionLifecycle;
    markTeamDeletionPurged(requestId: string, purgedAt?: string): TeamDeletionLifecycle;
    listTeamDirectoryPage(input?: {
        query?: string;
        page?: number;
        pageSize?: number;
        sort?: TeamDirectorySort;
        direction?: TeamDirectorySortDirection;
    }): TeamDirectoryPage;
    getTeamDirectoryMetrics(at?: string): TeamDirectoryMetrics;
    listTeamDeleteBlockersForTeams(teamIds: string[]): Map<string, TeamDeleteBlocker[]>;
    upsertTeam(input: Partial<Team> & {
        name: string;
        ownerId?: string;
    }): Team;
    updateTeamInviteEmailDomainPattern(teamId: string, pattern: string | null): Team;
    seedDefaultTeamResourcePermissions(teamId: string): void;
    assessTeamDeletion(teamId: string): TeamDeletionAssessment;
    teamDeleteBlockers(teamId: string): TeamDeleteBlocker[];
    teamPurgeBlockers(teamId: string): TeamDeleteBlocker[];
    deleteTeamIfDeletable(teamId: string): Team;
    deleteTeamIfEmpty(teamId: string): Team;
    deleteTeamAfterVerifiedArchive(teamId: string, requestId: string): Team;
    private collectTeamDeletionBlockers;
    listUsers(): User[];
    listUsersByTeam(teamId: string): User[];
    listTeamMemberSummaries(teamId: string): TeamMemberSummary[];
    getUser(id: string): User | undefined;
    getUserByEmail(email: string): User | undefined;
    upsertUser(input: Partial<User> & {
        teamId: string;
        email: string;
        passwordHash: string;
        createMembership?: boolean;
    }): User;
    createTeamInviteLink(input: {
        teamId: string;
        createdByUserId: string;
        maxUses: number | null;
        activeLimitExempt?: boolean;
        id?: string;
        status?: UserRoleBindingStatus;
        createdAt?: string;
        updatedAt?: string;
    }): TeamInviteLink;
    getOrCreateActiveTeamInviteLink(teamId: string, createdByUserId: string, maxUses: number | null): TeamInviteLinkCreateResult;
    getActiveTeamInviteLinkForCreator(teamId: string, createdByUserId: string): TeamInviteLink | undefined;
    getTeamInviteLink(id: string): TeamInviteLink | undefined;
    listTeamInviteLinks(teamId: string): TeamInviteLink[];
    listTeamInviteLinksByCreator(teamId: string, createdByUserId: string): TeamInviteLink[];
    pageTeamInviteLinks(teamId: string, input?: {
        createdByUserId?: string;
        page?: number;
        pageSize?: number;
    }): import("./queries/pagination.js").PageResult<import("./queries/teams.js").TeamInviteLinkDirectoryRow>;
    disableTeamInviteLink(id: string): TeamInviteLink | undefined;
    consumeTeamInviteLinkUse(id: string): TeamInviteLink;
    listEnabledTeamInviteLinksByCreator(teamId: string, createdByUserId: string): TeamInviteLink[];
    listEnabledNonOwnerTeamInviteLinks(teamId: string, ownerId: string): TeamInviteLink[];
    isTeamMemberInvitesEnabled(teamId: string): boolean;
    grantTeamMembership(teamId: string, userId: string, roles?: TeamMembershipRole[]): TeamMembership;
    ensureFallbackTeamMembership(userId: string, audit: {
        actor: AuditActor;
        source: AuditSource;
        requestId?: string | null;
    }): {
        membership: TeamMembership;
        created: boolean;
    };
    grantTeamMembershipByInvite(teamId: string, userId: string, inviteLinkId: string): TeamMembership;
    private writeTeamMembership;
    deleteTeamMembership(teamId: string, userId: string): TeamMembership | undefined;
    revokeTeamMembership(teamId: string, userId: string): TeamMembership | undefined;
    getTeamMembership(teamId: string, userId: string): TeamMembership | undefined;
    listTeamMemberships(userId: string): TeamMembership[];
    listEnabledTeamMemberships(userId: string): TeamMembership[];
    listAvailableTeamMemberships(userId: string): TeamMembership[];
    updateTeamMembershipRoles(teamId: string, userId: string, roles: TeamMembershipRole[]): TeamMembership | undefined;
    listResourcePermissions(): ResourcePermission[];
    listResourcePermissionsForResource(resourceType: string, resourceId: string): ResourcePermission[];
    upsertResourcePermission(input: {
        resourceType: string;
        resourceId: string;
        action: ManagementPermissionAction | string;
        subjectType: ResourcePermissionSubjectType;
        subjectRef: string;
        subjectRole?: string | null;
        status?: UserRoleBindingStatus;
    }): ResourcePermission;
    updateResourcePermissionStatus(id: string, status: UserRoleBindingStatus): ResourcePermission | undefined;
    private findResourcePermission;
    ensurePlatformOwnerGrant(userId: string): BootstrapOwnerGrant;
    handoverPlatformOwner(input: {
        currentOwnerUserId: string;
        nextOwnerUserId: string;
    }): BootstrapOwnerGrant;
    platformRolesForUser(userId: string): PlatformRole[];
    activeBootstrapPlatformOwnerId(): string | null;
    teamRolesForUser(userId: string): TeamRole[];
    canUserSetCardReferenceCode(userId: string): boolean;
    updateUserAdminNote(id: string, adminNote: string | null): User | undefined;
    updateUserStatus(id: string, status: string): User | undefined;
    updateUserApiKeyLimit(id: string, apiKeyLimit: number): User | undefined;
    updateUserDelegatedCreationPermissions(id: string, input: {
        userCanCreateCustomProvider?: number;
        userCanCreateAccessPoint?: number;
    }): User | undefined;
    getOrCreateWebAuthnUserHandle(input: {
        userId: string;
        candidateHandle: string;
        additionalCandidateHandles?: string[];
    }): WebAuthnUserHandle;
    getWebAuthnUserHandle(userId: string): WebAuthnUserHandle | undefined;
    listPasskeyCredentials(userId: string, rpId?: string): PasskeyCredential[];
    getPasskeyCredential(id: string): PasskeyCredential | undefined;
    getPasskeyCredentialByCredentialId(credentialId: string): PasskeyCredential | undefined;
    createWebAuthnCeremony(input: Omit<WebAuthnCeremony, "createdAt"> & {
        createdAt?: string;
    }, cleanupLimit?: number): WebAuthnCeremony;
    takeWebAuthnCeremony(input: {
        sessionHash: string;
        purpose: WebAuthnCeremony["purpose"];
        surface: WebAuthnCeremony["surface"];
        now?: string;
    }): WebAuthnCeremony | undefined;
    registerUserPasskey(input: {
        userId: string;
        expectedAuthVersion: number;
        credentialId: string;
        publicKey: string;
        signCount: number;
        transportsJson: string;
        deviceType: PasskeyCredential["deviceType"];
        backedUp: number;
        rpId: string;
        name: string;
        source: "web" | "owner";
        requestId?: string | null;
    }): PasskeyCredential;
    listUserPasskeysAudited(input: {
        userId: string;
        expectedAuthVersion: number;
        source: "web" | "owner";
        requestId?: string | null;
    }): PasskeyCredential[];
    renameUserPasskey(input: {
        userId: string;
        expectedAuthVersion: number;
        passkeyId: string;
        name: string;
        source: "web" | "owner";
        requestId?: string | null;
    }): PasskeyCredential;
    completePasskeyLogin(input: {
        userId: string;
        expectedAuthVersion: number;
        passkeyId: string;
        credentialId: string;
        rpId: string;
        expectedUpdatedAt: string;
        expectedSignCount: number;
        newSignCount: number;
        deviceType: PasskeyCredential["deviceType"];
        backedUp: number;
        refreshTokenHash: string;
        refreshTokenExpiresAt: string;
        source: "web" | "owner";
        requestId?: string | null;
        auditMetadata: Record<string, unknown>;
    }): User;
    deleteUserPasskeyAndRotateSession(input: {
        userId: string;
        expectedAuthVersion: number;
        expectedPasswordHash: string;
        passkeyId: string;
        newRefreshTokenHash: string;
        newRefreshTokenExpiresAt: string;
        source: "web" | "owner";
        requestId?: string | null;
    }): User;
    private assertEnabledUserAuthVersion;
    createRefreshToken(input: {
        userId: string;
        tokenHash: string;
        expiresAt: string;
    }): RefreshToken;
    createRefreshTokenForAuthVersion(input: {
        userId: string;
        expectedAuthVersion: number;
        tokenHash: string;
        expiresAt: string;
    }): RefreshToken;
    getRefreshTokenByHash(tokenHash: string): RefreshToken | undefined;
    rotateRefreshToken(input: {
        tokenHash: string;
        userId: string;
        expectedAuthVersion: number;
        replacementTokenHash: string;
        replacementExpiresAt: string;
    }): RefreshToken | undefined;
    revokeRefreshToken(tokenHash: string): void;
    rotateOwnPassword(input: {
        userId: string;
        expectedPasswordHash: string;
        newPasswordHash: string;
        newRefreshTokenHash: string;
        newRefreshTokenExpiresAt: string;
        surface: "web" | "owner";
        requestId?: string | null;
    }): User;
    rotateSystemCredential(input: {
        userId: string;
        newPasswordHash: string;
        reason: "bootstrap" | "development";
    }): User;
    private revokeAllUserCredentials;
    createOidcAuthorizationCode(input: {
        codeHash: string;
        userId: string;
        clientId: string;
        redirectUri: string;
        scope: string;
        codeChallenge: string;
        nonce: string;
        expiresAt: string;
    }): OidcAuthorizationCode;
    getOidcAuthorizationCodeByHash(codeHash: string): OidcAuthorizationCode | undefined;
    exchangeOidcAuthorizationCode(input: {
        codeHash: string;
        clientId: string;
        redirectUri: string;
        codeChallenge: string;
        accessTokenHash: string;
        accessTokenAudience: string;
        accessTokenExpiresAt: string;
        refreshToken?: {
            tokenHash: string;
            familyId: string;
            expiresAt: string;
        };
        now?: string;
    }): {
        authorizationCode: OidcAuthorizationCode;
        accessToken: OidcAccessToken;
        refreshToken: OidcRefreshToken | null;
        user: User;
    };
    getOidcAccessTokenByHash(tokenHash: string): OidcAccessToken | undefined;
    revokeOidcAccessToken(tokenHash: string, clientId: string): void;
    getOidcRefreshTokenByHash(tokenHash: string): OidcRefreshToken | undefined;
    rotateOidcRefreshToken(input: {
        tokenHash: string;
        clientId: string;
        newTokenHash: string;
        accessTokenHash: string;
        accessTokenAudience: string;
        accessTokenExpiresAt: string;
        refreshTokenExpiresAt: string;
        now?: string;
    }): {
        status: "rotated";
        accessToken: OidcAccessToken;
        refreshToken: OidcRefreshToken;
        user: User;
    } | {
        status: "invalid" | "replayed";
    };
    revokeOidcRefreshToken(tokenHash: string, clientId: string): void;
    deleteExpiredOidcState(now?: string): {
        authorizationCodes: number;
        accessTokens: number;
        refreshTokens: number;
    };
    consumeAbuseRateLimit(input: {
        bucket: string;
        subjectHashes: string[];
        limit: number;
        windowSeconds: number;
        nowMs?: number;
    }): AbuseRateLimitDecision;
    consumeAbuseRateLimits(input: {
        rules: AbuseRateLimitRule[];
        nowMs?: number;
        cleanupLimit?: number;
    }): AbuseMultiRateLimitDecision;
    inspectAbuseRateLimit(input: {
        bucket: string;
        subjectHashes: string[];
        limit: number;
        windowSeconds: number;
        nowMs?: number;
    }): AbuseRateLimitDecision;
    deleteExpiredAbuseRateLimits(nowMs?: number, limit?: number): number;
    listApiKeys(userId?: string): ApiKey[];
    getApiKey(id: string): ApiKey | undefined;
    getApiKeyByHash(keyHash: string): ApiKey | undefined;
    listApiKeySummariesByIds(userId: string, ids: string[]): import("./queries/api-keys.js").ApiKeyListSummary[];
    searchTeamProviderPurchaseCandidates(userId: string, query?: string, page?: number): import("./queries/pagination.js").PageResult<import("./queries/teams.js").TeamProviderPurchaseCandidate>;
    cursorTeamProviderEntitlements(teamId: string, cursor?: string, requestedPageSize?: number): import("./queries/pagination.js").CursorPageResult<import("./queries/authority.js").TeamProviderEntitlementHistoryRow>;
    countEnabledApiKeysForUser(userId: string): number;
    createApiKey(input: {
        userId: string;
        name: string;
        keyHash: string;
        keyPrefix: string;
        keyValue: string;
        expiresAt?: string | null;
    }): ApiKey;
    revokeApiKey(id: string): ApiKey | undefined;
    updateApiKeyStatus(id: string, status: "enabled" | "disabled"): ApiKey | undefined;
    listProviders(): Provider[];
    getProvider(id: string): Provider | undefined;
    getProviders(ids: readonly string[]): Provider[];
    listCpaInstances(): CpaInstance[];
    getCpaInstance(id: string): CpaInstance | undefined;
    createCpaInstance(input: {
        id: string;
        name: string;
        status?: "enabled" | "disabled";
    }): CpaInstance;
    updateCpaInstanceStatus(id: string, status: "enabled" | "disabled"): CpaInstance | undefined;
    createProvider(input: Partial<Provider> & {
        id: string;
        name: string;
        kind: string;
        baseUrlResolver: string;
        credentialResolver: string;
        modelsResolver: string;
        ownerId?: string;
        scopeRef?: ScopeRef;
    }): Provider;
    upsertProvider(input: Partial<Provider> & {
        id: string;
        name: string;
        kind: string;
        baseUrlResolver: string;
        credentialResolver: string;
        modelsResolver: string;
        ownerId?: string;
        scopeRef?: ScopeRef;
    }): Provider;
    getProviderBinding(providerId: string): ProviderBinding | undefined;
    upsertProviderBinding(input: Omit<Partial<ProviderBinding>, "providerId"> & Pick<ProviderBinding, "providerId" | "authMethod" | "credentialOwnership" | "syncStatus">): ProviderBinding;
    deleteProviderBinding(providerId: string): boolean;
    listProviderDeletionStates(providerIds?: string[]): ProviderDeletionState[];
    getProviderDeletionState(providerId: string): ProviderDeletionState | null;
    deleteProvider(id: string): boolean;
    listProviderModels(): ProviderModel[];
    upsertProviderModel(input: Partial<ProviderModel> & {
        providerId: string;
        providerModelName: string;
        displayName?: string;
    }): ProviderModel;
    replaceProviderModels(providerId: string, models: Array<{
        providerModelName: string;
        displayName?: string;
        status?: string;
    }>): ProviderModel[];
    listProviderModelCosts(): ProviderModelCost[];
    createProviderModelCost(input: Omit<Partial<ProviderModelCost>, "tiers" | "cacheWritePer1M"> & {
        providerId: string;
        providerModelName: string;
        inputPer1M: number;
        cachedInputPer1M: number;
        cacheWritePer1M?: number | null;
        outputPer1M: number;
        tiers?: PriceTierInput[];
    }): ProviderModelCost;
    findEnabledProviderModelCost(providerId: string, providerModelName: string): ProviderModelCost | undefined;
    findEnabledProviderModelCosts(input: readonly { providerId: string; providerModelName: string }[]): ProviderModelCost[];
    updateProviderModelCostStatus(id: string, status: string): ProviderModelCost | undefined;
    listAccessPointPrices(): AccessPointPrice[];
    createAccessPointPrice(input: Omit<Partial<AccessPointPrice>, "tiers" | "cacheWritePer1M"> & {
        accessPointId: string;
        inputPer1M: number;
        cachedInputPer1M: number;
        cacheWritePer1M?: number | null;
        outputPer1M: number;
        tiers?: PriceTierInput[];
    }, audit: AuditInput): AccessPointPrice;
    findEnabledAccessPointPrice(accessPointId: string): AccessPointPrice | undefined;
    findEnabledAccessPointPrices(accessPointIds: readonly string[]): AccessPointPrice[];
    updateAccessPointPriceStatus(id: string, status: string): AccessPointPrice | undefined;
    listPlanAccessPointPrices(): PlanAccessPointPrice[];
    createPlanAccessPointPrice(input: Omit<Partial<PlanAccessPointPrice>, "tiers" | "cacheWritePer1M"> & {
        planId: string;
        accessPointId: string;
        inputPer1M: number;
        cachedInputPer1M: number;
        cacheWritePer1M?: number | null;
        outputPer1M: number;
        tiers?: PriceTierInput[];
    }): PlanAccessPointPrice;
    findEnabledPlanAccessPointPrice(planId: string, accessPointId: string): PlanAccessPointPrice | undefined;
    findEffectivePlanAccessPointPrice(planId: string, accessPointId: string): EffectivePlanAccessPointPrice | undefined;
    findEffectivePlanAccessPointPrices(input: readonly { planId: string; accessPointId: string }[]): EffectivePlanAccessPointPriceBatchItem[];
    updatePlanAccessPointPriceStatus(id: string, status: string): PlanAccessPointPrice | undefined;
    createAccessPoint(input: Partial<AccessPoint> & {
        ownerId?: string;
        scopeRef?: ScopeRef;
        name: string;
        apiFamily: string;
        exposedModel: string;
        targetModel: string;
        targetType?: AccessPointTargetType;
        targetId?: string | null;
        targetProviderId?: string | null;
        targetProviderModelName?: string | null;
        routing?: AccessPointRoutingInput;
        salePrice?: PriceInput | null;
    }): AccessPoint;
    updateAccessPoint(id: string, input: Partial<AccessPoint> & {
        ownerId?: string;
        scopeRef?: ScopeRef;
        name: string;
        apiFamily: string;
        exposedModel: string;
        targetModel: string;
        targetType?: AccessPointTargetType;
        targetId?: string | null;
        targetProviderId?: string | null;
        targetProviderModelName?: string | null;
        routing?: AccessPointRoutingInput;
    }): AccessPoint | undefined;
    deleteAccessPoint(id: string): boolean;
    getAccessPoint(id: string): AccessPoint | undefined;
    getAccessPoints(ids: readonly string[]): AccessPoint[];
    listAccessPoints(): AccessPoint[];
    listAccessPointTargets(accessPointId: string, includeDisabled?: boolean): AccessPointTarget[];
    listAccessPointTargetsByIds(accessPointIds: readonly string[], includeDisabled?: boolean): AccessPointTarget[];
    getAccessPointWithRouting(id: string): AccessPointWithRouting | undefined;
    accessPointPlanImpact(accessPointId: string, at?: string): {
        plans: Array<{
            id: string;
            name: string;
            version: number;
        }>;
        activeOrFutureSubscriptionCount: number;
        exposedModels: string[];
    };
    listAccessPointsOwnedByUser(ownerId: string): AccessPoint[];
    listAccessPointsVisibleToScope(scopeRef: ScopeRef): AccessPoint[];
    listAccessPointsVisibleAtScope(scopeRef: ScopeRef): AccessPoint[];
    listEffectiveAccessPointEntries(visibleToScopeRef: ScopeRef): EffectiveAccessPointEntry[];
    listEffectiveEntitledAccessPointEntries(visibleToScopeRef: ScopeRef, at?: string): EffectiveAccessPointEntry[];
    private assertValidScopeRef;
    getProviderModel(providerId: string, providerModelName: string): ProviderModel | undefined;
    private defaultPlatformOwnerId;
    private defaultPlanOwnerId;
    private firstEnabledUserId;
    private defaultTeamOwnerId;
    private normalizeAccessPointRoutingInput;
    private retainLegacyDirectTargetIdentity;
    private accessPointRoutingChanged;
    private replaceAccessPointTargetRows;
    private assertAccessPointRoutingGraph;
    private resolveTargetCostForAccessPoint;
    private assertAccessPointSourceAuthorized;
    private assertNoAccessPointCycle;
    private listAccessPointsVisibleToScopeRefs;
    private visibleScopeRefs;
    private planScopeRefsForRuntimeScope;
    private anyPlanIncludesAccessPoint;
    listBudgetPolicies(): BudgetPolicy[];
    createBudgetPolicy(input: Partial<BudgetPolicy> & {
        metric: string;
        limitValue: number;
        windowType: string;
    }): BudgetPolicy;
    updateBudgetPolicy(id: string, input: Partial<Omit<BudgetPolicy, "id" | "createdAt" | "updatedAt">>): BudgetPolicy | undefined;
    deleteBudgetPolicy(id: string): boolean;
    listGovernanceBudgetPolicies(): GovernanceBudgetPolicy[];
    createGovernanceBudgetPolicy(input: Partial<GovernanceBudgetPolicy> & {
        metric: string;
        limitValue: number;
        windowType: string;
    }): GovernanceBudgetPolicy;
    updateGovernanceBudgetPolicy(id: string, input: Partial<Omit<GovernanceBudgetPolicy, "id" | "createdAt" | "updatedAt">>): GovernanceBudgetPolicy | undefined;
    deleteGovernanceBudgetPolicy(id: string): boolean;
    assignGovernanceBudgetPolicyToScope(input: {
        scopeRef: ScopeRef;
        governanceBudgetPolicyId: string;
        status?: string;
    }): ScopeGovernanceBudgetPolicy;
    updateScopeGovernanceBudgetPolicyAssignment(id: string, input: Partial<Omit<ScopeGovernanceBudgetPolicy, "id" | "createdAt" | "updatedAt">>): ScopeGovernanceBudgetPolicy | undefined;
    deleteScopeGovernanceBudgetPolicyAssignment(id: string): boolean;
    listScopeGovernanceBudgetPolicyAssignments(scopeRef?: ScopeRef | readonly ScopeRef[]): ScopeGovernanceBudgetPolicyAssignment[];
    listPlanDefinitions(): PlanDefinition[];
    listPlanTemplates(): PlanTemplate[];
    listPlans(): Plan[];
    getPlan(id: string): PlanDefinition | undefined;
    createPlan(input: Partial<PlanDefinition> & {
        name: string;
        durationSeconds: number;
        purchaseAmount?: number;
        budgetLimits?: PlanBudgetLimitInput[];
        accessPointIds?: string[];
        accessPointPriceOverrides?: PlanAccessPointPriceOverrideInput[];
    }): PlanDefinition;
    createPlan(input: {
        planTemplateId: string;
        scopeRef: ScopeRef;
        id?: string;
        source?: string;
        purchasedByUserId?: string | null;
        fundingAccountId?: string | null;
        priority?: number;
        effectiveStart?: string;
        effectiveEnd?: string;
        status?: string;
    }): Plan;
    createPlanDefinition(input: Partial<PlanDefinition> & {
        name: string;
        durationSeconds: number;
        purchaseAmount?: number;
        budgetLimits?: PlanBudgetLimitInput[];
        accessPointIds?: string[];
        accessPointPriceOverrides?: PlanAccessPointPriceOverrideInput[];
    }): PlanDefinition;
    createPlanTemplate(input: Partial<PlanTemplate> & {
        name: string;
        durationSeconds: number;
        budgetLimits?: PlanBudgetLimitInput[];
        accessPointIds?: string[];
        accessPointPriceOverrides?: PlanAccessPointPriceOverrideInput[];
    }): PlanTemplate;
    updatePlanDefinition(id: string, input: Partial<Omit<PlanDefinition, "id" | "createdAt" | "updatedAt">> & {
        budgetLimits?: PlanBudgetLimitInput[];
        accessPointIds?: string[];
        accessPointPriceOverrides?: PlanAccessPointPriceOverrideInput[];
    }): PlanDefinition | undefined;
    updatePlanTemplate(id: string, input: {
        ownerId?: string;
        scopeRef?: ScopeRef;
        name?: string;
        version?: number;
        description?: string | null;
        adminNote?: string | null;
        billingMode?: PlanBillingMode | string;
        purchaseAmount?: number;
        durationSeconds?: number;
        status?: string;
        catalogStatus?: string;
        budgetLimits?: PlanBudgetLimitInput[];
        accessPointIds?: string[];
        accessPointPriceOverrides?: PlanAccessPointPriceOverrideInput[];
    }): PlanTemplate | undefined;
    deletePlanDefinition(id: string): boolean;
    deletePlanTemplate(id: string): boolean;
    disablePlan(id: string): PlanDefinition | undefined;
    listAccessPointsForPlan(planId: string): AccessPoint[];
    replaceAccessPointsForPlan(planId: string, accessPointIds: string[]): PlanAccessPoint[];
    planIncludesAccessPoint(planId: string, accessPointId: string): boolean;
    appendPlanAccessPointPriceOverrides(planId: string, overrides: PlanAccessPointPriceOverrideInput[]): PlanAccessPointPrice[];
    addPlanBudgetLimit(planId: string, input: PlanBudgetLimitInput): PlanBudgetLimit;
    replacePlanBudgetLimits(planId: string, limits: PlanBudgetLimitInput[]): PlanBudgetLimit[];
    removePlanBudgetLimit(planId: string, limitId: string): boolean;
    listPlanBudgetLimits(planId: string): PlanBudgetLimit[];
    listPlanBudgetLimitsForPlans(planIds: string[]): Map<string, PlanBudgetLimit[]>;
    assignBudgetPolicyToScope(input: {
        scopeRef: ScopeRef;
        budgetPolicyId: string;
        status?: string;
    }): ScopeBudgetPolicy;
    updateScopeBudgetPolicyAssignment(id: string, input: Partial<Omit<ScopeBudgetPolicy, "id" | "createdAt" | "updatedAt">>): ScopeBudgetPolicy | undefined;
    deleteScopeBudgetPolicyAssignment(id: string): boolean;
    listBudgetPoliciesForDirectScope(scopeRef: ScopeRef): BudgetPolicy[];
    listScopeBudgetPolicyAssignments(scopeRef?: ScopeRef): ScopeBudgetPolicyAssignment[];
    listRateLimitPolicies(): RateLimitPolicy[];
    createRateLimitPolicy(input: Partial<RateLimitPolicy> & {
        limitValue: number;
        windowSeconds?: number;
        burstValue?: number;
        mode?: string;
    }): RateLimitPolicy;
    assignRateLimitPolicyToScope(input: {
        scopeRef: ScopeRef;
        rateLimitPolicyId: string;
        status?: string;
    }): ScopeRateLimitPolicy;
    listScopeRateLimitPolicyAssignments(scopeRef?: ScopeRef | readonly ScopeRef[]): ScopeRateLimitPolicyAssignment[];
    createPlanSubscription(input: Partial<PlanSubscription> & {
        planId: string;
        scopeRef: ScopeRef;
        effectiveStart?: string;
        effectiveEnd?: string | null;
    }): PlanSubscription;
    private createPlanSubscriptionInternal;
    updatePlanSubscription(id: string, input: Partial<Omit<PlanSubscription, "id" | "createdAt" | "updatedAt">>): PlanSubscription | undefined;
    deletePlanSubscription(id: string): boolean;
    cancelPlanSubscription(id: string, effectiveEnd?: string): PlanSubscription | undefined;
    cancelPlan(id: string): Plan | undefined;
    countPlanSubscriptions(filter?: PlanSubscriptionListFilter): number;
    getPlanSubscription(id: string): PlanSubscription | undefined;
    listPlanSubscriptions(filter?: PlanSubscriptionListFilter, limit?: number, offset?: number): PlanSubscription[];
    listPlanSubscriptionPlanCandidates(search?: string, limit?: number, offset?: number): PlanSubscriptionCandidatePage;
    listAdminGrantUserCandidates(search?: string, limit?: number, offset?: number): PlanSubscriptionCandidatePage;
    listAdminGrantCreditProductCandidates(search?: string, limit?: number, offset?: number): PlanSubscriptionCandidatePage;
    listPlanSubscriptionScopeCandidates(search?: string, limit?: number, offset?: number): PlanSubscriptionCandidatePage;
    listPlanSubscriptionAccountCandidates(search?: string, limit?: number, offset?: number): PlanSubscriptionCandidatePage;
    listPlanSubscriptionUserCandidates(subscriptionId: string, search?: string, limit?: number, offset?: number, at?: string): PlanSubscriptionCandidatePage;
    isPlanSubscriptionUserEligible(subscriptionId: string, userId: string, at?: string): boolean;
    listPlanSubscriptionSources(): string[];
    listPlanSubscriptionLifecycles(): string[];
    listPlanSubscriptionsForScope(scopeRef: ScopeRef): PlanSubscription[];
    listEffectiveSubscriptionScopesForUser(userId: string): ScopeRef[];
    listActiveSubscriptionsForUser(userId: string, at?: string): ActivePlanSubscription[];
    listUserModelPlanScopeOrders(userId: string, exposedModel?: string): UserModelPlanScopeOrder[];
    listEffectiveUserModelPlanSourceModels(userId: string, restriction?: ApiKeyPlanSourceRestrictionDecision): string[];
    findFirstEffectiveUserModelPlanScopeOrder(userId: string, exposedModel: string): UserModelPlanScopeOrder | null;
    pageOrderedPlanSourcesForUser(userId: string, exposedModel: string, cursor?: OrderedPlanSourceCursor | null, at?: string, restriction?: ApiKeyPlanSourceRestrictionDecision): OrderedPlanSourcePage;
    findFirstOrderedPlanSourceForUser(userId: string, exposedModel: string, at?: string, restriction?: ApiKeyPlanSourceRestrictionDecision): OrderedPlanSource | null;
    replaceUserModelPlanSourceOrder(userId: string, exposedModel: string, orderedPlanScopeIds: string[]): UserModelPlanScopeOrder[];
    moveUserModelPlanSourceOrder(userId: string, exposedModel: string, orderId: string, placement: "before" | "after", anchorId: string | null): UserModelPlanScopeOrder[];
    reconcileUserModelPlanScopeOrders(userId: string, reconcileAt?: string): void;
    private reconcileUserModelPlanScopeOrdersForScope;
    private reconcileUserModelPlanScopeOrdersForPlan;
    private forEachPlanIdIncludingAccessPoint;
    private assertNoOverlappingPlanSubscription;
    private assertUniqueEnabledAccessPointModels;
    private planHasCommercialReferences;
    private assertPlanCommercialTermsMutable;
    getPlanStatusImpact(planId: string, at?: string): {
        availableCardCount: number;
        activeOrFutureSubscriptionCount: number;
    };
    private assertPlanCanBeDisabled;
    private assertPlanStatusTransition;
    private partnerPlanHasPendingCommerce;
    listPlansForScope(scopeRef: ScopeRef): Plan[];
    findActivePlan(scopeRef: ScopeRef, at?: string): Plan | undefined;
    findActivePlanForScopeRefs(scopeRefs: ScopeRef[], at?: string): {
        scopeRef: ScopeRef;
        plan: Plan;
        budgetLimits: PlanBudgetLimit[];
        template: PlanDefinition;
    } | undefined;
    findActivePlanSubscriptions(scopeRef: ScopeRef, at?: string): PlanSubscription[];
    private findCurrentOrFuturePlanSubscriptions;
    listActivePlanIdsForScopeRefs(scopeRefs: ScopeRef[], at?: string): string[];
    listActivePlanSubscriptionsForScopeRefs(scopeRefs: ScopeRef[], at?: string, restriction?: ApiKeyPlanSourceRestrictionDecision): ActivePlanSubscription[];
    listPlanBudgetUsageSourcesForUser(userId: string, at?: string, restriction?: ApiKeyPlanSourceRestrictionDecision): PlanBudgetUsageSource[];
    listPlanSubscriptionBudgetUsage(subscriptionIds: string[], targetUserId?: string | null, at?: string): PlanBudgetSourceView[];
    summarizeScopeBudgetUsageWindows(scopeRef: ScopeRef | readonly ScopeRef[], windows: BudgetUsageWindowInput[]): BudgetUsageWindowSummary[];
    summarizeSubscriptionBudgetUsageWindow(subscriptionId: string, userId: string | null, window: BudgetUsageWindowInput): BudgetUsageWindowSummary;
    usageForSubscription(subscriptionId: string, start: string, end: string): {
        usedTokens: number;
        usedAmount: number;
    };
    usageForSubscriptionUser(subscriptionId: string, userId: string, start: string, end: string): {
        usedTokens: number;
        usedAmount: number;
    };
    usageForScope(scopeRef: ScopeRef, start: string, end: string): {
        usedTokens: number;
        usedAmount: number;
    };
    getIngressPluginSetting(pluginId: string, scopeRef: ScopeRef): IngressPluginSetting | undefined;
    listIngressPluginSettings(scopeRefs?: ScopeRef[]): IngressPluginSetting[];
    upsertIngressPluginSetting(input: {
        id?: string;
        pluginId: string;
        scopeRef: ScopeRef;
        enabled: boolean;
        configJson: string;
        updatedByUserId?: string | null;
        now?: string;
    }): IngressPluginSetting;
    getPipelinePluginSetting(pluginId: string, scopeRef: ScopeRef): PipelinePluginSetting | undefined;
    listPipelinePluginSettings(scopeRefs?: ScopeRef[]): PipelinePluginSetting[];
    upsertPipelinePluginSetting(input: {
        id?: string;
        pluginId: string;
        scopeRef: ScopeRef;
        enabled: boolean;
        configJson: string;
        updatedByUserId?: string | null;
        now?: string;
    }): PipelinePluginSetting;
    private upsertPipelinePluginSettingRow;
    createRequestLog(input: Pick<RequestLog, "id" | "apiKeyId" | "userId" | "reqModel" | "status"> & Partial<Omit<RequestLog, "id" | "apiKeyId" | "userId" | "reqModel" | "status" | "startedAt" | "ingressPluginsJson" | "pipelinePluginsJson">> & {
        startedAt?: string;
        ingressPluginsJson?: string;
        ingressPlugins?: readonly IngressPluginInvocation[];
        pipelinePluginsJson?: string;
        pipelineSnapshot?: PipelinePluginSnapshotV1;
    }): RequestLog;
    listRequestProviderAttempts(requestId: string): RequestProviderAttempt[];
    finalizeRequestPipelineSnapshot(id: string, snapshot: PipelinePluginSnapshotV1): RequestLog;
    enrichRequestLogResolution(id: string, fields: RequestLogResolutionFields): RequestLog;
    finishRequestLog(id: string, status: string, errorCode?: string | null, failureReason?: ProviderCredentialFailureReason | null): void;
    acquireRequestExecutionLease(input: {
        requestId: string;
        ownerId: string;
        leaseTtlSeconds: number;
        now?: string;
    }): RequestExecutionLease;
    renewRequestExecutionLease(input: {
        requestId: string;
        ownerId: string;
        leaseTtlSeconds: number;
        now?: string;
    }): RequestExecutionLease;
    releaseRequestExecutionLease(input: {
        requestId: string;
        ownerId: string;
    }): boolean;
    getRequestExecutionLease(requestId: string): RequestExecutionLease | null;
    getRequestLog(id: string): RequestLog | undefined;
    getRequestLogForUser(id: string, userId: string): RequestLog | undefined;
    listRequestLogs(): RequestLog[];
    latestRequestStartedAtForUser(userId: string): string | null;
    latestRequestStartedAtForApiKey(apiKeyId: string): string | null;
    listLatestRequestStartedAtByUser(): Map<string, string>;
    listLatestRequestStartedAtByApiKey(): Map<string, string>;
    listRequestLogModels(): string[];
    countRequestLogs(filter?: RequestLogListFilter): number;
    listRecentRequestLogs(filter?: RequestLogListFilter, limit?: number, offset?: number): RequestLog[];
    listRecentRequestLogsForUser(userId: string, filter?: Omit<RequestLogListFilter, "userId">, limit?: number, offset?: number): RequestLog[];
    acquireRequestCaptureDownloadSlot(): RequestCaptureDownloadSlot | null;
    releaseRequestCaptureDownloadSlot(slot: RequestCaptureDownloadSlot): boolean;
    countActiveRequestCaptureDownloadSlots(): number;
    getRequestLogArchive(archiveMonth: string): RequestLogArchive | null;
    getVerifiedRequestLogArchiveForMonth(archiveMonth: string): RequestLogArchive | null;
    getRequestLogArchiveEntry(requestId: string): RequestLogArchiveEntry | null;
    getRequestLogArchiveEntryForUser(requestId: string, userId: string): RequestLogArchiveEntry | null;
    listRequestLogArchiveEntries(filter?: RequestLogArchiveEntryFilter, limit?: number): RequestLogArchiveEntry[];
    recordGeneratedRequestLogArchive(input: {
        archive: RequestLogArchive;
        entries: RequestLogArchiveEntry[];
    }): RequestLogArchive;
    advanceRequestLogArchiveStatus(archiveMonth: string, status: "uploaded" | "verified" | "purged", transitionedAt: string): RequestLogArchive;
    getBillingProviderCostArchive(archiveMonth: string): BillingProviderCostArchive | null;
    recordGeneratedBillingProviderCostArchive(input: {
        archive: BillingProviderCostArchive;
        entries: BillingProviderCostArchiveEntry[];
    }): BillingProviderCostArchive;
    advanceBillingProviderCostArchiveStatus(archiveMonth: string, status: "uploaded" | "verified" | "purged", transitionedAt: string): BillingProviderCostArchive;
    listVerifiedBillingProviderCostArchiveCoverage(providerId: string): Array<{
        archiveMonth: string;
        objectKey: string;
        objectSha256: string;
        eventCount: number;
    }>;
    getProviderRetirementArchive(providerId: string): ProviderRetirementArchive | null;
    recordProviderRetirementArchive(archive: ProviderRetirementArchive): ProviderRetirementArchive;
    getRequestCaptureSetting(): RequestCaptureSetting;
    isRequestCaptureEnabled(): boolean;
    setRequestCaptureEnabled(enabled: boolean, updatedBy?: string | null): RequestCaptureSetting;
    createBillingEvent(input: Omit<BillingEvent, "id" | "createdAt" | "billablePriceSnapshotJson" | "costPriceSnapshotJson" | "billablePriceTierKey" | "providerCostTierKey" | "cacheWriteTokens" | "operationKind"> & {
        id?: string;
        createdAt?: string;
        billablePriceSnapshotJson?: string;
        costPriceSnapshotJson?: string;
        billablePriceTierKey?: string;
        providerCostTierKey?: string;
        cacheWriteTokens?: number;
        operationKind?: "inference";
    }): BillingEvent;
    listBillingEvents(): BillingEvent[];
    createBillingAccessPointEdge(input: Omit<BillingAccessPointEdge, "id" | "createdAt" | "priceSnapshotJson" | "priceTierKey" | "cacheWriteTokens"> & {
        id?: string;
        createdAt?: string;
        priceSnapshotJson?: string;
        priceTierKey?: string;
        cacheWriteTokens?: number;
    }): BillingAccessPointEdge;
    createBillingProviderCostEvent(input: Omit<BillingProviderCostEvent, "id" | "createdAt" | "costSnapshotJson" | "costTierKey" | "cacheWriteTokens" | "operationKind" | "providerAttemptId"> & {
        id?: string;
        createdAt?: string;
        costSnapshotJson?: string;
        costTierKey?: string;
        cacheWriteTokens?: number;
        operationKind?: "compaction" | "inference";
        providerAttemptId?: string | null;
    }): BillingProviderCostEvent;
    listBillingAccessPointEdges(): BillingAccessPointEdge[];
    listBillingProviderCostEvents(): BillingProviderCostEvent[];
    ownerProfitSummary(scopeRef: ScopeRef): {
        salesAmount: number;
        sourceCostAmount: number;
        providerCostAmount: number;
        profitAmount: number;
    };
    listUsageLogs(): Array<{
        id: string;
        requestId: string;
        modelPriceId: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        calculatedCost: number;
        providerReportedCost: number | null;
        usageSource: string;
        createdAt: string;
    }>;
    usageSummary(filter?: {
        apiKeyId?: string;
        userId?: string;
        teamId?: string;
    }): {
        totalTokens: number;
        billableAmount: number;
        calculatedCost: number;
    };
    getCreditAccount(id: string): CreditAccount | undefined;
    listCreditAccounts(): CreditAccount[];
    findCreditAccountForScope(scopeRef: ScopeRef): CreditAccount | undefined;
    createCreditAccount(input: Partial<CreditAccount> & {
        scopeRef: ScopeRef;
    }): CreditAccount;
    getCreditAccountBalanceUnits(accountId: string): number;
    getCreditAccountBalance(accountId: string): number;
    listCreditLedgerEventsForAccount(accountId: string, limit?: number): CreditLedgerEvent[];
    listCreditProducts(): CreditProduct[];
    listEnabledCreditProducts(limit?: number): CreditProduct[];
    getCreditProduct(id: string): CreditProduct | undefined;
    createCreditProduct(input: {
        code: string;
        displayName: string;
        description?: string | null;
        adminNote?: string | null;
        creditedAmountUnits: number;
        displayOrder?: number;
    }): CreditProduct;
    disableCreditProduct(id: string): CreditProduct;
    listPaymentChannels(): PaymentChannel[];
    listEnabledPaymentChannels(limit?: number): PaymentChannel[];
    getPaymentChannel(id: string): PaymentChannel | undefined;
    createPaymentChannel(input: {
        code: string;
        displayName: string;
        paymentNetwork: string;
        paymentAsset: string;
        settlementMode: string;
        recipientIdentifierType: string;
        transactionReferenceType: string;
        recipientIdentifier: string;
        recipientIdentifierDisplay: string;
        paymentInstruction?: string | null;
        createdByUserId: string;
    }): PaymentChannel;
    setPaymentChannelStatus(id: string, status: "enabled" | "disabled"): PaymentChannel;
    listPaymentChannelInstructionAttachments(paymentChannelId: string): PaymentChannelInstructionAttachment[];
    listPaymentChannelInstructionAttachmentsForChannels(paymentChannelIds: string[]): PaymentChannelInstructionAttachment[];
    getPaymentChannelInstructionAttachment(id: string): PaymentChannelInstructionAttachment | undefined;
    createPaymentChannelInstructionAttachment(input: Omit<PaymentChannelInstructionAttachment, "id" | "createdAt"> & {
        id?: string;
        createdAt?: string;
    }): PaymentChannelInstructionAttachment;
    getPlanPaymentListing(id: string): PlanPaymentListing | undefined;
    pagePlanPaymentListings(filter?: {
        planId?: string;
        status?: "enabled" | "disabled";
        paymentAsset?: string;
        page?: number;
        pageSize?: number;
    }): {
        items: Array<PlanPaymentListing & {
            paymentAsset: string;
            paymentNetwork: string;
            settlementMode: string;
            channelDisplayName: string;
            planName: string;
            planVersion: number;
        }>;
        page: number;
        pageSize: DirectoryPageSize;
        total: number;
        totalPages: number;
    };
    createPlanPaymentListing(input: {
        planId: string;
        paymentChannelId: string;
        priceAmountUnits: number;
    }): PlanPaymentListing;
    disablePlanPaymentListing(id: string): PlanPaymentListing;
    listCreditProductListings(): CreditProductListing[];
    listEnabledCreditProductListings(limit?: number): CreditProductListing[];
    getCreditProductListing(id: string): CreditProductListing | undefined;
    createCreditProductListing(input: {
        productId: string;
        paymentChannelId: string;
        priceAmountUnits: number;
    }): CreditProductListing;
    disableCreditProductListing(id: string): CreditProductListing;
    switchCreditProductListingsChannel(input: {
        sourcePaymentChannelId: string;
        targetPaymentChannelId: string;
    }): CreditProductListing[];
    getCard(id: string): Card | undefined;
    private validateCardActivationProduct;
    private cardActivationCodeStatus;
    private cardActivationStatsForBatch;
    createCardActivationBatch(input: {
        referenceCode: string;
        cardType: CardType;
        planId?: string | null;
        creditProductId?: string | null;
        creditAmountUnits?: number | null;
        quantity: number;
        redeemExpiresAt: string;
        idempotencyKey: string;
        createdByUserId: string;
        requestId?: string | null;
    }): CardActivationBatch;
    exportCardActivationBatch(batchId: string, actorUserId: string, requestId?: string | null): {
        batch: CardActivationBatch;
        codes: Array<{
            ordinal: number;
            code: string;
        }>;
    };
    listCardActivationBatches(input?: {
        page?: number;
        pageSize?: number;
        cardType?: CardType;
        status?: CardActivationCodeStatus;
    }): {
        items: Array<CardActivationBatch & {
            stats: CardActivationStats;
        }>;
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
    };
    getCardActivationBatchDetail(batchId: string, page?: number, pageSize?: number): CardActivationBatchDetail | undefined;
    getCardActivationStats(input?: {
        batchId?: string;
        cardType?: CardType;
    }): CardActivationStats;
    revokeCardActivationBatch(batchId: string, actorUserId: string, reason: string, requestId?: string | null): CardActivationBatch;
    revokeCardActivationCode(codeId: string, actorUserId: string, reason: string, requestId?: string | null): CardActivationCode;
    previewCardActivationCode(codeHash: string, at?: string): CardActivationPreview | undefined;
    redeemCardActivationCode(codeHash: string, userId: string, context?: {
        requestId?: string | null;
    }): CardActivationRedeemResult;
    listCardsForUser(ownerUserId: string, options?: {
        limit?: number;
        at?: string;
    }): CardView[];
    listCardTransfersForUser(userId: string, options?: {
        limit?: number;
    }): CardTransfer[];
    listCardTransfers(options?: {
        participantUserId?: string;
        referenceCode?: string;
        limit?: number;
    }): CardTransfer[];
    listCardBreakage(reportCutoff: string): CardBreakage[];
    sendCard(input: {
        cardId: string;
        fromUserId: string;
        toUserId: string;
        referenceCode?: string | null;
        note?: string | null;
    }): Card;
    grantAdminCard(input: {
        cardType: CardType;
        senderUserId: string;
        recipientUserId: string;
        expiresAt?: string | null;
        planId?: string | null;
        creditProductId?: string | null;
        referenceCode?: string | null;
        note?: string | null;
        requestId?: string | null;
    }): {
        card: Card;
        transfer: CardTransfer;
    };
    createAdminGrantBatch(input: {
        actionType: AdminGrantActionType;
        requestedByUserId: string;
        targetUserIds: string[];
        planId?: string | null;
        creditProductId?: string | null;
        expiresAt?: string | null;
        referenceCode: string;
        note?: string | null;
        fallbackToPlanCard?: boolean;
        idempotencyKey: string;
        requestId?: string | null;
    }): AdminGrantBatchDetail;
    getAdminGrantBatchDetail(id: string, limit?: number, offset?: number): AdminGrantBatchDetail | undefined;
    countAdminGrantBatches(): number;
    listAdminGrantBatches(limit?: number, offset?: number): AdminGrantBatch[];
    private processAdminGrantBatchItem;
    useCard(input: {
        cardId: string;
        ownerUserId: string;
    }): CardUseResult;
    replaceAvailablePlanCards(input: {
        sourcePlanId: string;
        targetPlanId: string;
        ownerUserId: string;
        requestId?: string | null;
    }): PlanCardReplacementResult;
    getPlanPurchaseOrder(id: string): PlanPurchaseOrder | undefined;
    getPlanPurchaseOrderForUser(id: string, buyerUserId: string): PlanPurchaseOrder | undefined;
    pagePlanPurchaseOrders(filter?: {
        status?: PlanPurchaseOrderStatus;
        buyerUserId?: string;
        planId?: string;
        paymentAsset?: string;
        page?: number;
        pageSize?: number;
    }): PlanPurchaseOrderPage;
    createPlanPurchaseOrder(input: {
        planId: string;
        buyerUserId: string;
        useImmediately: boolean;
        idempotencyKey: string;
        payment: {
            kind: "credit_balance";
        } | {
            kind: "payment_listing";
            listingId: string;
        };
    }): PlanPurchaseResult;
    attachStripePlanCheckoutSession(input: {
        orderId: string;
        checkoutSessionId: string;
    }): PlanPurchaseOrder;
    completeStripePlanPurchaseOrder(input: {
        orderId: string;
        checkoutSessionId: string;
        paymentIntentId: string | null;
        amountMinor: number;
        currency: string;
        webhookEvent: {
            eventId: string;
            eventType: string;
            livemode: boolean;
        };
    }): PlanPurchaseResult;
    recordStripePlanPurchaseTerminal(input: {
        orderId: string;
        checkoutSessionId: string;
        status: "payment_failed" | "expired";
        webhookEvent: {
            eventId: string;
            eventType: string;
            livemode: boolean;
        };
    }): PlanPurchaseOrder;
    cancelUserPlanPurchaseOrder(input: {
        orderId: string;
        buyerUserId: string;
    }): PlanPurchaseOrder;
    reversePlanPurchaseOrder(input: {
        orderId: string;
        ownerUserId: string;
        reason: string;
    }): PlanPurchaseResult;
    private planPurchaseResult;
    purchasePlanCard(input: {
        planId: string;
        buyerUserId: string;
        useImmediately: boolean;
    }): {
        card: Card;
        ledgerEvent: CreditLedgerEvent;
        subscription: PlanSubscription | null;
    };
    private createCard;
    private useCardInTransaction;
    isPlanVisibleToUser(plan: PlanDefinition, userId: string): boolean;
    private transferCardInTransaction;
    private listAvailablePlanCards;
    private cardHasReplacement;
    private resolveCardReplacementRoot;
    private resolveCardReplacementLeaf;
    private getPlanCardPurchaseFact;
    getCreditTopup(id: string): CreditTopup | undefined;
    listCreditTopups(filter?: {
        userId?: string;
        status?: string;
        limit?: number;
        offset?: number;
    }): CreditTopup[];
    listCreditTopupAttachments(topupId: string): CreditTopupAttachment[];
    listCreditTopupAttachmentStats(topupIds: string[]): Array<{
        topupId: string;
        attachmentCount: number;
        duplicateEvidence: boolean;
    }>;
    createUserCreditTopup(input: {
        userId: string;
        productListingId: string;
        idempotencyKey: string;
        useImmediately: boolean;
    }): CreditTopup;
    submitCreditTopupPaymentReference(input: {
        topupId: string;
        userId: string;
        transactionReference: string;
        claimedPaidAt?: string | null;
    }): CreditTopup;
    attachStripeCheckoutSession(input: {
        topupId: string;
        checkoutSessionId: string;
    }): CreditTopup;
    recordStripeCreditTopupTerminal(input: {
        topupId: string;
        checkoutSessionId: string;
        status: "payment_failed" | "expired";
        webhookEvent: {
            eventId: string;
            eventType: string;
            livemode: boolean;
        };
    }): CreditTopup;
    approveCreditTopup(input: {
        topupId: string;
        ownerUserId: string;
        confirmedReceivedAmountUnits: number;
        reviewNote: string;
    }): {
        topup: CreditTopup;
        card: Card | null;
        ledgerEvent: CreditLedgerEvent | null;
        account: CreditAccount | null;
    };
    getStripeWebhookEvent(eventId: string): StripeWebhookEvent | undefined;
    recordStripeWebhookIgnored(input: {
        eventId: string;
        eventType: string;
        livemode: boolean;
        checkoutSessionId?: string | null;
        topupId?: string | null;
        planPurchaseOrderId?: string | null;
        reason: string;
    }): StripeWebhookEvent;
    recordStripeWebhookFailure(input: {
        eventId: string;
        eventType: string;
        livemode: boolean;
        checkoutSessionId?: string | null;
        topupId?: string | null;
        planPurchaseOrderId?: string | null;
        errorCode: string;
    }): StripeWebhookEvent;
    completeStripeCreditTopup(input: {
        topupId: string;
        checkoutSessionId: string;
        paymentIntentId: string | null;
        amountUnits: number;
        currency: string;
        webhookEvent?: {
            eventId: string;
            eventType: string;
            livemode: boolean;
        };
    }): {
        topup: CreditTopup;
        card: Card | null;
        ledgerEvent: CreditLedgerEvent | null;
        account: CreditAccount | null;
        replayed: boolean;
    };
    rejectCreditTopup(input: {
        topupId: string;
        ownerUserId: string;
        reviewNote: string;
        confirmedReceivedAmountUnits?: number | null;
    }): CreditTopup;
    cancelUserCreditTopup(input: {
        topupId: string;
        userId: string;
    }): CreditTopup;
    reverseCreditTopup(input: {
        topupId: string;
        ownerUserId: string;
        reversalReason: string;
        requestId?: string | null;
    }): {
        topup: CreditTopup;
        ledgerEvent: CreditLedgerEvent | null;
        account: CreditAccount | null;
        card: Card | null;
    };
    recordCreditTopupRefundNote(input: {
        topupId: string;
        ownerUserId: string;
        refundNote: string;
    }): CreditTopup;
    expireCreditTopups(now?: string, userId?: string): number;
    createCreditTopupAttachment(input: Omit<CreditTopupAttachment, "id" | "createdAt"> & {
        id?: string;
        createdAt?: string;
    }): CreditTopupAttachment;
    listCreditTransferPolicies(): CreditTransferPolicy[];
    getCreditTransferPolicy(scopeRef: ScopeRef): CreditTransferPolicy | undefined;
    setCreditTransferPolicy(input: {
        scopeRef: ScopeRef;
        transferOutEnabled: boolean;
        updatedBy?: string | null;
    }): CreditTransferPolicy;
    isCreditTransferOutEnabled(scopeRef: ScopeRef): boolean;
    createCreditLedgerEvent(input: Omit<CreditLedgerEvent, "id" | "createdAt" | "relatedTopupId" | "cardId" | "authorityPurchaseId"> & {
        id?: string;
        createdAt?: string;
        relatedTopupId?: string | null;
        cardId?: string | null;
        authorityPurchaseId?: string | null;
        allowNegativeBalance?: boolean;
    }): CreditLedgerEvent;
    createAdminCreditLedgerEvent(input: {
        scopeRef: ScopeRef;
        eventType: "grant" | "adjustment" | "reversal";
        amountUnits: number;
        actorUserId: string;
        reason: string;
        relatedEventId?: string | null;
    }): {
        account: CreditAccount;
        ledgerEvent: CreditLedgerEvent;
    };
    transferCredit(input: {
        fromAccountId: string;
        toAccountId: string;
        amountUnits: number;
        actorUserId: string;
        reason?: string | null;
        transferId?: string;
    }): {
        outEvent: CreditLedgerEvent;
        inEvent: CreditLedgerEvent;
    };
    purchasePlanWithBalance(input: {
        accountId: string;
        planId: string;
        scopeRef: ScopeRef;
        purchasedByUserId: string;
        effectiveStart?: string;
        priority?: number;
    }): {
        subscription: PlanSubscription;
        ledgerEvent: CreditLedgerEvent;
    };
    createPlanSubscriptionUnits(input: {
        planId: string;
        scopeRef: ScopeRef;
        units: number;
        source?: string;
        purchasedByUserId?: string | null;
        fundingAccountId?: string | null;
        paymentAccountId?: string | null;
        chargePurchaseAmount?: boolean;
        effectiveStart?: string;
        priority?: number;
    }): {
        subscriptions: PlanSubscription[];
        ledgerEvents: CreditLedgerEvent[];
    };
    createBillingEventWithUsageCharge(input: {
        billingEvent: Parameters<ApplicationOperationPort["createBillingEvent"]>[0];
        accessPointEdges?: Array<Parameters<ApplicationOperationPort["createBillingAccessPointEdge"]>[0]>;
        providerCostEvent?: Parameters<ApplicationOperationPort["createBillingProviderCostEvent"]>[0];
        providerCostEvents?: Array<Parameters<ApplicationOperationPort["createBillingProviderCostEvent"]>[0]>;
        usageChargeAccountId: string;
        actorUserId?: string | null;
        /** Stage 1 checked a positive balance before CPA but has no precise
         * reservation; authoritative final usage may therefore overdraw. */
        allowOverdraft?: boolean;
    }): {
        billingEvent: BillingEvent;
        ledgerEvent: CreditLedgerEvent | null;
    };
    createBillingEventWithFacts(input: {
        billingEvent: Parameters<ApplicationOperationPort["createBillingEvent"]>[0];
        accessPointEdges?: Array<Parameters<ApplicationOperationPort["createBillingAccessPointEdge"]>[0]>;
        providerCostEvent?: Parameters<ApplicationOperationPort["createBillingProviderCostEvent"]>[0];
        providerCostEvents?: Array<Parameters<ApplicationOperationPort["createBillingProviderCostEvent"]>[0]>;
    }): {
        billingEvent: BillingEvent;
    };
    settleProviderUsage(input: {
        facts: Parameters<ApplicationOperationPort["createBillingEventWithFacts"]>[0];
        requiresUsageCharge: boolean;
        usageChargeAccountId: string | null;
        actorUserId: string | null;
        allowUsageOverdraft: boolean;
    }): { billingEvent: BillingEvent };
    listSellerSettlementEvents(sellerScopeRef?: ScopeRef): SellerSettlementEvent[];
    sellerSettlementBalance(sellerScopeRef: ScopeRef, at?: string): {
        frozenUnits: number;
        releasableUnits: number;
        releasedUnits: number;
    };
    releaseDueSellerSettlements(at?: string): {
        selectedWindows: number;
        deferredWindows: number;
        releasedWindows: number;
        releasedUnits: number;
        ledgerEventIds: string[];
    };
    private recordPrepaidSellerRevenue;
    private recordUsageSellerSettlement;
    private createSellerSettlementEvent;
    listAuditLogs(): AuditLog[];
    private nextPlanVersion;
    private assertBudgetPolicyShape;
    private billableSnapshotForEvent;
    private costSnapshotForEvent;
    private withProviderModelCostTiers;
    private withAccessPointPriceTiers;
    private withPlanAccessPointPriceTiers;
    private listProviderModelCostTiers;
    private listAccessPointPriceTiers;
    private listPlanAccessPointPriceTiers;
    private createProviderModelCostTiers;
    private createAccessPointPriceTiers;
    private createPlanAccessPointPriceTiers;
    private assertLedgerEventShape;
    private countRows;
    private tableExists;
}
//# sourceMappingURL=repository.d.ts.map
