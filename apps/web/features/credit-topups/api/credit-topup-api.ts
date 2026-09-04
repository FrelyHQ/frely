import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { CreditTopupIntent } from "@frely/console-ui/credit-topup";
import { cardPurchaseRequest } from "../../../lib/card-purchase-ui";

export async function mutateCreditTopup(input: CreditTopupIntent) {
  if (input.kind === "cancel") {
    const response = await fetch(`/api/user/credit-topups/${encodeURIComponent(input.topupId)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await readConsoleApiResponse<unknown>(response, "Cancel failed");
    return;
  }
  const response = await fetch("/api/user/credit-topups", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey }, body: JSON.stringify(cardPurchaseRequest("productListingId", input.listingId, input.useImmediately)) });
  const created = await readConsoleApiResponse(response, "Create topup failed", parseCreatedResource);
  if (input.transactionReference) {
    const referenceResponse = await fetch(`/api/user/credit-topups/${encodeURIComponent(created.id)}/payment-reference`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transactionReference: input.transactionReference }) });
    await readConsoleApiResponse<unknown>(referenceResponse, "Submit reference failed");
  }
  if (input.receipt) {
    const form = new FormData(); form.set("file", input.receipt);
    const attachmentResponse = await fetch(`/api/user/credit-topups/${encodeURIComponent(created.id)}/attachments`, { method: "POST", body: form });
    await readConsoleApiResponse<unknown>(attachmentResponse, "Upload evidence failed");
  }
}

export async function createStripeCheckout(input: { listingId: string; useImmediately: boolean; idempotencyKey: string }) {
  const response = await fetch("/api/user/stripe/checkout", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey }, body: JSON.stringify({ productListingId: input.listingId, useImmediately: input.useImmediately }) });
  const result = await readConsoleApiResponse(response, "Create Stripe Checkout failed", parseStripeCheckout);
  return result.checkoutUrl;
}

function parseCreatedResource(value: unknown): { id: string } {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !value.id) {
    throw new Error("Invalid created resource");
  }
  return { id: value.id };
}

function parseStripeCheckout(value: unknown): { checkoutUrl: string } {
  if (!value || typeof value !== "object" || !("checkoutUrl" in value) || typeof value.checkoutUrl !== "string") {
    throw new Error("Invalid Stripe Checkout response");
  }
  const url = new URL(value.checkoutUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid Stripe Checkout URL");
  return { checkoutUrl: url.toString() };
}
