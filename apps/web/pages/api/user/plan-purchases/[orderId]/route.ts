import { RelayError } from "@frely/core";
import { publicPlanPurchaseOrder } from "../../../../../lib/plan-purchase";
import { handle, json, services } from "../../../../../lib/server";

interface Context {
  params: Promise<{ orderId: string }>;
}

export async function GET(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    const { orderId } = await context.params;
    const order = await application.billingQueries.getPlanPurchaseOrderForUser(orderId, claims.sub);
    if (!order) throw new RelayError("plan_purchase_order_not_found", "Plan purchase order not found", 404);
    return json(publicPlanPurchaseOrder(order));
  });
}
