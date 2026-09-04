import { afterEach, describe, expect, test, vi } from "vitest";
import { assertStripeEventMode, stripeIntegrationIdentifier, stripePaymentMethodConfiguration, stripePlanIntegrationIdentifier } from "./stripe";

afterEach(() => vi.unstubAllEnvs());

describe("Stripe runtime configuration", () => {
  test("requires an explicit Payment Method Configuration in production", () => {
    vi.stubEnv("STRIPE_PAYMENT_METHOD_CONFIGURATION", "");
    expect(() => stripePaymentMethodConfiguration("production")).toThrowError(/requires a Payment Method Configuration/);
    expect(stripePaymentMethodConfiguration("test")).toBeUndefined();
  });

  test("accepts a configured synchronous-payment policy and rejects mode mixing", () => {
    vi.stubEnv("STRIPE_PAYMENT_METHOD_CONFIGURATION", "pmc_123ABC");
    expect(stripePaymentMethodConfiguration("production")).toBe("pmc_123ABC");
    expect(() => assertStripeEventMode(false, "production")).toThrowError(/does not match/);
    expect(() => assertStripeEventMode(true, "test")).toThrowError(/does not match/);
    expect(() => assertStripeEventMode(true, "production")).not.toThrow();
  });

  test("derives a stable integration identifier with an eight-letter suffix", () => {
    const first = stripeIntegrationIdentifier("credit_topup_test_1");
    expect(first).toMatch(/^friday_relay_credit_[a-z]{8}$/);
    expect(stripeIntegrationIdentifier("credit_topup_test_1")).toBe(first);
    expect(stripeIntegrationIdentifier("credit_topup_test_2")).not.toBe(first);
    expect(stripePlanIntegrationIdentifier("plan_purchase_order_test_1")).toMatch(/^friday_relay_plan_[a-z]{8}$/);
  });
});
