import { handle, json, services } from "../../../../lib/server";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy } = await services();
    return json({ user: await asyncTenancy.requireOwner(request.headers) });
  });
}
