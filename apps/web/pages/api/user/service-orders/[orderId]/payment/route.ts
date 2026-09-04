import { RelayError } from "@frely/core";
import { bodyJson, handle, json, services } from "../../../../../../lib/server";

interface Context { params: Promise<{ orderId: string }> }

export async function POST(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    const body = await bodyJson<Record<string, unknown>>(request);
    if (typeof body.transactionReference !== "string" || !body.transactionReference.trim()) throw new RelayError("invalid_service_order_payment", "transactionReference is required", 400);
    const { orderId } = await context.params;
    const input = { orderId, buyerUserId: claims.sub, transactionReference: body.transactionReference };
    return json(await application.billingCommands.submitServiceOrderPayment(input));
  });
}
