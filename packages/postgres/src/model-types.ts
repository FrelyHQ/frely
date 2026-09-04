/** Stable type-only projections of the retired Drizzle row shapes.
 * Runtime structure and migration authority remain Prisma/PostgreSQL. */
export type { AccessPoint, AccessPointTarget } from "./generated/prisma/client.js";

export interface AbuseRateLimitCountersRow {
  "id": string;
  "bucket": string;
  "subjectHash": string;
  "windowStart": number;
  "windowSeconds": number;
  "count": number;
  "blockedUntil": number | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const abuseRateLimitCounters: { readonly $inferSelect: AbuseRateLimitCountersRow };

export interface AccessPointPricesRow {
  "id": string;
  "accessPointId": string;
  "inputPer1M": number;
  "cachedInputPer1M": number;
  "cacheWritePer1M": number | null;
  "outputPer1M": number;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const accessPointPrices: { readonly $inferSelect: AccessPointPricesRow };

export interface AccessPointPriceTiersRow {
  "id": string;
  "accessPointPriceId": string;
  "serviceTier": string;
  "tierKey": string;
  "minInputTokens": number;
  "maxInputTokens": number | null;
  "inputPer1M": number;
  "cachedInputPer1M": number;
  "cacheWritePer1M": number | null;
  "outputPer1M": number;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const accessPointPriceTiers: { readonly $inferSelect: AccessPointPriceTiersRow };

export interface AccessPointsRow {
  "id": string;
  "ownerId": string;
  "scopeRef": string;
  "name": string;
  "description": string | null;
  "apiFamily": string;
  "exposedModel": string;
  "targetModel": string;
  "selectorId": string;
  "selectorBehaviorVersion": number;
  "selectorConfigJson": string;
  "routingRevision": number;
  "targetType": string;
  "targetId": string | null;
  "targetProviderId": string | null;
  "targetProviderModelName": string | null;
  "priority": number;
  "weight": number;
  "fallbackOrder": number;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const accessPoints: { readonly $inferSelect: AccessPointsRow };

export interface AccessPointTargetsRow {
  "id": string;
  "accessPointId": string;
  "targetType": string;
  "targetAccessPointId": string | null;
  "targetProviderId": string | null;
  "targetProviderModelName": string | null;
  "position": number;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const accessPointTargets: { readonly $inferSelect: AccessPointTargetsRow };

export interface AdminGrantBatchesRow {
  "id": string;
  "actionType": string;
  "referenceCode": string;
  "planId": string | null;
  "creditProductId": string | null;
  "expiresAt": string | null;
  "note": string | null;
  "fallbackToPlanCard": number;
  "requestedByUserId": string;
  "idempotencyKeyHash": string;
  "requestHash": string;
  "createdAt": string;
  "completedAt": string | null;
}
export declare const adminGrantBatches: { readonly $inferSelect: AdminGrantBatchesRow };

export interface AdminGrantBatchItemsRow {
  "id": string;
  "batchId": string;
  "targetUserId": string;
  "outcome": string;
  "reasonCode": string | null;
  "cardId": string | null;
  "subscriptionId": string | null;
  "processedAt": string;
}
export declare const adminGrantBatchItems: { readonly $inferSelect: AdminGrantBatchItemsRow };

export interface AgentCatalogRevisionsRow {
  "id": number;
  "revision": number;
}
export declare const agentCatalogRevisions: { readonly $inferSelect: AgentCatalogRevisionsRow };

export interface ApiKeysRow {
  "id": string;
  "userId": string;
  "name": string;
  "keyHash": string;
  "keyPrefix": string;
  "keyValue": string;
  "status": string;
  "expiresAt": string | null;
  "revokedAt": string | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const apiKeys: { readonly $inferSelect: ApiKeysRow };

export interface AuditLogsRow {
  "id": string;
  "actorType": string;
  "actorId": string;
  "action": string;
  "resourceType": string;
  "resourceId": string;
  "result": string;
  "requestId": string | null;
  "source": string;
  "ipHash": string | null;
  "userAgentHash": string | null;
  "metadataJson": string;
  "createdAt": string;
}
export declare const auditLogs: { readonly $inferSelect: AuditLogsRow };

export interface AuthorityGrantQuotasRow {
  "id": string;
  "grantId": string;
  "capabilityCode": string;
  "grantedUnits": number;
  "createdAt": string;
}
export declare const authorityGrantQuotas: { readonly $inferSelect: AuthorityGrantQuotasRow };

export interface AuthorityGrantsRow {
  "id": string;
  "beneficiaryUserId": string;
  "roleDomain": string;
  "roleCode": string;
  "roleScopeId": string | null;
  "sourceKind": string;
  "sourcePurchaseId": string | null;
  "sourceProductCodeSnapshot": string | null;
  "sourceProductVersionSnapshot": number | null;
  "sourceOriginIdSnapshot": string | null;
  "maxCurrentOwnedTeamsSnapshot": number | null;
  "maxLifetimeCreatedTeamsSnapshot": number | null;
  "issuedByUserId": string | null;
  "effectiveStart": string;
  "effectiveEnd": string | null;
  "lifecycle": string;
  "canceledAt": string | null;
  "canceledByUserId": string | null;
  "cancelReasonCode": string | null;
  "createdAt": string;
}
export declare const authorityGrants: { readonly $inferSelect: AuthorityGrantsRow };

export interface AuthorityProductsRow {
  "id": string;
  "code": string;
  "version": number;
  "displayName": string;
  "effectCode": string;
  "grantUnits": number;
  "purchaseAmountUnits": number;
  "grantDurationSeconds": number;
  "maxLifetimePurchasesPerUser": number | null;
  "maxUnconsumedUnitsPerUser": number | null;
  "maxCurrentOwnedTeams": number | null;
  "maxLifetimeCreatedTeams": number | null;
  "refundMode": string;
  "refundDeadlineSeconds": number | null;
  "settlementHoldSeconds": number;
  "sellerScopeRef": string;
  "lifecycle": string;
  "createdByOwnerUserId": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const authorityProducts: { readonly $inferSelect: AuthorityProductsRow };

export interface AuthorityPurchasesRow {
  "id": string;
  "productId": string;
  "buyerUserId": string;
  "creditAccountId": string;
  "productCode": string;
  "productVersion": number;
  "productDisplayName": string;
  "effectCode": string;
  "grantUnits": number;
  "purchaseAmountUnits": number;
  "grantDurationSeconds": number;
  "maxLifetimePurchasesPerUser": number | null;
  "maxUnconsumedUnitsPerUser": number | null;
  "maxCurrentOwnedTeams": number | null;
  "maxLifetimeCreatedTeams": number | null;
  "refundMode": string;
  "refundDeadlineSeconds": number | null;
  "settlementHoldSeconds": number;
  "sellerScopeRef": string;
  "idempotencyKeyHash": string;
  "requestHash": string;
  "createdAt": string;
}
export declare const authorityPurchases: { readonly $inferSelect: AuthorityPurchasesRow };

export interface AuthorityRefundsRow {
  "id": string;
  "authorityPurchaseId": string;
  "authorityGrantId": string;
  "actorOwnerUserId": string;
  "reasonCode": string;
  "idempotencyKeyHash": string;
  "requestHash": string;
  "createdAt": string;
}
export declare const authorityRefunds: { readonly $inferSelect: AuthorityRefundsRow };

export interface AuthorityUsesRow {
  "id": string;
  "grantQuotaId": string;
  "unitIndex": number;
  "beneficiaryUserId": string;
  "operation": string;
  "idempotencyKeyHash": string;
  "requestHash": string;
  "targetType": string;
  "targetIdSnapshot": string;
  "actorUserId": string;
  "createdAt": string;
}
export declare const authorityUses: { readonly $inferSelect: AuthorityUsesRow };

export interface BillingAccessPointEdgesRow {
  "id": string;
  "requestId": string;
  "edgeOrder": number;
  "chainIndex": number;
  "buyerScopeRef": string;
  "sellerScopeRef": string;
  "accessPointId": string;
  "targetAccessPointId": string | null;
  "isInternal": boolean;
  "accessPointPriceId": string;
  "priceTierKey": string;
  "priceSnapshotJson": string;
  "inputTokens": number;
  "cachedInputTokens": number;
  "cacheWriteTokens": number;
  "outputTokens": number;
  "amount": number;
  "createdAt": string;
}
export declare const billingAccessPointEdges: { readonly $inferSelect: BillingAccessPointEdgesRow };

export interface BillingEventsRow {
  "id": string;
  "requestId": string;
  "billingSubscriptionId": string | null;
  "billingScopeRef": string | null;
  "billablePriceId": string;
  "billablePriceSource": string;
  "billablePriceTierKey": string;
  "operationKind": string;
  "providerModelCostId": string;
  "providerCostTierKey": string;
  "inputTokens": number;
  "cachedInputTokens": number;
  "cacheWriteTokens": number;
  "outputTokens": number;
  "totalTokens": number;
  "billableAmount": number;
  "providerCostAmount": number;
  "grossMarginAmount": number;
  "usageSource": string;
  "billablePriceSnapshotJson": string;
  "costPriceSnapshotJson": string;
  "createdAt": string;
}
export declare const billingEvents: { readonly $inferSelect: BillingEventsRow };

export interface BillingHistoryRefsRow {
  "billingEventId": string;
  "requestId": string;
  "billingSubscriptionId": string | null;
  "billingScopeRef": string | null;
  "inputTokens": number;
  "cachedInputTokens": number;
  "cacheWriteTokens": number;
  "outputTokens": number;
  "totalTokens": number;
  "billableAmount": number;
  "providerCostAmount": number;
  "grossMarginAmount": number;
  "providerModelCostId": string;
  "usageSource": string;
  "occurredAt": string;
  "archiveMonth": string | null;
  "objectSha256": string | null;
  "rowKey": string | null;
  "archivedAt": string | null;
}
export declare const billingHistoryRefs: { readonly $inferSelect: BillingHistoryRefsRow };

export interface BillingProviderCostArchiveEntriesRow {
  "eventId": string;
  "requestId": string;
  "providerId": string;
  "createdAt": string;
  "archiveMonth": string;
}
export declare const billingProviderCostArchiveEntries: { readonly $inferSelect: BillingProviderCostArchiveEntriesRow };

export interface BillingProviderCostArchivesRow {
  "archiveMonth": string;
  "formatVersion": number;
  "schemaVersion": number;
  "status": string;
  "rowCount": number;
  "compressedBytes": number;
  "uncompressedBytes": number;
  "objectKey": string;
  "objectSha256": string;
  "manifestObjectKey": string;
  "manifestSha256": string;
  "createdAt": string;
  "uploadedAt": string | null;
  "verifiedAt": string | null;
  "purgedAt": string | null;
}
export declare const billingProviderCostArchives: { readonly $inferSelect: BillingProviderCostArchivesRow };

export interface BillingProviderCostEventsRow {
  "id": string;
  "requestId": string;
  "providerAttemptId": string | null;
  "operationKind": string;
  "providerOwnerScopeRef": string;
  "providerId": string;
  "providerModelName": string;
  "providerModelCostId": string;
  "costTierKey": string;
  "costSnapshotJson": string;
  "inputTokens": number;
  "cachedInputTokens": number;
  "cacheWriteTokens": number;
  "outputTokens": number;
  "amount": number;
  "createdAt": string;
}
export declare const billingProviderCostEvents: { readonly $inferSelect: BillingProviderCostEventsRow };

export interface BudgetPoliciesRow {
  "id": string;
  "metric": string;
  "limitValue": number;
  "windowType": string;
  "windowSeconds": number | null;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const budgetPolicies: { readonly $inferSelect: BudgetPoliciesRow };

export interface CardActivationBatchesRow {
  "id": string;
  "referenceCode": string;
  "cardType": string;
  "planId": string | null;
  "creditProductId": string | null;
  "creditAmountUnits": number | null;
  "quantity": number;
  "redeemExpiresAt": string;
  "exportSeedCiphertext": string;
  "exportKeyVersion": number;
  "idempotencyKeyHash": string;
  "requestHash": string;
  "createdByUserId": string;
  "createdAt": string;
  "revokedAt": string | null;
  "revokedByUserId": string | null;
  "revocationReason": string | null;
}
export declare const cardActivationBatches: { readonly $inferSelect: CardActivationBatchesRow };

export interface CardActivationCodesRow {
  "id": string;
  "batchId": string;
  "ordinal": number;
  "codeHash": string;
  "codeSuffix": string;
  "createdAt": string;
  "revokedAt": string | null;
  "revokedByUserId": string | null;
  "revocationReason": string | null;
  "redeemedAt": string | null;
  "redeemedByUserId": string | null;
  "redeemedCardId": string | null;
}
export declare const cardActivationCodes: { readonly $inferSelect: CardActivationCodesRow };

export interface CardsRow {
  "id": string;
  "cardType": string;
  "issuanceType": string;
  "ownerUserId": string;
  "planId": string | null;
  "creditProductId": string | null;
  "creditAmountUnits": number | null;
  "createdAt": string;
  "usedAt": string | null;
  "invalidatedAt": string | null;
  "invalidationReason": string | null;
  "expiresAt": string;
  "replacesCardId": string | null;
}
export declare const cards: { readonly $inferSelect: CardsRow };

export interface CardTransfersRow {
  "id": string;
  "cardId": string;
  "fromUserId": string;
  "toUserId": string;
  "referenceCode": string | null;
  "note": string | null;
  "createdAt": string;
}
export declare const cardTransfers: { readonly $inferSelect: CardTransfersRow };

export interface CpaInstancesRow {
  "id": string;
  "name": string;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const cpaInstances: { readonly $inferSelect: CpaInstancesRow };

export interface CreditAccountsRow {
  "id": string;
  "scopeRef": string;
  "status": string;
  "balanceSnapUnits": number;
  "balanceSnapLedgerEventId": string | null;
  "balanceSnapUpdatedAt": string | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const creditAccounts: { readonly $inferSelect: CreditAccountsRow };

export interface CreditLedgerEventsRow {
  "id": string;
  "accountId": string;
  "eventType": string;
  "amountUnits": number;
  "transferId": string | null;
  "relatedEventId": string | null;
  "planSubscriptionId": string | null;
  "authorityPurchaseId": string | null;
  "billingEventId": string | null;
  "relatedTopupId": string | null;
  "cardId": string | null;
  "fromAccountId": string | null;
  "toAccountId": string | null;
  "reason": string | null;
  "actorUserId": string | null;
  "createdAt": string;
}
export declare const creditLedgerEvents: { readonly $inferSelect: CreditLedgerEventsRow };

export interface CreditProductListingsRow {
  "id": string;
  "productId": string;
  "paymentChannelId": string;
  "priceAmountUnits": number;
  "status": string;
  "createdAt": string;
}
export declare const creditProductListings: { readonly $inferSelect: CreditProductListingsRow };

export interface CreditProductsRow {
  "id": string;
  "code": string;
  "displayName": string;
  "description": string | null;
  "adminNote": string | null;
  "creditedAmountUnits": number;
  "status": string;
  "displayOrder": number;
  "createdAt": string;
}
export declare const creditProducts: { readonly $inferSelect: CreditProductsRow };

export interface CreditTopupAttachmentsRow {
  "id": string;
  "topupId": string;
  "storageKey": string;
  "contentType": string;
  "byteSize": number;
  "sha256": string;
  "uploadedByUserId": string;
  "attachmentPurpose": string;
  "createdAt": string;
}
export declare const creditTopupAttachments: { readonly $inferSelect: CreditTopupAttachmentsRow };

export interface CreditTopupsRow {
  "id": string;
  "userId": string;
  "creditAccountId": string | null;
  "scopeRef": string | null;
  "productId": string;
  "productListingId": string;
  "creditedAmountUnits": number;
  "expectedPaymentAmountUnits": number;
  "confirmedReceivedAmountUnits": number | null;
  "paymentAsset": string;
  "paymentChannelId": string;
  "paymentNetwork": string;
  "settlementMode": string;
  "recipientIdentifierType": string;
  "normalizedRecipientIdentifierHash": string;
  "transactionReferenceType": string;
  "transactionReference": string | null;
  "normalizedTransactionReferenceHash": string | null;
  "transactionReferenceTail": string | null;
  "claimedPaidAt": string | null;
  "paymentSubmittedAt": string | null;
  "expiresAt": string;
  "expiredAt": string | null;
  "paymentFailedAt": string | null;
  "creditedAt": string | null;
  "useImmediately": boolean | null;
  "cardId": string | null;
  "status": string;
  "ledgerEventId": string | null;
  "reviewedByUserId": string | null;
  "reviewedAt": string | null;
  "reviewNote": string | null;
  "adminNote": string | null;
  "refundNote": string | null;
  "refundRecordedByUserId": string | null;
  "refundRecordedAt": string | null;
  "createIdempotencyKeyHash": string;
  "createRequestHash": string;
  "createdAt": string;
  "updatedAt": string;
  "cancelledByUserId": string | null;
  "cancelledAt": string | null;
  "reversedByUserId": string | null;
  "reversedAt": string | null;
  "reversalLedgerEventId": string | null;
  "reversalReason": string | null;
}
export declare const creditTopups: { readonly $inferSelect: CreditTopupsRow };

export interface CreditTransferPoliciesRow {
  "id": string;
  "scopeRef": string;
  "transferOutEnabled": boolean;
  "updatedBy": string | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const creditTransferPolicies: { readonly $inferSelect: CreditTransferPoliciesRow };

export interface GovernanceBudgetPoliciesRow {
  "id": string;
  "metric": string;
  "limitValue": number;
  "windowType": string;
  "windowSeconds": number | null;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const governanceBudgetPolicies: { readonly $inferSelect: GovernanceBudgetPoliciesRow };

export interface HistoryArchiveArtifactsRow {
  "archiveMonth": string;
  "domain": string;
  "schemaVersion": number;
  "rowCount": number;
  "compressedBytes": number;
  "uncompressedBytes": number;
  "objectKey": string;
  "objectSha256": string;
  "manifestObjectKey": string;
  "manifestSha256": string;
  "sourceSnapshotSha256": string;
  "createdAt": string;
}
export declare const historyArchiveArtifacts: { readonly $inferSelect: HistoryArchiveArtifactsRow };

export interface HistoryArchiveClosuresRow {
  "archiveMonth": string;
  "status": string;
  "sourceSnapshotSha256": string;
  "closureManifestObjectKey": string;
  "closureManifestSha256": string | null;
  "failureCode": string | null;
  "createdAt": string;
  "verifiedAt": string | null;
  "purgedAt": string | null;
}
export declare const historyArchiveClosures: { readonly $inferSelect: HistoryArchiveClosuresRow };

export interface HistoryArchiveFactRefsRow {
  "factKind": string;
  "factId": string;
  "requestId": string | null;
  "archiveMonth": string;
  "artifactDomain": string;
  "objectSha256": string;
  "rowKey": string;
  "occurredAt": string;
  "actorType": string | null;
  "actorId": string | null;
  "action": string | null;
  "resourceType": string | null;
  "resourceId": string | null;
  "result": string | null;
  "source": string | null;
  "amount": number | null;
  "buyerScopeRef": string | null;
  "sellerScopeRef": string | null;
  "providerOwnerScopeRef": string | null;
  "providerId": string | null;
  "createdAt": string;
}
export declare const historyArchiveFactRefs: { readonly $inferSelect: HistoryArchiveFactRefsRow };

export interface IngressPluginSettingsRow {
  "id": string;
  "pluginId": string;
  "scopeRef": string;
  "enabled": boolean;
  "configJson": string;
  "updatedByUserId": string | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const ingressPluginSettings: { readonly $inferSelect: IngressPluginSettingsRow };

export interface InstancePublicHostsRow {
  "id": string;
  "hostname": string;
  "enabled": boolean;
  "createdByUserId": string;
  "updatedByUserId": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const instancePublicHosts: { readonly $inferSelect: InstancePublicHostsRow };

export interface OidcAccessTokensRow {
  "id": string;
  "tokenHash": string;
  "userId": string;
  "clientId": string;
  "audience": string;
  "scope": string;
  "createdAt": string;
  "expiresAt": string;
  "revokedAt": string | null;
}
export declare const oidcAccessTokens: { readonly $inferSelect: OidcAccessTokensRow };

export interface OidcAuthorizationCodesRow {
  "id": string;
  "codeHash": string;
  "userId": string;
  "clientId": string;
  "redirectUri": string;
  "scope": string;
  "codeChallenge": string;
  "nonce": string;
  "createdAt": string;
  "expiresAt": string;
  "consumedAt": string | null;
}
export declare const oidcAuthorizationCodes: { readonly $inferSelect: OidcAuthorizationCodesRow };

export interface OidcRefreshTokensRow {
  "id": string;
  "tokenHash": string;
  "familyId": string;
  "userId": string;
  "clientId": string;
  "scope": string;
  "createdAt": string;
  "expiresAt": string;
  "consumedAt": string | null;
  "revokedAt": string | null;
  "replacedById": string | null;
}
export declare const oidcRefreshTokens: { readonly $inferSelect: OidcRefreshTokensRow };

export interface PartnerOperatingEntitlementsRow {
  "id": string;
  "sourceOrderId": string;
  "ownerUserId": string;
  "partnerTeamId": string;
  "partnerPlanId": string;
  "planSubscriptionId": string;
  "effectiveStart": string;
  "effectiveEnd": string;
  "lifecycle": string;
  "createdAt": string;
}
export declare const partnerOperatingEntitlements: { readonly $inferSelect: PartnerOperatingEntitlementsRow };

export interface PartnerTeamCreationAllocationsRow {
  "id": string;
  "sourceOrderId": string;
  "ownerUserId": string;
  "partnerPlanId": string;
  "durationSeconds": number;
  "consumedTeamId": string | null;
  "consumedAt": string | null;
  "createdAt": string;
}
export declare const partnerTeamCreationAllocations: { readonly $inferSelect: PartnerTeamCreationAllocationsRow };

export interface PasskeyCredentialsRow {
  "id": string;
  "userId": string;
  "credentialId": string;
  "publicKey": string;
  "signCount": number;
  "transportsJson": string;
  "deviceType": string;
  "backedUp": number;
  "rpId": string;
  "name": string;
  "createdAt": string;
  "lastUsedAt": string | null;
  "updatedAt": string;
}
export declare const passkeyCredentials: { readonly $inferSelect: PasskeyCredentialsRow };

export interface PaymentChannelInstructionAttachmentsRow {
  "id": string;
  "paymentChannelId": string;
  "storageKey": string;
  "contentType": string;
  "byteSize": number;
  "sha256": string;
  "createdByUserId": string;
  "createdAt": string;
}
export declare const paymentChannelInstructionAttachments: { readonly $inferSelect: PaymentChannelInstructionAttachmentsRow };

export interface PaymentChannelsRow {
  "id": string;
  "code": string;
  "displayName": string;
  "paymentNetwork": string;
  "paymentAsset": string;
  "settlementMode": string;
  "recipientIdentifierType": string;
  "transactionReferenceType": string;
  "recipientIdentifier": string;
  "recipientIdentifierDisplay": string;
  "normalizedRecipientIdentifierHash": string;
  "paymentInstruction": string | null;
  "status": string;
  "createdByUserId": string;
  "createdAt": string;
}
export declare const paymentChannels: { readonly $inferSelect: PaymentChannelsRow };

export interface PipelinePluginSettingsRow {
  "id": string;
  "pluginId": string;
  "scopeRef": string;
  "enabled": boolean;
  "configJson": string;
  "settingRevision": number;
  "configRevision": number;
  "updatedByUserId": string | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const pipelinePluginSettings: { readonly $inferSelect: PipelinePluginSettingsRow };

export interface PlanAccessPointPricesRow {
  "id": string;
  "planId": string;
  "accessPointId": string;
  "inputPer1M": number;
  "cachedInputPer1M": number;
  "cacheWritePer1M": number | null;
  "outputPer1M": number;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const planAccessPointPrices: { readonly $inferSelect: PlanAccessPointPricesRow };

export interface PlanAccessPointPriceTiersRow {
  "id": string;
  "planAccessPointPriceId": string;
  "serviceTier": string;
  "tierKey": string;
  "minInputTokens": number;
  "maxInputTokens": number | null;
  "inputPer1M": number;
  "cachedInputPer1M": number;
  "cacheWritePer1M": number | null;
  "outputPer1M": number;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const planAccessPointPriceTiers: { readonly $inferSelect: PlanAccessPointPriceTiersRow };

export interface PlanAccessPointsRow {
  "id": string;
  "planId": string;
  "accessPointId": string;
  "createdAt": string;
}
export declare const planAccessPoints: { readonly $inferSelect: PlanAccessPointsRow };

export interface PlanBudgetLimitsRow {
  "id": string;
  "planId": string;
  "limitScope": string;
  "metric": string;
  "limitValue": number;
  "windowType": string;
  "windowSeconds": number | null;
  "createdAt": string;
}
export declare const planBudgetLimits: { readonly $inferSelect: PlanBudgetLimitsRow };

export interface PlanPaymentListingsRow {
  "id": string;
  "planId": string;
  "paymentChannelId": string;
  "priceAmountUnits": number;
  "status": "enabled" | "disabled";
  "createdAt": string;
}
export declare const planPaymentListings: { readonly $inferSelect: PlanPaymentListingsRow };

export interface PlanPurchaseOrdersRow {
  "id": string;
  "buyerUserId": string;
  "planId": string;
  "planPaymentListingId": string | null;
  "paymentChannelId": string | null;
  "paymentKind": string;
  "paymentNetwork": string;
  "paymentAsset": string;
  "expectedPaymentAmountUnits": number;
  "stripeAmountMinor": number | null;
  "canonicalPurchaseAmountUnits": number;
  "useImmediately": boolean;
  "status": string;
  "checkoutSessionId": string | null;
  "paymentIntentId": string | null;
  "cardId": string | null;
  "creditLedgerEventId": string | null;
  "subscriptionId": string | null;
  "expiresAt": string | null;
  "fulfilledAt": string | null;
  "paymentFailedAt": string | null;
  "cancelledAt": string | null;
  "expiredAt": string | null;
  "reversedAt": string | null;
  "reversedByUserId": string | null;
  "reversalReason": string | null;
  "createIdempotencyKeyHash": string;
  "createRequestHash": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const planPurchaseOrders: { readonly $inferSelect: PlanPurchaseOrdersRow };

export interface PlansRow {
  "id": string;
  "ownerId": string;
  "scopeRef": string;
  "name": string;
  "version": number;
  "description": string | null;
  "adminNote": string | null;
  "billingMode": "prepaid" | "paygo";
  "purchaseAmount": number;
  "durationSeconds": number;
  "planStatus": "enabled" | "closed" | "disabled";
  "catalogStatus": "listed" | "unlisted";
  "createdAt": string;
  "updatedAt": string;
}
export declare const plans: { readonly $inferSelect: PlansRow };

export interface PlanSubscriptionsRow {
  "id": string;
  "planId": string;
  "source": string;
  "scopeRef": string;
  "purchasedByUserId": string | null;
  "fundingAccountId": string | null;
  "originCardId": string | null;
  "priority": number;
  "effectiveStart": string;
  "effectiveEnd": string | null;
  "subscriptionLifecycle": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const planSubscriptions: { readonly $inferSelect: PlanSubscriptionsRow };

export interface ProviderBindingsRow {
  "providerId": string;
  "authMethod": "oauth" | "api-key" | "credential-import";
  "credentialOwnership": "cpa-managed" | "linked";
  "credentialRefsJson": string;
  "credentialPreview": string | null;
  "revision": number;
  "syncStatus": "cleared" | "error" | "pending" | "ready";
  "errorCode": string | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const providerBindings: { readonly $inferSelect: ProviderBindingsRow };

export interface ProviderModelCostsRow {
  "id": string;
  "providerId": string;
  "providerModelName": string;
  "inputPer1M": number;
  "cachedInputPer1M": number;
  "cacheWritePer1M": number | null;
  "outputPer1M": number;
  "source": string;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const providerModelCosts: { readonly $inferSelect: ProviderModelCostsRow };

export interface ProviderModelCostTiersRow {
  "id": string;
  "providerModelCostId": string;
  "serviceTier": string;
  "tierKey": string;
  "minInputTokens": number;
  "maxInputTokens": number | null;
  "inputPer1M": number;
  "cachedInputPer1M": number;
  "cacheWritePer1M": number | null;
  "outputPer1M": number;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const providerModelCostTiers: { readonly $inferSelect: ProviderModelCostTiersRow };

export interface ProviderModelsRow {
  "id": string;
  "providerId": string;
  "providerModelName": string;
  "displayName": string;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const providerModels: { readonly $inferSelect: ProviderModelsRow };

export interface ProviderRetirementArchivesRow {
  "id": string;
  "providerId": string;
  "schemaVersion": number;
  "objectKey": string;
  "objectSha256": string;
  "manifestObjectKey": string;
  "manifestSha256": string;
  "actorType": string;
  "actorId": string;
  "requestId": string;
  "reason": string;
  "createdAt": string;
}
export declare const providerRetirementArchives: { readonly $inferSelect: ProviderRetirementArchivesRow };

export interface ProvidersRow {
  "id": string;
  "ownerId": string;
  "scopeRef": string;
  "name": string;
  "kind": string;
  "status": string;
  "baseUrlResolver": string;
  "credentialResolver": string;
  "modelsResolver": string;
  "configJson": string;
  "cpaInstanceId": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const providers: { readonly $inferSelect: ProvidersRow };

export interface RateLimitPoliciesRow {
  "id": string;
  "metric": string;
  "limitValue": number;
  "windowSeconds": number;
  "burstValue": number;
  "mode": string;
  "status": string;
  "createdAt": string;
}
export declare const rateLimitPolicies: { readonly $inferSelect: RateLimitPoliciesRow };

export interface RefreshTokensRow {
  "id": string;
  "userId": string;
  "tokenHash": string;
  "expiresAt": string;
  "revokedAt": string | null;
  "createdAt": string;
}
export declare const refreshTokens: { readonly $inferSelect: RefreshTokensRow };

export interface RequestCaptureDownloadSlotsRow {
  "slotId": number;
  "ownerToken": string | null;
  "acquiredAt": string | null;
}
export declare const requestCaptureDownloadSlots: { readonly $inferSelect: RequestCaptureDownloadSlotsRow };

export interface RequestCaptureSettingsRow {
  "id": string;
  "enabled": boolean;
  "updatedBy": string | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const requestCaptureSettings: { readonly $inferSelect: RequestCaptureSettingsRow };

export interface RequestExecutionLeasesRow {
  "requestId": string;
  "ownerId": string;
  "acquiredAt": string;
  "heartbeatAt": string;
  "leaseUntil": string;
}
export declare const requestExecutionLeases: { readonly $inferSelect: RequestExecutionLeasesRow };

export interface RequestLogArchiveEntriesRow {
  "requestId": string;
  "userId": string;
  "apiKeyId": string;
  "teamId": string | null;
  "startedAt": string;
  "status": string;
  "reqModel": string;
  "ingressHostname": string | null;
  "ingressRouteId": string | null;
  "archiveMonth": string;
}
export declare const requestLogArchiveEntries: { readonly $inferSelect: RequestLogArchiveEntriesRow };

export interface RequestLogArchivesRow {
  "archiveMonth": string;
  "formatVersion": number;
  "schemaVersion": number;
  "status": string;
  "rowCount": number;
  "compressedBytes": number;
  "uncompressedBytes": number;
  "objectKey": string;
  "objectSha256": string;
  "manifestObjectKey": string;
  "manifestSha256": string;
  "createdAt": string;
  "uploadedAt": string | null;
  "verifiedAt": string | null;
  "purgedAt": string | null;
}
export declare const requestLogArchives: { readonly $inferSelect: RequestLogArchivesRow };

export interface RequestLogsRow {
  "id": string;
  "apiKeyId": string;
  "userId": string;
  "teamId": string | null;
  "planId": string | null;
  "planSubscriptionId": string | null;
  "entryAccessPointId": string | null;
  "billingScopeRef": string | null;
  "providerId": string | null;
  "requestPath": string | null;
  "ingressHostname": string | null;
  "ingressRouteId": string | null;
  "reqModel": string;
  "tarModel": string | null;
  "ingressPluginsJson": string;
  "pipelinePluginsJson": string;
  "status": string;
  "errorCode": string | null;
  "credentialFailureReason": string | null;
  "startedAt": string;
  "endedAt": string | null;
}
export declare const requestLogs: { readonly $inferSelect: RequestLogsRow };

export interface RequestProviderAttemptsRow {
  "id": string;
  "requestId": string;
  "attemptIndex": number;
  "selectorAccessPointId": string;
  "selectorId": string;
  "selectorBehaviorVersion": number;
  "routingRevision": number;
  "candidateId": string;
  "selectorTargetEdgeId": string;
  "pathTargetEdgeIdsJson": string;
  "accessPointChainIdsJson": string;
  "providerId": string;
  "providerModelName": string;
  "outcome": string;
  "failureClass": string | null;
  "failureReason": string | null;
  "outputCommitted": boolean;
  "trustedUsageSource": string | null;
  "startedAt": string;
  "endedAt": string | null;
}
export declare const requestProviderAttempts: { readonly $inferSelect: RequestProviderAttemptsRow };

export interface ResourcePermissionsRow {
  "id": string;
  "resourceType": string;
  "resourceId": string;
  "action": string;
  "subjectType": string;
  "subjectRef": string;
  "subjectRole": string | null;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const resourcePermissions: { readonly $inferSelect: ResourcePermissionsRow };

export interface SchemaMetaRow {
  "key": string;
  "value": string;
  "updatedAt": string;
}
export declare const schemaMeta: { readonly $inferSelect: SchemaMetaRow };

export interface ScopeBudgetPoliciesRow {
  "id": string;
  "scopeRef": string;
  "budgetPolicyId": string;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const scopeBudgetPolicies: { readonly $inferSelect: ScopeBudgetPoliciesRow };

export interface ScopeGovernanceBudgetPoliciesRow {
  "id": string;
  "scopeRef": string;
  "governanceBudgetPolicyId": string;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const scopeGovernanceBudgetPolicies: { readonly $inferSelect: ScopeGovernanceBudgetPoliciesRow };

export interface ScopeRateLimitPoliciesRow {
  "id": string;
  "scopeRef": string;
  "rateLimitPolicyId": string;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const scopeRateLimitPolicies: { readonly $inferSelect: ScopeRateLimitPoliciesRow };

export interface SellerSettlementEventsRow {
  "id": string;
  "planSubscriptionId": string | null;
  "authorityPurchaseId": string | null;
  "sellerScopeRef": string;
  "windowStart": string;
  "windowEnd": string;
  "releaseAt": string;
  "eventType": string;
  "amountUnits": number;
  "sourceType": string;
  "sourceId": string;
  "createdAt": string;
}
export declare const sellerSettlementEvents: { readonly $inferSelect: SellerSettlementEventsRow };

export interface SellerSettlementWindowsRow {
  "windowKey": string;
  "planSubscriptionId": string | null;
  "authorityPurchaseId": string | null;
  "sellerScopeRef": string;
  "windowStart": string;
  "windowEnd": string;
  "releaseAt": string;
  "nextAttemptAt": string;
  "status": string;
  "updatedAt": string;
}
export declare const sellerSettlementWindows: { readonly $inferSelect: SellerSettlementWindowsRow };

export interface ServiceFulfillmentsRow {
  "id": string;
  "orderId": string;
  "effectType": string;
  "targetType": string | null;
  "targetId": string | null;
  "status": string;
  "initiatedByUserId": string;
  "completedByUserId": string | null;
  "errorCode": string | null;
  "createdAt": string;
  "completedAt": string | null;
  "updatedAt": string;
}
export declare const serviceFulfillments: { readonly $inferSelect: ServiceFulfillmentsRow };

export interface ServiceOrdersRow {
  "id": string;
  "buyerUserId": string;
  "targetPartnerTeamId": string | null;
  "productId": string;
  "productListingId": string;
  "paymentChannelId": string;
  "productCode": string;
  "productVersion": number;
  "productDisplayName": string;
  "fulfillmentEffect": string;
  "durationSeconds": number;
  "partnerPlanId": string;
  "purchaseIntent": string;
  "expectedPaymentAmountUnits": number;
  "confirmedReceivedAmountUnits": number | null;
  "paymentAsset": string;
  "paymentNetwork": string;
  "normalizedTransactionReferenceHash": string | null;
  "transactionReferenceTail": string | null;
  "paymentSubmittedAt": string | null;
  "reviewedByUserId": string | null;
  "reviewedAt": string | null;
  "reviewNote": string | null;
  "status": string;
  "createIdempotencyKeyHash": string;
  "createRequestHash": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const serviceOrders: { readonly $inferSelect: ServiceOrdersRow };

export interface ServiceProductListingsRow {
  "id": string;
  "productId": string;
  "paymentChannelId": string;
  "priceAmountUnits": number;
  "status": string;
  "createdAt": string;
}
export declare const serviceProductListings: { readonly $inferSelect: ServiceProductListingsRow };

export interface ServiceProductsRow {
  "id": string;
  "code": string;
  "version": number;
  "displayName": string;
  "description": string | null;
  "fulfillmentEffect": string;
  "durationSeconds": number;
  "partnerPlanId": string;
  "status": string;
  "createdByUserId": string;
  "createdAt": string;
}
export declare const serviceProducts: { readonly $inferSelect: ServiceProductsRow };

export interface StripeWebhookEventsRow {
  "eventId": string;
  "eventType": string;
  "livemode": boolean;
  "checkoutSessionTail": string | null;
  "topupId": string | null;
  "planPurchaseOrderId": string | null;
  "status": string;
  "errorCode": string | null;
  "createdAt": string;
  "updatedAt": string;
  "processedAt": string | null;
}
export declare const stripeWebhookEvents: { readonly $inferSelect: StripeWebhookEventsRow };

export interface TeamDeletionLifecyclesRow {
  "id": string;
  "teamId": string;
  "requestedAt": string;
  "requestedByUserId": string;
  "purgeNotBefore": string;
  "archiveStatus": string;
  "archiveManifestId": string | null;
  "archiveManifestObjectKey": string | null;
  "archiveManifestSha256": string | null;
  "archiveCoverageJson": string | null;
  "archivedAt": string | null;
  "cancelledAt": string | null;
  "purgedAt": string | null;
}
export declare const teamDeletionLifecycles: { readonly $inferSelect: TeamDeletionLifecyclesRow };

export interface TeamInviteLinksRow {
  "id": string;
  "teamId": string;
  "createdByUserId": string;
  "maxUses": number | null;
  "usedCount": number | null;
  "activeLimitExempt": number;
  "status": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const teamInviteLinks: { readonly $inferSelect: TeamInviteLinksRow };

export interface TeamMembershipsRow {
  "id": string;
  "teamId": string;
  "userId": string;
  "rolesJson": string;
  "byInviteLink": string | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const teamMemberships: { readonly $inferSelect: TeamMembershipsRow };

export interface TeamProviderEntitlementsRow {
  "id": string;
  "teamId": string;
  "sourceKind": string;
  "sourceAuthorityPurchaseId": string | null;
  "sourceAuthorityProductId": string | null;
  "sourceProductCodeSnapshot": string | null;
  "sourceProductVersionSnapshot": number | null;
  "sourceProductDisplayNameSnapshot": string | null;
  "buyerUserId": string | null;
  "issuedByUserId": string | null;
  "effectiveStart": string;
  "effectiveEnd": string | null;
  "lifecycle": string;
  "canceledAt": string | null;
  "canceledByUserId": string | null;
  "cancelReasonCode": string | null;
  "idempotencyKeyHash": string | null;
  "requestHash": string | null;
  "createdAt": string;
}
export declare const teamProviderEntitlements: { readonly $inferSelect: TeamProviderEntitlementsRow };

export interface TeamsRow {
  "id": string;
  "ownerId": string;
  "name": string;
  "status": string;
  "teamOwnerCanManageMemberApiKeyLimit": number;
  "teamOwnerCanManageMemberCredit": number;
  "teamOwnerCanCreateCustomProvider": number;
  "teamOwnerCanCreateAccessPoint": number;
  "inviteEmailDomainPattern": string | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const teams: { readonly $inferSelect: TeamsRow };

export interface UserModelPlanScopeOrdersRow {
  "id": string;
  "userId": string;
  "exposedModel": string;
  "planId": string;
  "subscriptionScopeRef": string;
  "position": number;
  "defaultPriority": number;
  "defaultEffectiveStart": string;
  "defaultSourceCreatedAt": string;
  "defaultSourceId": string;
  "createdAt": string;
  "updatedAt": string;
}
export declare const userModelPlanScopeOrders: { readonly $inferSelect: UserModelPlanScopeOrdersRow };

export interface UsersRow {
  "id": string;
  "teamId": string | null;
  "email": string;
  "passwordHash": string;
  "authVersion": number;
  "status": string;
  "adminNote": string | null;
  "apiKeyLimit": number;
  "userCanCreateCustomProvider": number;
  "userCanCreateAccessPoint": number;
  "createdAt": string;
  "updatedAt": string;
}
export declare const users: { readonly $inferSelect: UsersRow };

export interface WebauthnCeremoniesRow {
  "sessionHash": string;
  "challengeHash": string;
  "purpose": string;
  "surface": string;
  "userId": string | null;
  "expectedAuthVersion": number | null;
  "rpId": string;
  "origin": string;
  "passkeyName": string | null;
  "expiresAt": string;
  "createdAt": string;
}
export declare const webauthnCeremonies: { readonly $inferSelect: WebauthnCeremoniesRow };

export interface WebauthnUserHandlesRow {
  "userId": string;
  "userHandle": string;
  "createdAt": string;
}
export declare const webauthnUserHandles: { readonly $inferSelect: WebauthnUserHandlesRow };

export interface WebRegistrationSettingsRow {
  "id": string;
  "defaultTeamId": string | null;
  "registrationInviteLinkId": string | null;
  "updatedByUserId": string | null;
  "createdAt": string;
  "updatedAt": string;
}
export declare const webRegistrationSettings: { readonly $inferSelect: WebRegistrationSettingsRow };
