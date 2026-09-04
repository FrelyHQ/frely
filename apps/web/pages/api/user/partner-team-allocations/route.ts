import { handle, json, services } from "../../../../lib/server";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    return json({ items: await application.billingQueries.listAvailablePartnerTeamCreationAllocations(claims.sub), nextCursor: null });
  });
}
