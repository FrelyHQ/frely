import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { PlanPurchaseInput, PlanPurchaseOrderStatus, PlanPurchaseResponse } from "../types";

export async function purchasePlan(input: PlanPurchaseInput): Promise<PlanPurchaseResponse> {
  const response = await fetch("/api/user/plan-purchases", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
    body: JSON.stringify({ planId: input.planId, useImmediately: input.useImmediately, payment: input.payment })
  });
  return readConsoleApiResponse<PlanPurchaseResponse>(response, "Plan purchase failed");
}

export async function fetchPlanPurchaseOrder(orderId: string, signal?: AbortSignal): Promise<PlanPurchaseOrderStatus> {
  const response = await fetch(`/api/user/plan-purchases/${encodeURIComponent(orderId)}`, signal ? { signal } : undefined);
  return readConsoleApiResponse<PlanPurchaseOrderStatus>(response, "Load Plan purchase status failed");
}

export async function cancelPlanPurchaseOrder(orderId: string): Promise<PlanPurchaseOrderStatus> {
  const response = await fetch(`/api/user/plan-purchases/${encodeURIComponent(orderId)}/cancel`, { method: "POST" });
  return readConsoleApiResponse<PlanPurchaseOrderStatus>(response, "Cancel Plan purchase failed");
}
