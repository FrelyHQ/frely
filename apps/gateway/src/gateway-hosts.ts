import type { AppConfig } from "@frely/config";
import { RelayError } from "@frely/core";
import {
  createPublicHostPolicy,
  INTERNAL_GATEWAY_HOSTNAME,
  parseHostHeader,
  type ActiveDomainBinding
} from "@frely/application/runtime";
import type { GatewayQueries } from "@frely/gateway-core";

export { INTERNAL_GATEWAY_HOSTNAME };

export const INGRESS_ROUTE_ATTESTATION_HEADER = "x-friday-relay-ingress-route-id";
export const INTERNAL_GATEWAY_INGRESS_ROUTE_ID = "internal:gateway-srv:v1";
const INGRESS_ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

type GatewayIngressResolution = { hostname: string; ingressRouteId: string | null };

export type GatewayHostResolution =
  | (GatewayIngressResolution & { kind: "default" | "alias" | "internal" })
  | (GatewayIngressResolution & { kind: "domain"; binding: ActiveDomainBinding });

export function isPlatformGatewayHostname(hostname: string, publicBaseUrl: string): boolean {
  const platformHostname = createPublicHostPolicy(publicBaseUrl).canonicalHostname;
  return hostname === platformHostname || hostname === INTERNAL_GATEWAY_HOSTNAME;
}

export async function resolveGatewayRequestHostAsync(queries: Pick<GatewayQueries, "resolveEnabledPublicHost" | "resolveActiveDomainBinding">, config: AppConfig, headers: Headers): Promise<GatewayHostResolution> {
  const hostname = parseHostHeader(headers);
  const policy = createPublicHostPolicy(config.app.publicBaseUrl, config.app.reservedHostnames);
  if (hostname === INTERNAL_GATEWAY_HOSTNAME) {
    if (headers.has(INGRESS_ROUTE_ATTESTATION_HEADER)) throw hostNotAllowed();
    return { kind: "internal", hostname, ingressRouteId: INTERNAL_GATEWAY_INGRESS_ROUTE_ID };
  }
  const ingressRouteId = resolveExternalIngressRouteId(headers, config.gateway.ingressRouteAttestationMode);
  if (hostname === policy.canonicalHostname) return { kind: "default", hostname, ingressRouteId };
  if (await queries.resolveEnabledPublicHost(hostname)) return { kind: "alias", hostname, ingressRouteId };
  const binding = await queries.resolveActiveDomainBinding(hostname);
  if (binding) return { kind: "domain", hostname, ingressRouteId, binding };
  throw hostNotAllowed();
}

function resolveExternalIngressRouteId(headers: Headers, mode: AppConfig["gateway"]["ingressRouteAttestationMode"]): string | null {
  if (!headers.has(INGRESS_ROUTE_ATTESTATION_HEADER)) {
    if (mode === "required") throw hostNotAllowed();
    return null;
  }
  const value = headers.get(INGRESS_ROUTE_ATTESTATION_HEADER);
  if (value === null || !INGRESS_ROUTE_ID_PATTERN.test(value)) throw hostNotAllowed();
  return value;
}

function hostNotAllowed(): RelayError {
  return new RelayError("host_not_allowed", "This Host is not allowed", 421);
}
