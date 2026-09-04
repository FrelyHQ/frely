import { RelayError } from "@frely/core";
import { ownerPlanPurchaseOrder } from "../../../../../../lib/plan-purchase";
import { bodyJson, handle, json, services } from "../../../../../../lib/server";

interface Context {
  params: Promise<{ orderId: string }>;
}

export async function POST(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, billingCommerce } = await services();
    const claims = await asyncTenancy.requireOwner(request.headers);
    const body = await bodyJson<Record<string, unknown>>(request);
    if (typeof body.reason !== "string" || !body.reason.trim()) throw new RelayError("plan_purchase_reverse_reason_required", "reason is required", 400);
    const { orderId } = await context.params;
    const result = await billingCommerce.reversePlanPurchaseOrder({ orderId, ownerUserId: claims.sub, reason: body.reason });
    return json({
      order: ownerPlanPurchaseOrder(result.order),
      cardId: result.card?.id ?? result.order.cardId,
      subscriptionId: result.subscription?.id ?? result.order.subscriptionId,
      replayed: result.replayed
    });
  });
}
