import { requestIdFromHeaders } from "@frely/core";
import { actorFromClaims, auditSuccessAsync } from "@frely/ui-application/server";
import { handle, json, services } from "../../../../../../lib/server";

interface Context {
  params: Promise<{ listingId: string }>;
}

export async function POST(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireOwner(request.headers);
    const { listingId } = await context.params;
    const listing = await application.billingCommands.disablePlanPaymentListing(listingId);
    const audit = {
      actor: actorFromClaims(claims),
      source: "owner",
      requestId: requestIdFromHeaders(request.headers),
      action: "plan_payment_listing.disable",
      resource: { resourceType: "plan_payment_listing", resourceId: listing.id },
      metadata: { planPaymentListingId: listing.id, planId: listing.planId, paymentChannelId: listing.paymentChannelId }
    } as const;
    await auditSuccessAsync(application.audit, audit);
    return json(listing);
  });
}
