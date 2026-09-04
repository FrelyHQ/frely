import type { CreditProductFormValues } from "../form/credit-form-values";
import { toCreditProductInput } from "../form/credit-form-values";

export function creditProductRequest(value: CreditProductFormValues, displayOrder: number) { return { url: "/api/owner/credit-products", body: toCreditProductInput(value, displayOrder) }; }
export function approveCreditTopupRequest(id: string, amount: number) { return { url: `/api/owner/credit-topups/${encodeURIComponent(id)}/approve`, body: { confirmedReceivedAmountUnits: amount, reviewNote: "confirmed offline payment" } }; }
export function paymentChannelInstructionUploadUrl(channelId: string) { return `/api/owner/payment-channels/${encodeURIComponent(channelId)}/instruction-attachments`; }
