import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { CreditListingFormValues, CreditProductFormValues, PaymentChannelFormValues } from "../form/credit-form-values";
import { toCreditListingInput, toPaymentChannelInput } from "../form/credit-form-values";
import type { CreditCandidatePage, CreditProduct, CreditProductListing, PaymentChannel, PaymentChannelCandidate } from "../types";
import { approveCreditTopupRequest, creditProductRequest, paymentChannelInstructionUploadUrl } from "./credit-api-contracts";

async function post<T>(url: string, body: object, fallback: string) { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return readConsoleApiResponse<T>(response, fallback); }
export const createCreditProduct = ({ value, displayOrder }: { value: CreditProductFormValues; displayOrder: number }) => { const request = creditProductRequest(value, displayOrder); return post<CreditProduct>(request.url, request.body, "Create credit product failed"); };
export const createPaymentChannel = (value: PaymentChannelFormValues) => post<PaymentChannel>("/api/owner/payment-channels", toPaymentChannelInput(value), "Create payment channel failed");
export const createCreditProductListing = (value: CreditListingFormValues) => post<CreditProductListing>("/api/owner/credit-product-listings", toCreditListingInput(value), "Create credit listing failed");
export const enablePaymentChannel = (channelId: string) => post<PaymentChannel>(`/api/owner/payment-channels/${encodeURIComponent(channelId)}/enable`, {}, "Enable payment channel failed");
export const approveCreditTopup = ({ id, amount }: { id: string; amount: number }) => { const request = approveCreditTopupRequest(id, amount); return post<unknown>(request.url, request.body, "Approve credit topup failed"); };
export const rejectCreditTopup = (id: string) => post<unknown>(`/api/owner/credit-topups/${encodeURIComponent(id)}/reject`, { reviewNote: "payment could not be verified" }, "Reject credit topup failed");
export const reverseCreditTopup = (id: string) => post<unknown>(`/api/owner/credit-topups/${encodeURIComponent(id)}/reverse`, { reversalReason: "manual reversal" }, "Reverse credit topup failed");
export const recordCreditTopupRefund = (id: string) => post<unknown>(`/api/owner/credit-topups/${encodeURIComponent(id)}/refund-note`, { refundNote: "external refund recorded manually" }, "Record refund failed");
export const createCreditLedgerEvent = (input: { scopeRef: string; eventType: string; amountUnits: number; reason: string; relatedEventId: string | null }) => post<unknown>("/api/owner/credit-ledger-events", input, "Create ledger event failed");
export async function uploadPaymentChannelInstruction({ channelId, file }: { channelId: string; file: File }) { const form = new FormData(); form.set("file", file); const response = await fetch(paymentChannelInstructionUploadUrl(channelId), { method: "POST", body: form }); return readConsoleApiResponse<unknown>(response, "Upload payment instruction failed"); }

export async function fetchCreditProductCandidates(query: string, page: number, signal?: AbortSignal) {
  return getCandidates<CreditProduct>("/api/owner/credit-product-candidates", query, page, signal);
}

export async function fetchPaymentChannelCandidates(query: string, page: number, signal?: AbortSignal) {
  return getCandidates<PaymentChannelCandidate>("/api/owner/payment-channel-candidates", query, page, signal);
}

async function getCandidates<T>(path: string, query: string, page: number, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const response = await fetch(`${path}?${params}`, signal ? { signal } : {});
  return readConsoleApiResponse<CreditCandidatePage<T>>(response, "Failed to load Credit configuration candidates");
}
