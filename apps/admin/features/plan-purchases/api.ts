import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { OwnerPlanPurchaseOrder } from "../../lib/plan-purchase";

export async function createPlanPaymentListing(input: { planId: string; paymentChannelId: string; priceAmountUnits: number }) {
  const response = await fetch("/api/owner/plan-payment-listings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  return readConsoleApiResponse<{ id: string }>(response, "Create Plan payment listing failed");
}

export async function disablePlanPaymentListing(listingId: string) {
  const response = await fetch(`/api/owner/plan-payment-listings/${encodeURIComponent(listingId)}/disable`, { method: "POST" });
  return readConsoleApiResponse<{ id: string }>(response, "Disable Plan payment listing failed");
}

export async function reversePlanPurchaseOrder(input: { orderId: string; reason: string }) {
  const response = await fetch(`/api/owner/plan-purchase-orders/${encodeURIComponent(input.orderId)}/reverse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: input.reason })
  });
  return readConsoleApiResponse<{ order: OwnerPlanPurchaseOrder; replayed: boolean }>(response, "Reverse Plan purchase failed");
}

export async function fetchPlanPurchaseOrderDetail(orderId: string) {
  const response = await fetch(`/api/owner/plan-purchase-orders/${encodeURIComponent(orderId)}`);
  return readConsoleApiResponse<{
    order: OwnerPlanPurchaseOrder;
    buyer: { id: string; email: string } | null;
    plan: { id: string; name: string; version: number } | null;
    listing: { id: string; priceAmountUnits: number } | null;
    paymentChannel: { id: string; displayName: string; paymentAsset: string } | null;
  }>(response, "Load Plan purchase detail failed");
}
