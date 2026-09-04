import { getRequestHeaders } from "@tanstack/react-start/server";
import { notFound } from "@web/navigation";
import { RelayError } from "@frely/core";
import { signLandingEntryState } from "@frely/auth";
import { services } from "../../lib/server";
import { resolveWebHostScopeAsync } from "../../lib/domain-binding";
import { resolveLegacyPartnerRegistrationTargetAsync, resolveWebRegistrationTargetAsync } from "../../lib/registration";

export interface RegisterPageRequest {
  token?: string | string[];
  entry?: string | string[];
}

type RegistrationEntry = "global" | "partner";

export async function loadPage(params: RegisterPageRequest) {
  const rawToken = params.token;
  const inviteToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  const rawEntry = params.entry;
  const entry = Array.isArray(rawEntry) ? rawEntry[0] : rawEntry;
  const landingEntry = entry === "landing";
  const registrationEntry: RegistrationEntry | null = entry === "global" ? "global" : entry === "partner" ? "partner" : null;
  if (!inviteToken && !landingEntry && !registrationEntry) notFound();

  const appServices = await services();
  const requestHeaders = new Headers(getRequestHeaders());
  const hostScope = await resolveWebHostScopeAsync(appServices.application.queries, appServices.config, requestHeaders);
  if (registrationEntry) {
    if (hostScope.kind !== "platform") notFound();
    const registration = await resolveWebRegistrationTargetAsync({
      repo: appServices.application.queries,
      tenancy: appServices.asyncTenancy.tenancy,
      config: appServices.config,
      headers: requestHeaders,
      hostScope,
      entry: registrationEntry,
    });
    if (!registration.target) notFound();
    return {
      kind: "registration" as const,
      registrationEntry,
      teamName: registration.target.teamName,
    };
  }
  if (landingEntry && hostScope.kind === "domain") {
    const registration = await resolveLegacyPartnerRegistrationTargetAsync({
      repo: appServices.application.queries,
      tenancy: appServices.asyncTenancy.tenancy,
      config: appServices.config,
      hostScope,
    });
    if (!registration.target) notFound();
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
  if (landingEntry) notFound();

  const abuseContext = { routePattern: "/register" };
  await appServices.asyncAbuseGuard.consume("invite.preview.attempt", requestHeaders, abuseContext);
  await appServices.asyncAbuseGuard.assertNotBlocked("invite.preview.failed", requestHeaders, abuseContext);
  let teamName = "";
  let memberInvitesEnabled = false;
  let inviteEmailDomainRestricted = false;
  let currentUserEmail: string | null = null;
  try {
    const preview = await appServices.asyncTenancy.previewTeamInviteLink(inviteToken!);
    teamName = preview.team.name;
    memberInvitesEnabled = "memberInvitesEnabled" in preview && preview.memberInvitesEnabled === true;
    inviteEmailDomainRestricted = preview.team.inviteEmailDomainPattern !== null;
  } catch (error) {
    if (error instanceof RelayError && error.status >= 400 && error.status < 500 && error.code !== "rate_limited") {
      await appServices.asyncAbuseGuard.consume("invite.preview.failed", requestHeaders, abuseContext);
    }
    if (error instanceof RelayError && error.status === 404) notFound();
    throw error;
  }
  try {
    currentUserEmail = (await appServices.asyncTenancy.requireUser(requestHeaders)).email;
  } catch {
    currentUserEmail = null;
  }
  return {
    kind: "invite" as const,
    inviteToken,
    teamName,
    memberInvitesEnabled,
    inviteEmailDomainRestricted,
    currentUserEmail,
  };
}

export type RegisterPageData = Awaited<ReturnType<typeof loadPage>>;
