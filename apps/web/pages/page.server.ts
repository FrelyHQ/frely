import { getRequestHeaders } from "@tanstack/react-start/server";
import { signLandingEntryState } from "@frely/auth";
import { services } from "../lib/server";
import { resolveWebHostScopeAsync } from "../lib/domain-binding";
import { resolveLegacyPartnerRegistrationTargetAsync } from "../lib/registration";
import { webLoginHref } from "./login/login-next";

export async function loadPage() {
  const { application, asyncTenancy, config } = await services();
  const scope = await resolveWebHostScopeAsync(application.queries, config, new Headers(getRequestHeaders()));
  if (scope.kind === "domain") {
    const binding = scope.binding;
    return {
      kind: "domain" as const,
      teamName: (await asyncTenancy.tenancy.getTeam(binding.defaultRegistrationTeamId ?? ""))?.name ?? "Frely",
      registrationAvailable: Boolean((await resolveLegacyPartnerRegistrationTargetAsync({
        repo: application.queries,
        tenancy: asyncTenancy.tenancy,
        config,
        hostScope: scope,
      })).target),
      state: signLandingEntryState(config, {
        canonicalOrigin: config.app.publicBaseUrl,
        domainBindingId: binding.id,
        hostname: binding.hostname,
      }),
      action: new URL("/auth/landing-entry", config.app.publicBaseUrl).toString(),
    };
  }
  return { kind: "platform" as const, loginHref: webLoginHref(scope.publicOrigin) };
}

export type HomePageData = Awaited<ReturnType<typeof loadPage>>;
