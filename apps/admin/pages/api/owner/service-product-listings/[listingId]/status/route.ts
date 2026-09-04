import { RelayError } from "@frely/core";
import { bodyJson, handle, json, services } from "../../../../../../lib/server";

interface Context { params: Promise<{ listingId: string }> }

export async function POST(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireOwner(request.headers);
    const body = await bodyJson<Record<string, unknown>>(request);
    const status = body.status;
    if (status !== "enabled" && status !== "disabled") throw new RelayError("invalid_service_product_listing_status", "status must be enabled or disabled", 400);
    const { listingId } = await context.params;
    return json(await application.billingCommands.updateServiceProductListingStatus(listingId, status, claims.sub));
  });
}
