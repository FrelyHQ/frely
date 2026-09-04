import { handle, json, services } from "../../../../../../lib/server";

export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  return handle(request, async () => {
    const { asyncTenancy, billingCommerce } = await services();
    const claims = await asyncTenancy.requireOwner(request.headers);
    const { orderId } = await context.params;
    return json(await billingCommerce.retryServiceOrderFulfillment({ orderId, ownerUserId: claims.sub }));
  });
}
