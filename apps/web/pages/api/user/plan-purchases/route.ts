import { RelayError } from "@frely/core";
import { assertProductionHttps, bodyJson, handle, json, services } from "../../../../lib/server";
import { stripeClient, stripePaymentMethodConfiguration, stripePlanIntegrationIdentifier } from "../../../../lib/stripe";

type PurchaseBody = {
  planId?: unknown;
  useImmediately?: unknown;
  payment?: unknown;
};

export async function POST(request: Request) {
  return handle(request, async ({ hostScope }) => {
    const { asyncTenancy, billingCommerce, application, config } = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    const body = await bodyJson<PurchaseBody>(request);
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    if (!planId) throw new RelayError("plan_id_required", "planId is required", 400);
    if (typeof body.useImmediately !== "boolean") throw new RelayError("plan_purchase_use_immediately_required", "useImmediately must be a boolean", 400);
    const payment = parsePayment(body.payment);
    if (payment.kind === "payment_listing") assertProductionHttps(request, config, "Stripe Plan Checkout");
    const purchaseInput = {
      planId,
      buyerUserId: claims.sub,
      useImmediately: body.useImmediately,
      idempotencyKey: request.headers.get("idempotency-key") ?? "",
      payment
    };
    const result = await billingCommerce.createPlanPurchaseOrder(purchaseInput);
    if (result.order.status === "fulfilled") {
      if (!result.card) throw new RelayError("plan_purchase_card_missing", "Fulfilled Plan purchase Card is missing", 500);
      return json({
        kind: "fulfilled",
        orderId: result.order.id,
        cardId: result.card.id,
        subscriptionId: result.subscription?.id ?? result.order.subscriptionId
      }, { status: result.replayed ? 200 : 201 });
    }
    if (result.order.status !== "pending_payment") {
      throw new RelayError("plan_purchase_not_pending_payment", `Plan purchase is ${result.order.status}; use a new Idempotency-Key to retry`, 409);
    }
    if (result.order.paymentKind !== "payment_listing" || !result.order.stripeAmountMinor || !result.order.planPaymentListingId) {
      throw new RelayError("plan_purchase_payment_handler_invalid", "Plan purchase payment handler is invalid", 500);
    }
    const plan = await application.queries.getPlan(result.order.planId);
    const buyer = await asyncTenancy.identity.getUser(result.order.buyerUserId);
    if (!plan || !buyer) throw new RelayError("plan_purchase_terms_unavailable", "Plan purchase terms are unavailable", 409);
    const stripe = stripeClient(config.app.environment);
    const paymentMethodConfiguration = stripePaymentMethodConfiguration(config.app.environment);
    const baseUrl = hostScope.publicOrigin;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      adaptive_pricing: { enabled: false },
      integration_identifier: stripePlanIntegrationIdentifier(result.order.id),
      ...(paymentMethodConfiguration ? { payment_method_configuration: paymentMethodConfiguration } : {}),
      customer_email: buyer.email,
      line_items: [{
        price_data: {
          currency: result.order.paymentAsset.toLowerCase(),
          product_data: { name: `${plan.name} v${plan.version} Plan Card` },
          unit_amount: result.order.stripeAmountMinor
        },
        quantity: 1
      }],
      success_url: `${baseUrl}/user/plans-and-budgets/plans?planOrderId=${encodeURIComponent(result.order.id)}`,
      cancel_url: `${baseUrl}/user/plans-and-budgets/plans?planOrderId=${encodeURIComponent(result.order.id)}&stripe=cancelled`,
      client_reference_id: result.order.id,
      metadata: {
        purchase_type: "plan_purchase",
        plan_purchase_order_id: result.order.id
      },
      payment_intent_data: {
        metadata: {
          purchase_type: "plan_purchase",
          plan_purchase_order_id: result.order.id
        }
      }
    }, { idempotencyKey: `plan-order:${result.order.id}` });
    if (!session.url) throw new RelayError("stripe_checkout_unavailable", "Stripe Checkout did not return a payment URL", 502);
    await application.billingCommands.attachStripePlanCheckoutSession({ orderId: result.order.id, checkoutSessionId: session.id });
    return json({ kind: "stripe_checkout", orderId: result.order.id, checkoutUrl: session.url }, { status: result.replayed ? 200 : 201 });
  });
}

function parsePayment(value: unknown): { kind: "credit_balance" } | { kind: "payment_listing"; listingId: string } {
  if (!value || typeof value !== "object") throw new RelayError("plan_purchase_payment_required", "payment is required", 400);
  const payment = value as Record<string, unknown>;
  if (payment.kind === "credit_balance") return { kind: "credit_balance" };
  if (payment.kind === "payment_listing" && typeof payment.listingId === "string" && payment.listingId.trim()) {
    return { kind: "payment_listing", listingId: payment.listingId.trim() };
  }
  throw new RelayError("plan_purchase_payment_invalid", "payment must select credit_balance or an enabled payment_listing", 400);
}
