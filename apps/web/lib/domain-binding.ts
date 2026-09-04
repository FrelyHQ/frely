import {
  createPublicHostPolicy,
  parseHostHeader,
  type ActiveDomainBinding
} from "@frely/ui-application/server";
import type { AppConfig } from "@frely/config";
import { RelayError } from "@frely/core";
import type { UiQueryPort } from "@frely/ui-application/contracts";

export type WebHostScope =
  | { kind: "platform"; platformHost: "default" | "alias"; hostname: string; publicOrigin: string }
  | { kind: "domain"; binding: ActiveDomainBinding; hostname: string; publicOrigin: string };

export function isCanonicalWebHost(config: AppConfig, headers: Headers): boolean {
  const hostname = parseHostHeader(headers);
  return hostname === createPublicHostPolicy(config.app.publicBaseUrl, config.app.reservedHostnames).canonicalHostname;
}

export async function resolveWebHostScopeAsync(
  repo: Pick<UiQueryPort, "resolveEnabledPublicHost" | "resolveActiveDomainBinding">,
  config: AppConfig,
  headers: Headers
): Promise<WebHostScope> {
  const hostname = parseHostHeader(headers);
  const policy = createPublicHostPolicy(config.app.publicBaseUrl, config.app.reservedHostnames);
  if (hostname === policy.canonicalHostname) {
    return { kind: "platform", platformHost: "default", hostname, publicOrigin: policy.canonicalOrigin };
  }
  if (await repo.resolveEnabledPublicHost(hostname)) {
    return { kind: "platform", platformHost: "alias", hostname, publicOrigin: `https://${hostname}` };
  }
  const binding = await repo.resolveActiveDomainBinding(hostname);
  if (!binding) throw new RelayError("host_not_allowed", "This Host is not allowed", 421);
  return { kind: "domain", binding, hostname, publicOrigin: `https://${hostname}` };
}

export function assertTeamAllowed(scope: WebHostScope, teamId: string): void {
  if (scope.kind === "domain" && !scope.binding.teamIds.includes(teamId)) throw new RelayError("domain_binding_team_forbidden", "This Team is not available on this hostname", 403);
}
