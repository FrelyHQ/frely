import type { AdminCreditUserRow } from "../../lib/teams";

export type { AdminCreditUserRow };

export interface CreditUserOption { id: string; email: string }
export interface CreditProduct { id: string; code: string; displayName: string; creditedAmountUnits: number; status: string }
export interface PaymentChannel { id: string; code: string; displayName: string; paymentNetwork: string; paymentAsset: string; status: string; instructionAttachments: Array<{ id: string }> }
export type PaymentChannelCandidate = Omit<PaymentChannel, "instructionAttachments">;
export interface CreditProductListing { id: string; productId: string; paymentChannelId: string; priceAmountUnits: number; status: string }
export interface CreditCandidatePage<T> { items: T[]; page: number; pageSize: 20; total: number; totalPages: number }
export interface CreditConfigurationSummary { productCount: number; paymentChannelCount: number; draftPaymentChannelCount: number; enabledListingCount: number }
export interface CreditTopup { id: string; userId: string; userEmail: string; status: string; settlementMode: string; cardId: string | null; creditedAmountUnits: number; expectedPaymentAmountUnits: number; confirmedReceivedAmountUnits: number | null; paymentAsset: string; paymentNetwork: string; transactionReference: string | null; transactionReferenceTail: string | null; reviewedByUserId: string | null; refundRecordedAt: string | null; attachmentCount: number; duplicateEvidence: boolean; createdAt: string }
export interface CreditScopeSummary { id: string; scopeRef: string; balance: string; status: string; latestLedgerAt: string; latestLedgerAtIso: string | null }
