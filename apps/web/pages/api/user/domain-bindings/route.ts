import { bodyJson, handle, json, services } from "../../../../lib/server";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    return json({ items: await application.queries.listDomainBindingsForOwner(claims.sub), nextCursor: null });
  });
}

export async function POST(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireUser(request.headers);
    const body = await bodyJson<{ hostname?: string; teamIds?: string[]; defaultRegistrationTeamId?: string }>(request);
    const input = { ownerUserId: claims.sub, hostname: String(body.hostname ?? ""), teamIds: Array.isArray(body.teamIds) ? body.teamIds : [], defaultRegistrationTeamId: String(body.defaultRegistrationTeamId ?? "") };
    return json(await application.commands.createDomainBinding(input), { status: 201 });
  });
}
