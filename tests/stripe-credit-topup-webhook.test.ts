import { testConfig } from "@frely/testkit";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  services: vi.fn(),
  constructEvent: vi.fn(),
  assertStripeEventMode: vi.fn(),
  stripeWebhookSecret: vi.fn(() => "whsec_test"),
}));

vi.mock("../apps/web/lib/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apps/web/lib/server")>()),
  services: mocks.services,
}));

vi.mock("../apps/web/lib/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apps/web/lib/stripe")>()),
  stripeClient: vi.fn(() => ({ webhooks: { constructEvent: mocks.constructEvent } })),
  assertStripeEventMode: mocks.assertStripeEventMode,
  stripeWebhookSecret: mocks.stripeWebhookSecret,
}));

describe("Stripe Credit topup webhook terminal routing", () => {
  beforeEach(() => {
    mocks.services.mockReset();
    mocks.constructEvent.mockReset();
    mocks.assertStripeEventMode.mockReset();
    mocks.stripeWebhookSecret.mockReset().mockReturnValue("whsec_test");
  });

  test.each([
    ["checkout.session.async_payment_failed", "payment_failed"],
    ["checkout.session.expired", "expired"],
  ] as const)("routes %s to the Credit terminal command", async (eventType, status) => {
    const recordStripeCreditTopupTerminal = vi.fn(async () => ({ id: "topup_stripe_terminal", status }));
    const recordStripeWebhookIgnored = vi.fn();
    const recordStripeWebhookFailure = vi.fn();
    const completeStripeCreditTopup = vi.fn();
    mocks.services.mockResolvedValue({
      config: testConfig({ app: { name: "Frely", environment: "test", publicBaseUrl: "http://localhost:43001", reservedHostnames: [] } }),
      application: {
        billingCommands: { recordStripeCreditTopupTerminal, recordStripeWebhookIgnored, recordStripeWebhookFailure },
        audit: { record: vi.fn() },
      },
      billingCommerce: { completeStripeCreditTopup },
    });
    mocks.constructEvent.mockReturnValue({
      id: `evt_${status}`,
      type: eventType,
      livemode: false,
      data: { object: { id: "cs_stripe_terminal", metadata: { purchase_type: "credit_topup", credit_topup_id: "topup_stripe_terminal" }, client_reference_id: "topup_stripe_terminal" } },
    });
    const route = await import("../apps/web/pages/api/stripe/webhook/route");

    const response = await route.POST(new Request("http://localhost:43001/api/stripe/webhook", {
      method: "POST",
      headers: { host: "localhost:43001", "stripe-signature": "test-signature" },
      body: "{}",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(recordStripeCreditTopupTerminal).toHaveBeenCalledWith({
      topupId: "topup_stripe_terminal",
      checkoutSessionId: "cs_stripe_terminal",
      status,
      webhookEvent: { eventId: `evt_${status}`, eventType, livemode: false },
    });
    expect(recordStripeWebhookIgnored).not.toHaveBeenCalled();
    expect(completeStripeCreditTopup).not.toHaveBeenCalled();
  });
});
