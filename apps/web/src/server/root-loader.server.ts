import { loadConfig, type AppConfig } from "@frely/config";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { resolveClarityProjectId } from "../../pages/clarity-runtime-config";
import { services } from "../../lib/server";
import { resolveWebHostScopeAsync } from "../../lib/domain-binding";
import { availableUserTeam } from "../../lib/user-teams";
import { buildWebNavItems } from "../../lib/web-page";

export async function loadWebRootContext() {
  const requestHeaders = new Headers(getRequestHeaders());
  const { appServices, config, hostScopeKind } = await loadWebRootServices(requestHeaders);
  let sessionIdentity: { userId: string; email: string; teamRoles: string[]; expiresAtEpochSeconds: number } | null = null;
  let navItems = buildWebNavItems(null);
  if (appServices) {
    try {
      const claims = await appServices.asyncTenancy.requireUser(requestHeaders);
      const navigation = await appServices.application.queries.userNavigationSummary(claims.sub);
      const availableTeams = navigation.items.map((team) => availableUserTeam(team, claims.sub));
      sessionIdentity = {
        userId: claims.sub,
        email: claims.email,
        teamRoles: claims.teamRoles,
        expiresAtEpochSeconds: claims.exp,
      };
      navItems = buildWebNavItems({ availableTeams, availableTeamCount: navigation.total });
    } catch {
      // Public, login, and registration pages do not require a Web session.
    }
  }
  return {
    hostScopeKind,
    clarityProjectId: config ? resolveClarityProjectId(config.app.environment) : null,
    release: process.env.FRIDAY_RELAY_RELEASE ?? "dev",
    traceSampleRatio: traceSampleRatio(),
    sessionIdentity,
    navItems,
  };
}

async function loadWebRootServices(requestHeaders: Headers) {
  try {
    const appServices = await services();
    const hostScope = await resolveWebHostScopeAsync(appServices.application.queries, appServices.config, requestHeaders);
    return { appServices, config: appServices.config, hostScopeKind: hostScope.kind };
  } catch {
    // The outer request prelude already validates the canonical Host. Keep root rendering
    // available for standalone health/404 probes when the optional database is unavailable.
    let config: AppConfig | null = null;
    try {
      config = await loadConfig();
    } catch {
      // A missing config remains a safe, empty root projection.
    }
    return { appServices: null, config, hostScopeKind: "platform" as const };
  }
}

function traceSampleRatio(): number {
  const value = Number(process.env.FRIDAY_RELAY_OTEL_TRACE_SAMPLE_RATIO ?? "0.05");
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.05;
}
