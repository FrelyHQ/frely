import { RelayError, requestIdFromHeaders } from "@frely/core";
import { actorFromClaims, auditSuccessAsync } from "@frely/ui-application/server";
import { bodyJson, handle, json, services } from "../../../../lib/server";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    await asyncTenancy.requireOwner(request.headers);
    const url = new URL(request.url);
    assertAllowedSearchParams(url.searchParams, ["planId", "status", "currency", "page"]);
    const statusValue = url.searchParams.get("status") || undefined;
    const status: "enabled" | "disabled" | undefined = statusValue === "enabled" || statusValue === "disabled" ? statusValue : undefined;
    if (statusValue !== undefined && status === undefined) throw new RelayError("invalid_plan_payment_listing_status", "status must be enabled or disabled", 400);
    const planId = optionalParam(url.searchParams, "planId");
    const paymentAsset = optionalParam(url.searchParams, "currency");
    const input = {
      ...(planId ? { planId } : {}),
      ...(status ? { status } : {}),
      ...(paymentAsset ? { paymentAsset } : {}),
      page: pageParam(url.searchParams)
    };
    return json(await application.billingQueries.pagePlanPaymentListings(input));
  });
}

export async function POST(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireOwner(request.headers);
    const body = await bodyJson<Record<string, unknown>>(request);
    if (typeof body.planId !== "string" || typeof body.paymentChannelId !== "string") throw new RelayError("invalid_plan_payment_listing", "planId and paymentChannelId are required", 400);
    const input = {
      planId: body.planId,
      paymentChannelId: body.paymentChannelId,
      priceAmountUnits: Number(body.priceAmountUnits)
    };
    const listing = await application.billingCommands.createPlanPaymentListing(input);
    const audit = {
      actor: actorFromClaims(claims),
      source: "owner",
      requestId: requestIdFromHeaders(request.headers),
      action: "plan_payment_listing.create",
      resource: { resourceType: "plan_payment_listing", resourceId: listing.id },
      metadata: {
        planPaymentListingId: listing.id,
        planId: listing.planId,
        paymentChannelId: listing.paymentChannelId,
        priceAmountUnits: listing.priceAmountUnits
      }
    } as const;
    await auditSuccessAsync(application.audit, audit);
    return json(listing, { status: 201 });
  });
}

function pageParam(params: URLSearchParams) {
  const raw = params.get("page");
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new RelayError("invalid_pagination", "page must be between 1 and 10000", 400);
  return value;
}

function optionalParam(params: URLSearchParams, key: string) {
  return params.get(key)?.trim() || undefined;
}

function assertAllowedSearchParams(params: URLSearchParams, allowed: string[]) {
  const unsupported = Array.from(params.keys()).find((key) => !allowed.includes(key));
  if (unsupported) throw new RelayError("invalid_plan_payment_listing_query", `Unsupported query parameter: ${unsupported}`, 400);
}
