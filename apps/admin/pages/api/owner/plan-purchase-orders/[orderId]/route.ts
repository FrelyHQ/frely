import { RelayError } from "@frely/core";
import { ownerPlanPurchaseOrder } from "../../../../../lib/plan-purchase";
import { handle, json, services } from "../../../../../lib/server";

interface Context {
  params: Promise<{ orderId: string }>;
}

export async function GET(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    await asyncTenancy.requireOwner(request.headers);
    const { orderId } = await context.params;
    const order = await application.billingQueries.getPlanPurchaseOrder(orderId);
    if (!order) throw new RelayError("plan_purchase_order_not_found", "Plan purchase order not found", 404);
    const [buyer, plan, listing, paymentChannel] = await Promise.all([
        asyncTenancy.identity.getUser(order.buyerUserId),
        application.queries.getPlan(order.planId),
        order.planPaymentListingId ? application.billingQueries.getPlanPaymentListing(order.planPaymentListingId) : undefined,
        order.paymentChannelId ? application.billingQueries.getPaymentChannel(order.paymentChannelId) : undefined,
      ]);
    return json({
      order: ownerPlanPurchaseOrder(order),
      buyer: buyer ? { id: order.buyerUserId, email: buyer.email } : null,
      plan,
      listing: listing ?? null,
      paymentChannel: paymentChannel ?? null
    });
  });
}
