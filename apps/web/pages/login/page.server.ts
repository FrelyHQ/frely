import { getRequestHeaders } from "@tanstack/react-start/server";
import { signLandingEntryState } from "@frely/auth";
import { services } from "../../lib/server";
import { resolveWebHostScopeAsync } from "../../lib/domain-binding";
import { resolveWebRegistrationTargetAsync } from "../../lib/registration";
import { safeWebLoginNext } from "./login-next";

export interface WebLoginPageRequest {
  next?: string;
  entry?: string;
}

export async function loadPage(params: WebLoginPageRequest) {
  const appServices = await services();
  const requestHeaders = new Headers(getRequestHeaders());
  const hostScope = await resolveWebHostScopeAsync(appServices.application.queries, appServices.config, requestHeaders);
  if (params.entry === "landing" && hostScope.kind === "domain") {
    const binding = hostScope.binding;
    return {
      kind: "landing" as const,
      teamName: (await appServices.asyncTenancy.tenancy.getTeam(binding.defaultRegistrationTeamId ?? ""))?.name ?? "your Team",
      state: signLandingEntryState(appServices.config, {
        canonicalOrigin: appServices.config.app.publicBaseUrl,
        domainBindingId: binding.id,
        hostname: binding.hostname,
      }),
      action: new URL("/auth/landing-entry", appServices.config.app.publicBaseUrl).toString(),
    };
  }
  const entry = params.entry === "partner" ? "partner" : null;
  const registration = await resolveWebRegistrationTargetAsync({
    repo: appServices.application.queries,
    tenancy: appServices.asyncTenancy.tenancy,
    config: appServices.config,
    headers: requestHeaders,
    hostScope,
    entry,
  });
  return {
    kind: "login" as const,
    next: safeWebLoginNext(params.next ?? null),
    registrationHref: registration.target
      ? `/register?entry=${registration.target.entryKind === "global" ? "global" : "partner"}`
      : undefined,
    registrationPrompt: registration.target
      ? registration.target.entryKind === "global"
        ? "No account?"
        : `No account? Register and join ${registration.target.teamName}.`
      : undefined,
  };
}

export type WebLoginPageData = Awaited<ReturnType<typeof loadPage>>;
