import { RelayError } from "@frely/core";
import { bodyJson, handle, json, services } from "../../../../../../lib/server";

interface Context { params: Promise<{ orderId: string }> }

export async function POST(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireOwner(request.headers);
    const body = await bodyJson<Record<string, unknown>>(request);
    if (typeof body.reviewNote !== "string" || !body.reviewNote.trim()) throw new RelayError("invalid_service_order_review", "reviewNote is required", 400);
    const { orderId } = await context.params;
    const input = { orderId, ownerUserId: claims.sub, reviewNote: body.reviewNote };
    return json(await application.billingCommands.rejectServiceOrder(input));
  });
}
