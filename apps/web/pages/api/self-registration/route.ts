import { clearLandingRegistrationEntryCookieHeaders, createValidatedAuthMutationRequest, landingRegistrationEntryFromHeaders } from "@frely/auth";
import type { AppConfig } from "@frely/config";
import { RelayError, requestIdFromHeaders } from "@frely/core";
import { AsyncRegistrationTargetService, createAbuseGuard } from "@frely/tenancy";
import { assertProductionHttps, bodyJson, handle, json, services } from "../../../lib/server";

export async function POST(request: Request) {
  let clearInvalidEntryCookie = false;
  let entryCookieConfig: AppConfig | undefined;
  const response = await handle(request, async ({ hostScope }) => {
    const { asyncTenancy, asyncAbuseGuard, application, config } = await services();
    entryCookieConfig = config;
    assertProductionHttps(request, config, "Registration");
    const requestId = requestIdFromHeaders(request.headers);
    const abuseContext = { routePattern: "/api/self-registration", requestId };
    const queries = application?.queries;
    const consume = (bucket: "invite.accept.attempt" | "invite.accept.failed") => asyncAbuseGuard.consume(bucket, request.headers, abuseContext);
    const assertNotBlocked = asyncAbuseGuard.assertNotBlocked("invite.accept.failed", request.headers, abuseContext);
    await consume("invite.accept.attempt");
    await assertNotBlocked;
    const entry = new URL(request.url).searchParams.get("entry");
    try {
      if (entry !== null && entry !== "global" && entry !== "partner") throw new RelayError("registration_unavailable", "Registration is unavailable", 404);
      if (hostScope.kind !== "platform" || (entry === "partner" && hostScope.publicOrigin !== new URL(config.app.publicBaseUrl).origin)) throw new RelayError("registration_unavailable", "Registration is unavailable", 404);
      const state = entry === "partner" ? landingRegistrationEntryFromHeaders(config, request.headers) : null;
      const context = entry === "partner"
        ? state
          ? { entryKind: "domain_binding" as const, domainBindingId: state.domainBindingId, hostname: state.hostname, canonicalOrigin: state.canonicalOrigin }
          : null
        : { entryKind: "global" as const, canonicalOrigin: new URL(config.app.publicBaseUrl).origin };
      if (!context) {
        clearInvalidEntryCookie = entry === "partner";
        throw new RelayError("registration_unavailable", "Registration is unavailable", 404);
      }
      const authRequest = createValidatedAuthMutationRequest(request, hostScope.publicOrigin);
      // Registration credentials are sensitive: parse only after HTTPS and abuse guards.
      const body = await bodyJson<unknown>(request);
      if (!isRegistrationBody(body)) {
        throw new RelayError("invalid_registration_request", "Registration request is invalid", 400);
      }
      const registrationTarget = await new AsyncRegistrationTargetService(queries, asyncTenancy.tenancy, config).resolve(context);
      if (!registrationTarget) throw new RelayError("registration_unavailable", "Registration is unavailable", 404);
      const accepted = await asyncTenancy.acceptTeamInviteLinkWithCredentialsAndBetterAuth(registrationTarget?.registrationInviteLinkId ?? "", { email: body.email, password: body.password }, authRequest, { source: "web", requestId }, { allowRegistrationTarget: true });
      const response = json({
        outcome: accepted.result.outcome,
        accountOutcome: accepted.accountOutcome,
        user: accepted.session.user,
        membership: accepted.result.membership
      });
      for (const cookie of accepted.session.setCookieHeaders) response.headers.append("set-cookie", cookie);
      for (const cookie of clearLandingRegistrationEntryCookieHeaders(config)) response.headers.append("set-cookie", cookie);
      return response;
    } catch (error) {
      if (error instanceof RelayError && error.code === "registration_unavailable" && entry === "partner") clearInvalidEntryCookie = true;
      if (error instanceof RelayError && error.status >= 400 && error.status < 500 && error.code !== "rate_limited") {
        await consume("invite.accept.failed");
      }
      throw error;
    }
  });
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("referrer-policy", "no-referrer");
  if (clearInvalidEntryCookie && entryCookieConfig) {
    for (const cookie of clearLandingRegistrationEntryCookieHeaders(entryCookieConfig)) response.headers.append("set-cookie", cookie);
  }
  return response;
}

function isRegistrationBody(value: unknown): value is { email: string; password: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2
    && keys.includes("email")
    && keys.includes("password")
    && typeof (value as Record<string, unknown>).email === "string";
}
