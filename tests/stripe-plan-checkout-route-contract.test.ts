import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const purchaseRoute = readFileSync(resolve("apps/web/pages/api/user/plan-purchases/route.ts"), "utf8");
const cancelRoute = readFileSync(resolve("apps/web/pages/api/user/plan-purchases/[orderId]/cancel/route.ts"), "utf8");
const webhookRoute = readFileSync(resolve("apps/web/pages/api/stripe/webhook/route.ts"), "utf8");
const creditRoute = readFileSync(resolve("apps/web/pages/api/user/stripe/checkout/route.ts"), "utf8");
const publicOrderDto = readFileSync(resolve("apps/web/lib/plan-purchase.ts"), "utf8");
const planStoreApi = readFileSync(resolve("apps/web/features/plan-store/api/plan-store-api.ts"), "utf8");
const planStore = readFileSync(resolve("apps/web/features/plan-store/components/plan-store.tsx"), "utf8");

describe("Stripe Plan Checkout route contract", () => {
  test("creates a hosted one-time Checkout Session from frozen local terms", () => {
    expect(purchaseRoute).toContain('mode: "payment"');
    expect(purchaseRoute).toContain("adaptive_pricing: { enabled: false }");
    expect(purchaseRoute).toContain("price_data:");
    expect(purchaseRoute).toContain("unit_amount: result.order.stripeAmountMinor");
    expect(purchaseRoute).toContain("integration_identifier:");
    expect(purchaseRoute).toContain("customer_email: buyer.email");
    expect(purchaseRoute).toContain("client_reference_id: result.order.id");
    expect(purchaseRoute).toContain('purchase_type: "plan_purchase"');
    expect(purchaseRoute).toContain("payment_intent_data:");
    expect(purchaseRoute).toContain("idempotencyKey: `plan-order:${result.order.id}`");
    expect(purchaseRoute).toContain("const baseUrl = hostScope.publicOrigin");
    expect(purchaseRoute).not.toContain("payment_method_types");
    expect(purchaseRoute).not.toContain("automatic_tax");
  });

  test("keeps Credit and Plan webhook resources explicitly routed", () => {
    for (const eventType of [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired"
    ]) {
      expect(webhookRoute).toContain(`"${eventType}"`);
    }
    expect(webhookRoute).toContain("const MAX_STRIPE_WEBHOOK_BYTES = 131_072");
    expect(webhookRoute).toContain('purchaseType === "plan_purchase"');
    expect(webhookRoute).toContain('purchaseType === "credit_topup"');
    expect(webhookRoute).toContain("checkout_purchase_type_unknown");
    expect(webhookRoute).toContain("completeStripePlanPurchaseOrder");
    expect(webhookRoute).toContain("completeStripeCreditTopup");
    expect(creditRoute).toContain('purchase_type: "credit_topup"');
    expect(creditRoute).toContain("const baseUrl = hostScope.publicOrigin");
  });

  test("does not expose complete Stripe identifiers in the user order DTO", () => {
    expect(publicOrderDto).not.toContain("checkoutSessionId");
    expect(publicOrderDto).not.toContain("paymentIntentId");
    expect(publicOrderDto).not.toContain("createIdempotencyKeyHash");
    expect(publicOrderDto).not.toContain("createRequestHash");
  });

  test("cancels an open Checkout Session after a Stripe cancel return and still trusts local order status", () => {
    expect(planStoreApi).toContain("/cancel");
    expect(planStore).toContain("cancelPlanPurchaseOrder(returnOrderId)");
    expect(planStore).toContain("fetchPlanPurchaseOrder(returnOrderId");
    expect(cancelRoute).toContain('order.status === "cancelled" || order.status === "expired"');
    expect(cancelRoute).toContain("const afterExpire = await application.billingQueries.getPlanPurchaseOrderForUser(order.id, claims.sub)");
    expect(cancelRoute).not.toContain("isPostgres");
    expect(cancelRoute).not.toContain("client.repo");
    expect(cancelRoute).toContain('afterExpire?.status === "expired"');
  });
});
