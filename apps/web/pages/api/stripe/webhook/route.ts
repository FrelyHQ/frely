import Stripe from "stripe";
import { errorPayload, errorStatus, readBoundedRequestText, RelayError, requestIdFromHeaders } from "@frely/core";
import { auditFailureAsync, createPublicHostPolicy, parseHostHeader } from "@frely/ui-application/server";
import { services } from "../../../../lib/server";
import { assertStripeEventMode, stripeClient, stripeWebhookSecret } from "../../../../lib/stripe";

const MAX_STRIPE_WEBHOOK_BYTES = 131_072;
const CHECKOUT_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired"
]);

export async function POST(request: Request) {
  const requestId = requestIdFromHeaders(request.headers);
  const { billingCommerce, application, config } = await services();
  const commands = application.billingCommands;
  const recordIgnored = (input: Parameters<typeof commands.recordStripeWebhookIgnored>[0]) => commands.recordStripeWebhookIgnored(input);
  const recordFailure = (input: Parameters<typeof commands.recordStripeWebhookFailure>[0]) => commands.recordStripeWebhookFailure(input);
  const recordPlanTerminal = (input: Parameters<typeof commands.recordStripePlanPurchaseTerminal>[0]) => commands.recordStripePlanPurchaseTerminal(input);
  const recordTopupTerminal = (input: Parameters<typeof commands.recordStripeCreditTopupTerminal>[0]) => commands.recordStripeCreditTopupTerminal(input);
  const completePlan = (input: Parameters<typeof billingCommerce.completeStripePlanPurchaseOrder>[0]) => billingCommerce.completeStripePlanPurchaseOrder(input);
  const completeTopup = (input: Parameters<typeof billingCommerce.completeStripeCreditTopup>[0]) => billingCommerce.completeStripeCreditTopup(input);
  const auditFailureForBackend = (input: Parameters<typeof auditFailureAsync>[1]) => auditFailureAsync(application.audit, input);
  try {
    const hostname = parseHostHeader(request.headers);
    const policy = createPublicHostPolicy(config.app.publicBaseUrl, config.app.reservedHostnames);
    if (hostname !== policy.canonicalHostname) throw new RelayError("host_not_allowed", "Stripe webhooks require the canonical Host", 421);
  } catch (error) {
    return Response.json(errorPayload(error, requestId), { status: errorStatus(error), headers: { "x-request-id": requestId } });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Missing Stripe signature" }, { status: 400 });
  let rawBody: string;
  try {
    rawBody = await readBoundedRequestText(request, MAX_STRIPE_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof RelayError && error.status === 413) {
      return Response.json({ error: "Stripe webhook body is too large" }, { status: 413 });
    }
    return Response.json({ error: "Invalid Stripe webhook body" }, { status: 400 });
  }
  let event: Stripe.Event;
  try {
    event = stripeClient(config.app.environment).webhooks.constructEvent(rawBody, signature, stripeWebhookSecret());
  } catch {
    return Response.json({ error: "Invalid Stripe signature" }, { status: 400 });
  }

  try {
    assertStripeEventMode(event.livemode, config.app.environment);
  } catch (error) {
    const relay = error instanceof RelayError ? error : new RelayError("stripe_webhook_mode_mismatch", "Stripe webhook mode mismatch", 400);
    await recordFailure({ eventId: event.id, eventType: event.type, livemode: event.livemode, errorCode: relay.code });
    return Response.json({ error: "Stripe webhook mode mismatch" }, { status: 400 });
  }

  if (!CHECKOUT_EVENT_TYPES.has(event.type)) {
    await recordIgnored({ eventId: event.id, eventType: event.type, livemode: event.livemode, reason: "event_type_not_handled" });
    return Response.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const binding = checkoutBinding(session);
  if (binding.kind === "invalid") {
    await recordIgnored({
      eventId: event.id,
      eventType: event.type,
      livemode: event.livemode,
      checkoutSessionId: session.id,
      reason: binding.reason
    });
    return Response.json({ received: true });
  }

  try {
    if (binding.kind === "plan_purchase") {
      if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
        await recordPlanTerminal({
          orderId: binding.orderId,
          checkoutSessionId: session.id,
          status: event.type === "checkout.session.expired" ? "expired" : "payment_failed",
          webhookEvent: { eventId: event.id, eventType: event.type, livemode: event.livemode }
        });
        return Response.json({ received: true });
      }
      if (session.payment_status !== "paid") {
        await recordIgnored({
          eventId: event.id,
          eventType: event.type,
          livemode: event.livemode,
          checkoutSessionId: session.id,
          planPurchaseOrderId: binding.orderId,
          reason: "payment_not_paid"
        });
        return Response.json({ received: true });
      }
      if (session.amount_total === null || !session.currency) {
        await recordIgnored({
          eventId: event.id,
          eventType: event.type,
          livemode: event.livemode,
          checkoutSessionId: session.id,
          planPurchaseOrderId: binding.orderId,
          reason: "checkout_amount_incomplete"
        });
        return Response.json({ received: true });
      }
      await completePlan({
        orderId: binding.orderId,
        checkoutSessionId: session.id,
        paymentIntentId: paymentIntentId(session),
        amountMinor: session.amount_total,
        currency: session.currency,
        webhookEvent: { eventId: event.id, eventType: event.type, livemode: event.livemode }
      });
      return Response.json({ received: true });
    }

    if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
      await recordTopupTerminal({
        topupId: binding.topupId,
        checkoutSessionId: session.id,
        status: event.type === "checkout.session.expired" ? "expired" : "payment_failed",
        webhookEvent: { eventId: event.id, eventType: event.type, livemode: event.livemode }
      });
      return Response.json({ received: true });
    }
    if (session.payment_status !== "paid") {
      await recordIgnored({
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        checkoutSessionId: session.id,
        topupId: binding.topupId,
        reason: "payment_not_paid"
      });
      return Response.json({ received: true });
    }
    if (session.amount_total === null || !session.currency) {
      await recordIgnored({
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode,
        checkoutSessionId: session.id,
        topupId: binding.topupId,
        reason: "checkout_amount_incomplete"
      });
      return Response.json({ received: true });
    }
    await completeTopup({
      topupId: binding.topupId,
      checkoutSessionId: session.id,
      paymentIntentId: paymentIntentId(session),
      amountUnits: session.amount_total * 10_000,
      currency: session.currency,
      webhookEvent: { eventId: event.id, eventType: event.type, livemode: event.livemode }
    });
    return Response.json({ received: true });
  } catch (error) {
    const relay = error instanceof RelayError ? error : new RelayError("stripe_webhook_processing_failed", "Stripe webhook processing failed", 500);
    await recordFailure({
      eventId: event.id,
      eventType: event.type,
      livemode: event.livemode,
      checkoutSessionId: session.id,
      ...(binding.kind === "plan_purchase" ? { planPurchaseOrderId: binding.orderId } : { topupId: binding.topupId }),
      errorCode: relay.code
    });
    const resourceType = binding.kind === "plan_purchase" ? "plan_purchase_order" : "credit_topup";
    const resourceId = binding.kind === "plan_purchase" ? binding.orderId : binding.topupId;
    await auditFailureForBackend({
      actor: { actorType: "system", actorId: "stripe" },
      source: "system",
      requestId: event.id,
      action: binding.kind === "plan_purchase" ? "plan_purchase.stripe_checkout_complete" : "credit_topup.stripe_checkout_complete",
      resource: { resourceType, resourceId },
      metadata: {
        [binding.kind === "plan_purchase" ? "orderId" : "topupId"]: resourceId,
        checkoutSessionTail: session.id.slice(-8),
        amountMinor: session.amount_total,
        currency: session.currency?.toUpperCase() ?? null
      },
      error: relay
    });
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

function checkoutBinding(session: Stripe.Checkout.Session):
  | { kind: "plan_purchase"; orderId: string }
  | { kind: "credit_topup"; topupId: string }
  | { kind: "invalid"; reason: string } {
  const purchaseType = session.metadata?.purchase_type;
  const orderId = session.metadata?.plan_purchase_order_id;
  const topupId = session.metadata?.credit_topup_id;
  if (orderId && topupId) return { kind: "invalid", reason: "checkout_resource_conflict" };
  if (purchaseType === "plan_purchase") {
    if (topupId) return { kind: "invalid", reason: "checkout_resource_conflict" };
    const resolved = orderId ?? session.client_reference_id;
    return resolved ? { kind: "plan_purchase", orderId: resolved } : { kind: "invalid", reason: "checkout_metadata_incomplete" };
  }
  if (purchaseType === "credit_topup") {
    if (orderId) return { kind: "invalid", reason: "checkout_resource_conflict" };
    const resolved = topupId ?? session.client_reference_id;
    return resolved ? { kind: "credit_topup", topupId: resolved } : { kind: "invalid", reason: "checkout_metadata_incomplete" };
  }
  if (purchaseType) return { kind: "invalid", reason: "checkout_purchase_type_unknown" };
  if (orderId) return { kind: "plan_purchase", orderId };
  const legacyTopupId = topupId ?? session.client_reference_id;
  return legacyTopupId ? { kind: "credit_topup", topupId: legacyTopupId } : { kind: "invalid", reason: "checkout_metadata_incomplete" };
}

function paymentIntentId(session: Stripe.Checkout.Session): string | null {
  return typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
}
