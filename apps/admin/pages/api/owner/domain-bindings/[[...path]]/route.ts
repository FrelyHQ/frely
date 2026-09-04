import { RelayError } from "@frely/core";
import { bodyJson, handle, json, services } from "../../../../../lib/server";

interface Context { params: Promise<{ path?: string[] }>; }

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    {
      await asyncTenancy.requireOwner(request.headers);
      return json({ items: await application.queries.listDomainBindings(), nextCursor: null });
    }
  });
}

export async function POST(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    const claims = await asyncTenancy.requireOwner(request.headers);
    const path = (await context.params).path ?? [];
    const body = await bodyJson<Record<string, string>>(request);
    const service = undefined as never;
    if (path[0] === "slots") {
      const result = await application.commands.grantDomainBindingSlot({ orderId: String(body.orderId ?? ""), actorUserId: claims.sub });
      return json(result, { status: 201 });
    }
    const id = path[0]; if (!id) throw new RelayError("not_found", "Domain binding operation not found", 404);
    if (path[1] === "verify") {
      return json(await application.commands.verifyDomainBinding(id, claims.sub));
    }
    if (path[1] === "activate") {
      const input = { id, actorUserId: claims.sub, registrationInviteLinkId: String(body.registrationInviteLinkId ?? "") };
      return json(await application.commands.activateDomainBinding(input));
    }
    if (path[1] === "disable" || path[1] === "release") {
      const status = path[1] === "disable" ? "disabled" as const : "released" as const;
      return json(await application.commands.setDomainBindingStatus(id, claims.sub, status));
    }
    throw new RelayError("not_found", "Domain binding operation not found", 404);
  });
}
