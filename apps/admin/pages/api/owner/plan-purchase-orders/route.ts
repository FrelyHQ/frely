import { RelayError } from "@frely/core";
import type { PlanPurchaseOrderStatus } from "@frely/ui-application/contracts";
import { ownerPlanPurchaseOrder } from "../../../../lib/plan-purchase";
import { handle, json, services } from "../../../../lib/server";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    await asyncTenancy.requireOwner(request.headers);
    const params = new URL(request.url).searchParams;
    const allowed = ["status", "buyerUserId", "planId", "currency", "page"];
    const unsupported = Array.from(params.keys()).find((key) => !allowed.includes(key));
    if (unsupported) throw new RelayError("invalid_plan_purchase_order_query", `Unsupported query parameter: ${unsupported}`, 400);
    const status = params.get("status")?.trim() || undefined;
    if (status && !["pending_payment", "fulfilled", "payment_failed", "cancelled", "expired", "reversed"].includes(status)) throw new RelayError("invalid_plan_purchase_order_status", "Invalid Plan purchase order status", 400);
    const page = pageParam(params);
    const buyerUserId = params.get("buyerUserId")?.trim() || undefined;
    const planId = params.get("planId")?.trim() || undefined;
    const paymentAsset = params.get("currency")?.trim() || undefined;
    const input = {
      ...(status ? { status: status as PlanPurchaseOrderStatus } : {}),
      ...(buyerUserId ? { buyerUserId } : {}),
      ...(planId ? { planId } : {}),
      ...(paymentAsset ? { paymentAsset } : {}),
      page
    };
    const result = await application.billingQueries.pagePlanPurchaseOrders(input);
    return json({ ...result, items: result.items.map(ownerPlanPurchaseOrder) });
  });
}

function pageParam(params: URLSearchParams) {
  const raw = params.get("page");
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new RelayError("invalid_pagination", "page must be between 1 and 10000", 400);
  return value;
}
