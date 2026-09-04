import { RelayError } from "@frely/core";
import { publicPlanPurchaseOrder } from "../../../../../../lib/plan-purchase";
import { assertProductionHttps, handle, json, services } from "../../../../../../lib/server";
import { stripeClient } from "../../../../../../lib/stripe";

interface Context {
  params: Promise<{ orderId: string }>;
}

export async function POST(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, application, config } = await services();
    assertProductionHttps(request, config, "Stripe Plan Checkout cancellation");
    const claims = await asyncTenancy.requireUser(request.headers);
    const { orderId } = await context.params;
    const order = await application.billingQueries.getPlanPurchaseOrderForUser(orderId, claims.sub);
    if (!order) throw new RelayError("plan_purchase_order_not_found", "Plan purchase order not found", 404);
    if (order.status === "cancelled" || order.status === "expired") return json(publicPlanPurchaseOrder(order));
    if (order.status !== "pending_payment" || order.paymentKind !== "payment_listing") throw new RelayError("plan_purchase_not_cancelable", "Only pending external Plan purchases can be cancelled", 409);
    if (order.checkoutSessionId) {
      const stripe = stripeClient(config.app.environment);
      const session = await stripe.checkout.sessions.retrieve(order.checkoutSessionId);
      if (session.status === "complete") throw new RelayError("stripe_checkout_already_complete", "Completed Stripe Checkout cannot be cancelled", 409);
      if (session.status !== "open") throw new RelayError("stripe_checkout_not_open", "Only an open Stripe Checkout Session can be cancelled", 409);
      await stripe.checkout.sessions.expire(session.id);
      const afterExpire = await application.billingQueries.getPlanPurchaseOrderForUser(order.id, claims.sub);
      if (afterExpire?.status === "expired") return json(publicPlanPurchaseOrder(afterExpire));
    }
    const cancelled = await application.billingCommands.cancelUserPlanPurchaseOrder({ orderId: order.id, buyerUserId: claims.sub });
    return json(publicPlanPurchaseOrder(cancelled));
  });
}
