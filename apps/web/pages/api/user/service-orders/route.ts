import type { ServicePurchaseIntent } from "@frely/ui-application/contracts";
import { RelayError } from "@frely/core";
import { bodyJson, handle, json, services } from "../../../../lib/server";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    return json({ items: await application.billingQueries.listServiceOrdersForBuyer(claims.sub), nextCursor: null });
  });
}

export async function POST(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    const body = await bodyJson<Record<string, unknown>>(request);
    const purchaseIntent = String(body.purchaseIntent ?? "") as ServicePurchaseIntent;
    if (purchaseIntent !== "new" && purchaseIntent !== "renew") throw new RelayError("service_purchase_intent_invalid", "purchaseIntent must be new or renew", 400);
    const orderInput = {
      buyerUserId: claims.sub,
      productListingId: requiredString(body.productListingId, "productListingId"),
      purchaseIntent,
      targetPartnerTeamId: optionalString(body.targetPartnerTeamId),
      idempotencyKey: request.headers.get("idempotency-key") ?? ""
    };
    const order = await application.billingCommands.createServiceOrder(orderInput);
    return json(order, { status: 201 });
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RelayError("invalid_service_order", `${field} is required`, 400);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
