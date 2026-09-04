import { RelayError, requestIdFromHeaders } from "@frely/core";
import { actorFromClaims, auditSuccessAsync } from "@frely/ui-application/server";
import { assertProductionHttps, bodyJson, handle, json, services } from "../../../../../lib/server";
import { stripeClient, stripeIntegrationIdentifier, stripePaymentMethodConfiguration } from "../../../../../lib/stripe";

export async function POST(request: Request) {
  return handle(request, async ({ hostScope }) => {
    const { asyncTenancy, application, config } = await services();
    assertProductionHttps(request, config, "Stripe Checkout");
    const claims = await asyncTenancy.requireUser(request.headers);
    const body = await bodyJson<Record<string, unknown>>(request);
    const unexpected = Object.keys(body).find((key) => !["productListingId", "useImmediately"].includes(key));
    if (unexpected) {
      const override = ["amountUnits", "confirmedReceivedAmountUnits", "creditedAmountUnits", "currency", "expectedPaymentAmountUnits", "fxRate", "paymentAsset", "paymentChannelId", "paymentNetwork", "settlementMode"].includes(unexpected);
      throw new RelayError(override ? "credit_topup_payment_override_not_allowed" : "invalid_credit_topup_payload", override ? "Credit payment amount, asset, currency, FX, and channel fields are derived from the selected listing" : `Unsupported Credit topup field: ${unexpected}`, 400);
    }
    const listingId = typeof body.productListingId === "string" ? body.productListingId : "";
    const useImmediately = body.useImmediately;
    if (useImmediately !== false) throw new RelayError("stripe_checkout_card_only", "Stripe Checkout purchases must issue an available Credit Card", 400);
    const listing = await application.billingQueries.getCreditProductListing(listingId);
    const channel = listing ? (await application.billingQueries.getPaymentChannel(listing.paymentChannelId)) : undefined;
    if (!listing || listing.status !== "enabled" || !channel || channel.status !== "enabled" || channel.settlementMode !== "stripe_checkout" || channel.paymentNetwork !== "stripe" || channel.paymentAsset !== "USD") throw new RelayError("stripe_checkout_unavailable", "Stripe Checkout is unavailable for this product", 409);
    if (listing.priceAmountUnits % 10_000 !== 0) throw new RelayError("stripe_checkout_price_invalid", "Stripe Checkout price must align to USD cents", 409);
    const paymentMethodConfiguration = stripePaymentMethodConfiguration(config.app.environment);
    const stripe = stripeClient(config.app.environment);
    const topup = await application.billingCommands.createUserCreditTopup({ userId: claims.sub, productListingId: listing.id, idempotencyKey: request.headers.get("idempotency-key") ?? "", useImmediately });
    if (topup.settlementMode !== "stripe_checkout") throw new RelayError("stripe_checkout_unavailable", "Stripe Checkout is unavailable for this topup", 409);
    const baseUrl = hostScope.publicOrigin;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      integration_identifier: stripeIntegrationIdentifier(topup.id),
      ...(paymentMethodConfiguration ? { payment_method_configuration: paymentMethodConfiguration } : {}),
      line_items: [{ price_data: { currency: "usd", product_data: { name: `Frely credit: ${topup.creditedAmountUnits / 1_000_000}` }, unit_amount: topup.expectedPaymentAmountUnits / 10_000 }, quantity: 1 }],
      success_url: `${baseUrl}/user/credits?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/user/credits?stripe=cancelled`,
      client_reference_id: topup.id,
      metadata: { purchase_type: "credit_topup", credit_topup_id: topup.id },
      payment_intent_data: { metadata: { purchase_type: "credit_topup", credit_topup_id: topup.id } }
    }, { idempotencyKey: `credit-topup:${topup.id}` });
    if (!session.url) throw new RelayError("stripe_checkout_unavailable", "Stripe Checkout did not return a payment URL", 502);
    {
      await application.billingCommands.attachStripeCheckoutSession({ topupId: topup.id, checkoutSessionId: session.id });
      await auditSuccessAsync(application.audit, { actor: actorFromClaims(claims), source: "web", requestId: requestIdFromHeaders(request.headers), action: "credit_topup.stripe_checkout_create", resource: { resourceType: "credit_topup", resourceId: topup.id }, metadata: { topupId: topup.id, paymentChannelId: topup.paymentChannelId, expectedPaymentAmountUnits: topup.expectedPaymentAmountUnits, paymentAsset: topup.paymentAsset, checkoutSessionTail: session.id.slice(-8) } });
    }
    return json({ checkoutUrl: session.url, topupId: topup.id }, { status: 201 });
  });
}
