import { RelayError } from "@frely/core";
import { bodyJson, handle, json, services } from "../../../../../../lib/server";

interface Context { params: Promise<{ allocationId: string }> }

export async function POST(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, billingCommerce } = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    const body = await bodyJson<Record<string, unknown>>(request);
    if (typeof body.teamName !== "string" || !body.teamName.trim()) throw new RelayError("invalid_partner_team", "teamName is required", 400);
    const { allocationId } = await context.params;
    const input = { allocationId, ownerUserId: claims.sub, teamName: body.teamName, source: "web" as const };
    return json(await billingCommerce.consumePartnerTeamCreationAllocation(input), { status: 201 });
  });
}
