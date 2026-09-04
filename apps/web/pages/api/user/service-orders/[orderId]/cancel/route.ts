import { handle, json, services } from "../../../../../../lib/server";

interface Context { params: Promise<{ orderId: string }> }

export async function POST(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    const { orderId } = await context.params;
    const input = { orderId, buyerUserId: claims.sub };
    return json(await application.billingCommands.cancelServiceOrder(input));
  });
}
