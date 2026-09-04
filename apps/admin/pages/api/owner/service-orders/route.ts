import { handle, json, services } from "../../../../lib/server";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    await asyncTenancy.requireOwner(request.headers);
    const [items, fulfillments] = await Promise.all([application.billingQueries.listServiceOrders(), application.billingQueries.listServiceFulfillments()]);
    return json({ items, fulfillments, nextCursor: null });
  });
}
