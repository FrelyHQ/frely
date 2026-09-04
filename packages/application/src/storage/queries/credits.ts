import type * as applicationModels from "../application-model-contracts.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type CursorPageResult, type DirectoryPageSize, type PageResult } from "./pagination.js";

export interface CreditAccountDirectoryInput {
  page?: number;
  pageSize?: number;
  query?: string;
}

export interface UserCreditAccountDirectoryRow {
  userId: string;
  userEmail: string;
  teamId: string | null;
  teamName: string | null;
  accountId: string | null;
  balanceSnapUnits: number;
  transferOutEnabled: boolean;
  accountStatus: string;
  latestLedgerAt: string | null;
}

export interface NonUserCreditAccountDirectoryRow {
  id: string;
  scopeRef: string;
  balanceSnapUnits: number;
  status: string;
  latestLedgerAt: string | null;
}

export interface CreditDirectorySummary {
  userBalanceUnits: number;
  userAccountCount: number;
  negativeUserCount: number;
  nonUserBalanceUnits: number;
  nonUserAccountCount: number;
  transferDisabledUserCount: number;
}
export interface CreditConfigurationSummary {
  productCount: number;
  paymentChannelCount: number;
  draftPaymentChannelCount: number;
  enabledListingCount: number;
}
export interface CreditProductCandidate {
  id: string;
  code: string;
  displayName: string;
  creditedAmountUnits: number;
  status: string;
}
export interface PaymentChannelCandidate {
  id: string;
  code: string;
  displayName: string;
  paymentNetwork: string;
  paymentAsset: string;
  status: string;
}
export interface DraftPaymentChannelRow extends PaymentChannelCandidate {
  settlementMode: string;
}
export interface UserCardRow {
  id: string;
  cardType: "plan" | "credit";
  issuanceType: "purchase" | "admin_grant" | "external_activation";
  ownerUserId: string;
  planId: string | null;
  planName: string | null;
  planVersion: number | null;
  planStatus: "enabled" | "closed" | "disabled" | null;
  creditProductId: string | null;
  creditProductName: string | null;
  creditAmountUnits: number | null;
  createdAt: string;
  usedAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  expiresAt: string;
  replacesCardId: string | null;
  status: UserCardStatus;
  replacedByCardId: string | null;
  canUse: boolean;
  canSend: boolean;
  useReasonCode: UserCardActionReasonCode | null;
  sendReasonCode: UserCardActionReasonCode | null;
}
export type UserCardStatus = "available" | "replaced" | "invalidated" | "used" | "expired";
export type UserCardActionReasonCode =
  | "card_replaced"
  | "card_invalidated"
  | "card_used"
  | "card_expired"
  | "plan_closed"
  | "plan_disabled";
export interface UserPlanCardInventoryItem {
  kind: "plan";
  planId: string;
  planName: string;
  planVersion: number;
  planStatus: "enabled" | "closed" | "disabled";
  totalCount: number;
  availableCount: number;
  replacedCount: number;
  invalidatedCount: number;
  usedCount: number;
  expiredCount: number;
  nearestAvailableExpiresAt: string | null;
  latestCreatedAt: string;
}
export interface UserCreditCardInventoryItem {
  kind: "credit";
  card: UserCardRow;
}
export type UserCardInventoryItem = UserPlanCardInventoryItem | UserCreditCardInventoryItem;
export type UserCardInventoryStatusFilter = "available" | "all";
interface UserCardInventoryProjectionRow {
  kind: "plan" | "credit";
  stableKey: string;
  latestCreatedAt: string;
  planId: string | null;
  planName: string | null;
  planVersion: number | null;
  planStatus: "enabled" | "closed" | "disabled" | null;
  totalCount: number | null;
  availableCount: number | null;
  replacedCount: number | null;
  invalidatedCount: number | null;
  usedCount: number | null;
  expiredCount: number | null;
  nearestAvailableExpiresAt: string | null;
  id: string | null;
  issuanceType: "purchase" | "admin_grant" | "external_activation" | null;
  ownerUserId: string | null;
  creditProductId: string | null;
  creditProductName: string | null;
  creditAmountUnits: number | null;
  createdAt: string | null;
  usedAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  expiresAt: string | null;
  replacesCardId: string | null;
  cardStatus: UserCardStatus | null;
  replacedByCardId: string | null;
}
export interface UserCardTransferRow {
  id: string;
  cardId: string;
  fromUserId: string;
  toUserId: string;
  referenceCode: string | null;
  note: string | null;
  createdAt: string;
}
export interface UserCreditCatalogAttachment {
  id: string;
  contentType: string;
  byteSize: number;
}
export interface UserCreditCatalogListing {
  id: string;
  productId: string;
  paymentChannelId: string;
  priceAmountUnits: number;
  status: string;
  paymentChannel: {
    id: string;
    code: string;
    displayName: string;
    paymentNetwork: string;
    paymentAsset: string;
    settlementMode: string;
    recipientIdentifierType: string;
    transactionReferenceType: string;
    recipientIdentifierDisplay: string;
    paymentInstruction: string | null;
    status: string;
    instructionAttachments: UserCreditCatalogAttachment[];
    attachmentTotal: number;
    attachmentHasMore: boolean;
  };
}
export interface UserCreditCatalogProduct {
  id: string;
  code: string;
  displayName: string;
  description: string | null;
  creditedAmountUnits: number;
  status: string;
  displayOrder: number;
  createdAt: string;
  listings: UserCreditCatalogListing[];
  listingTotal: number;
  listingHasMore: boolean;
}
export interface CreditTopupAttachmentRow {
  id: string;
  topupId: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  uploadedByUserId: string;
  attachmentPurpose: string;
  createdAt: string;
}
export type CreditAccountRow = applicationModels.CreditAccountsRow;
export type CreditProductRow = applicationModels.CreditProductsRow;
export type PaymentChannelRow = applicationModels.PaymentChannelsRow;
export type CreditProductListingRow = applicationModels.CreditProductListingsRow;
export type CreditTransferPolicyRow = applicationModels.CreditTransferPoliciesRow;
export interface OwnerPaymentChannelRow extends PaymentChannelRow { instructionAttachmentCount: number; }

export interface AdminCreditTopupHistoryRow {
  id: string;
  userId: string;
  userEmail: string;
  status: string;
  settlementMode: string;
  cardId: string | null;
  creditedAmountUnits: number;
  expectedPaymentAmountUnits: number;
  confirmedReceivedAmountUnits: number | null;
  paymentAsset: string;
  paymentNetwork: string;
  transactionReference: string | null;
  transactionReferenceTail: string | null;
  reviewedByUserId: string | null;
  refundRecordedAt: string | null;
  attachmentCount: number;
  duplicateEvidence: boolean;
  createdAt: string;
}

export interface UserCreditTopupHistoryRow {
  id: string;
  status: string;
  creditedAmountUnits: number;
  expectedPaymentAmountUnits: number;
  paymentAsset: string;
  paymentNetwork: string;
  transactionReferenceTail: string | null;
  expiresAt: string;
  attachmentCount: number;
  createdAt: string;
}

export interface CreditLedgerHistoryRow {
  id: string;
  accountId: string;
  eventType: string;
  amountUnits: number;
  transferId: string | null;
  relatedEventId: string | null;
  planSubscriptionId: string | null;
  billingEventId: string | null;
  relatedTopupId: string | null;
  cardId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  reason: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export class CreditCursorError extends Error {
  readonly code = "invalid_credit_cursor";
}

type CreditCursorKind = "topup" | "ledger";
type CreditCursor = { kind: CreditCursorKind; createdAt: string; id: string };
