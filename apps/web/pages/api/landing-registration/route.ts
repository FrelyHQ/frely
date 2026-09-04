import { actorFromClaims } from "@frely/ui-application/server";
import { createValidatedAuthMutationRequest } from "@frely/auth";
import { RelayError, requestIdFromHeaders } from "@frely/core";
import { assertProductionHttps, bodyJson, handle, json, services } from "../../../lib/server";
import { resolveLegacyPartnerRegistrationTargetAsync } from "../../../lib/registration";

export async function POST(request: Request) {
  return handle(request, async ({ hostScope }) => {
    const { asyncTenancy, application, config } = await services();
    const registration = await resolveLegacyPartnerRegistrationTargetAsync({ repo: application.queries, tenancy: asyncTenancy.tenancy, config, hostScope });
    if (!registration.target || !registration.context) throw new RelayError("landing_registration_unavailable", "Landing registration is unavailable", 404);
    const requestId = requestIdFromHeaders(request.headers);
    try {
      const claims = await asyncTenancy.requireUser(request.headers);
      const result = await asyncTenancy.acceptTeamInviteLink(registration.target.registrationInviteLinkId, { userId: claims.sub }, { actor: actorFromClaims(claims), source: "web", requestId }, { allowRegistrationTarget: true });
      return json({ outcome: result.outcome, user: result.user, membership: result.membership });
    } catch (error) {
      if (!(error instanceof RelayError) || error.code !== "unauthorized") throw error;
    }
    assertProductionHttps(request, config, "Landing registration");
    const authRequest = createValidatedAuthMutationRequest(request, hostScope.publicOrigin);
    const body = await bodyJson<unknown>(request);
    if (!isRegistrationBody(body)) {
      throw new RelayError("invalid_registration_request", "Registration request is invalid", 400);
    }
    const accepted = await asyncTenancy.acceptTeamInviteLinkWithCredentialsAndBetterAuth(registration.target.registrationInviteLinkId, { email: body.email, password: body.password }, authRequest, { source: "web", requestId }, { allowRegistrationTarget: true });
    const session = accepted.session; const response = json({ outcome: accepted.result.outcome, accountOutcome: accepted.accountOutcome, user: session.user, membership: accepted.result.membership });
    for (const cookie of session.setCookieHeaders) response.headers.append("set-cookie", cookie); return response;
  });
}

function isRegistrationBody(value: unknown): value is { email: string; password: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2
    && keys.includes("email")
    && keys.includes("password")
    && typeof (value as Record<string, unknown>).email === "string";
}
