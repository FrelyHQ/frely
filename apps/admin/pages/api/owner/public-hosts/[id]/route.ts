import { RelayError, requestIdFromHeaders } from "@frely/core";
import {
  actorFromClaims,
  auditFailureAsync
} from "@frely/ui-application/server";
import { bodyJson, handle, json, services } from "../../../../../lib/server";
import { assertExactKeys, bodyField, failureMetadata } from "../../../../../lib/public-host-route";

interface Context {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: Context) {
  return handle(request, async () => {
    const appServices = await services();
    const id = (await context.params).id;
    {
      const { asyncTenancy, application} = appServices;
      const claims = await asyncTenancy.requireOwner(request.headers);
      const requestId = requestIdFromHeaders(request.headers);
      let body: unknown = {};
      const current = await application.queries.getPublicHostRecord(id);
      try {
        if (!current) throw new RelayError("public_host_not_found", "Public Host not found", 404);
        body = await bodyJson<unknown>(request);
        assertExactKeys(body, ["enabled"]);
        if (typeof body.enabled !== "boolean") throw new RelayError("invalid_public_host_body", "enabled must be boolean", 400);
        const enabled = body.enabled;
        if (current.enabled === enabled) return json(current);
        const updated = await application.publicHosts.update({
          id,
          enabled,
          updatedByUserId: claims.sub,
          updatedAt: new Date().toISOString(),
          audit: { actor: actorFromClaims(claims), requestId },
        });
        return json(updated);
      } catch (error) {
        await auditFailureAsync(application.audit, {
          actor: actorFromClaims(claims), source: "owner", requestId,
          action: bodyField(body, "enabled") === true ? "public_host.enable" : bodyField(body, "enabled") === false ? "public_host.disable" : "public_host.update",
          resource: { resourceType: "public_host", resourceId: id },
          metadata: { ...failureMetadata("/api/owner/public-hosts/:id", current?.hostname, error), ...(typeof bodyField(body, "enabled") === "boolean" ? { enabled: bodyField(body, "enabled") as boolean } : {}) }, error
        });
        throw error;
      }
    }
  });
}

export async function DELETE(request: Request, context: Context) {
  return handle(request, async () => {
    const appServices = await services();
    const id = (await context.params).id;
    {
      const { asyncTenancy, application} = appServices;
      const claims = await asyncTenancy.requireOwner(request.headers);
      const requestId = requestIdFromHeaders(request.headers);
      const current = await application.queries.getPublicHostRecord(id);
      try {
        if (!current) throw new RelayError("public_host_not_found", "Public Host not found", 404);
        await application.publicHosts.delete({
          id,
          audit: { actor: actorFromClaims(claims), requestId },
        });
        return new Response(null, { status: 204 });
      } catch (error) {
        await auditFailureAsync(application.audit, {
          actor: actorFromClaims(claims), source: "owner", requestId,
          action: "public_host.delete", resource: { resourceType: "public_host", resourceId: id },
          metadata: failureMetadata("/api/owner/public-hosts/:id", current?.hostname, error), error
        });
        throw error;
      }
    }
  });
}
