import { RelayError } from "@frely/core";
import { bodyJson, handle, json, services } from "../../../../lib/server";

export async function POST(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireOwner(request.headers);
    const body = await bodyJson<Record<string, unknown>>(request);
    if (typeof body.productId !== "string" || typeof body.paymentChannelId !== "string") throw new RelayError("invalid_service_product_listing", "productId and paymentChannelId are required", 400);
    const input = { productId: body.productId, paymentChannelId: body.paymentChannelId, priceAmountUnits: Number(body.priceAmountUnits), createdByUserId: claims.sub };
    return json(await application.billingCommands.createServiceProductListing(input), { status: 201 });
  });
}
