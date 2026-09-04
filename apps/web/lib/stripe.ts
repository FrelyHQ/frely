import Stripe from "stripe";
import { createHash } from "node:crypto";
import { RelayError } from "@frely/core";

export function stripeClient(environment?: string): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new RelayError("stripe_not_configured", "Stripe payments are not configured", 503);
  const production = environment === "production";
  if (production && !/^(rk|sk)_live_/.test(secretKey)) throw new RelayError("stripe_key_mode_mismatch", "Production Stripe payments require a live-mode key", 503);
  if (!production && environment && /^(rk|sk)_live_/.test(secretKey)) throw new RelayError("stripe_key_mode_mismatch", "Live-mode Stripe keys are not allowed outside production", 503);
  return new Stripe(secretKey);
}

export function stripeWebhookSecret(): string {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) throw new RelayError("stripe_not_configured", "Stripe webhook verification is not configured", 503);
  return webhookSecret;
}

export function stripePaymentMethodConfiguration(environment: string): string | undefined {
  const id = process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION?.trim();
  if (!id) {
    if (environment === "production") throw new RelayError("stripe_payment_configuration_missing", "Production Stripe Checkout requires a Payment Method Configuration", 503);
    return undefined;
  }
  if (!/^pmc_[A-Za-z0-9]+$/.test(id)) throw new RelayError("stripe_payment_configuration_invalid", "Stripe Payment Method Configuration is invalid", 503);
  return id;
}

export function assertStripeEventMode(livemode: boolean, environment: string): void {
  if (livemode !== (environment === "production")) throw new RelayError("stripe_webhook_mode_mismatch", "Stripe webhook mode does not match the application environment", 400);
}

export function stripeIntegrationIdentifier(topupId: string): string {
  const bytes = createHash("sha256").update(topupId).digest().subarray(0, 8);
  return `friday_relay_credit_${Array.from(bytes, (byte) => String.fromCharCode(97 + (byte % 26))).join("")}`;
}

export function stripePlanIntegrationIdentifier(orderId: string): string {
  const bytes = createHash("sha256").update(orderId).digest().subarray(0, 8);
  return `friday_relay_plan_${Array.from(bytes, (byte) => String.fromCharCode(97 + (byte % 26))).join("")}`;
}
