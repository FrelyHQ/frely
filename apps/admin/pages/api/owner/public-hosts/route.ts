import { createId, nowIso, RelayError, requestIdFromHeaders } from "@frely/core";
import {
  actorFromClaims,
  auditFailureAsync,
  createPublicHostPolicy,
  normalizePublicHostname
} from "@frely/ui-application/server";
import { bodyJson, handle, json, services } from "../../../../lib/server";
import { assertExactKeys, bodyField, failureMetadata } from "../../../../lib/public-host-route";

const ROUTE_PATTERN = "/api/owner/public-hosts";

export async function GET(request: Request) {
  return handle(request, async () => {
    const appServices = await services();
    {
      const { asyncTenancy, application, config } = appServices;
      await asyncTenancy.requireOwner(request.headers);
      const url = new URL(request.url);
      assertSearchParams(url.searchParams, ["page"]);
      const policy = createPublicHostPolicy(config.app.publicBaseUrl, config.app.reservedHostnames);
      const page = await application.queries.pagePublicHosts(pageParam(url.searchParams));
      return json({
        defaultHost: { hostname: policy.canonicalHostname, origin: policy.canonicalOrigin, enabled: true, readOnly: true },
        ...page
      });
    }
  });
}

export async function POST(request: Request) {
  return handle(request, async () => {
    const appServices = await services();
    {
      const { asyncTenancy, application, config } = appServices;
      const claims = await asyncTenancy.requireOwner(request.headers);
      const requestId = requestIdFromHeaders(request.headers);
      let body: unknown = {};
      try {
        body = await bodyJson<unknown>(request);
        assertExactKeys(body, ["hostname"]);
        const hostname = normalizePublicHostname(body.hostname);
        const policy = createPublicHostPolicy(config.app.publicBaseUrl, config.app.reservedHostnames);
        if (hostname === policy.canonicalHostname || policy.reservedHostnames.has(hostname)) {
          throw new RelayError("public_host_hostname_reserved", "This hostname is reserved by the instance configuration", 400);
        }
        if (await application.queries.findPublicHostRecordByHostname(hostname)) {
          throw new RelayError("public_host_hostname_conflict", "This hostname is already an instance public Host", 409, { conflictKind: "public_host" });
        }
        if (await application.queries.hasDomainBindingHostname(hostname)) {
          throw new RelayError("public_host_hostname_conflict", "This hostname is already reserved by a DomainBinding", 409, { conflictKind: "domain_binding" });
        }
        const timestamp = nowIso();
        const row = {
          id: createId("public_host"), hostname, enabled: false,
          createdByUserId: claims.sub, updatedByUserId: claims.sub,
          createdAt: timestamp, updatedAt: timestamp,
        };
        const created = await application.publicHosts.create({
          row,
          audit: { actor: actorFromClaims(claims), requestId },
        });
        return json(created, { status: 201 });
      } catch (error) {
        await auditFailureAsync(application.audit, {
          actor: actorFromClaims(claims), source: "owner", requestId,
          action: "public_host.create", resource: { resourceType: "public_host", resourceId: "new" },
          metadata: failureMetadata(ROUTE_PATTERN, bodyField(body, "hostname"), error), error
        });
        throw mapAsyncPublicHostConflict(error);
      }
    }
  });
}

function mapAsyncPublicHostConflict(error: unknown): unknown {
  if (error instanceof RelayError) return error;
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "23505" || message.includes("instance_public_hosts.hostname")) {
    return new RelayError("public_host_hostname_conflict", "This hostname is already an instance public Host", 409, { conflictKind: "public_host" });
  }
  if (message.includes("hostname conflicts with domain_bindings")) {
    return new RelayError("public_host_hostname_conflict", "This hostname is already reserved by a DomainBinding", 409, { conflictKind: "domain_binding" });
  }
  return error;
}

function pageParam(params: URLSearchParams): number {
  const raw = params.get("page");
  if (raw === null) return 1;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 10_000) {
    throw new RelayError("invalid_pagination", "page must be between 1 and 10000", 400);
  }
  return Number(raw);
}

function assertSearchParams(params: URLSearchParams, allowed: readonly string[]): void {
  const unsupported = Array.from(params.keys()).find((key) => !allowed.includes(key));
  if (unsupported) throw new RelayError("invalid_public_host_query", `Unsupported query parameter: ${unsupported}`, 400);
}
