import type { ServiceFulfillmentEffect } from "@frely/ui-application/contracts";
import { RelayError } from "@frely/core";
import { bodyJson, handle, json, services } from "../../../../lib/server";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    await asyncTenancy.requireOwner(request.headers);
    const products = await application.billingQueries.listServiceProducts();
    const listings = await application.billingQueries.listServiceProductListings();
    return json({ items: products, listings, nextCursor: null });
  });
}

export async function POST(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireOwner(request.headers);
    const body = await bodyJson<Record<string, unknown>>(request);
    const effect = String(body.fulfillmentEffect ?? "") as ServiceFulfillmentEffect;
    if (effect !== "partner_team_annual") throw new RelayError("service_product_effect_invalid", "fulfillmentEffect must be partner_team_annual", 400);
    const input = {
      code: requiredString(body.code, "code"),
      displayName: requiredString(body.displayName, "displayName"),
      description: typeof body.description === "string" ? body.description : null,
      fulfillmentEffect: effect,
      durationSeconds: body.durationSeconds == null ? null : Number(body.durationSeconds),
      partnerPlanId: typeof body.partnerPlanId === "string" ? body.partnerPlanId : null,
      createdByUserId: claims.sub
    };
    const product = await application.billingCommands.createServiceProduct(input);
    return json(product, { status: 201 });
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RelayError("invalid_service_product", `${field} is required`, 400);
  return value.trim();
}
