import { createValidatedAuthMutationRequest } from "@frely/auth";
import { RelayError, requestIdFromHeaders } from "@frely/core";
import { actorFromClaims } from "@frely/ui-application/server";
import { assertProductionHttps, bodyJson, handle, json, services } from "../../../../lib/server";

interface Context {
  params: Promise<{ inviteLinkId: string }>;
}

export async function GET(request: Request, context: Context) {
  return handle(request, async () => {
    const { asyncTenancy, asyncAbuseGuard, application, config } = await services();
    const { inviteLinkId } = await context.params;
    assertProductionHttps(request, config, "Invite preview");
    const abuseContext = { routePattern: "/api/invite-links/:inviteLinkId", requestId: requestIdFromHeaders(request.headers) };
    {
      await asyncAbuseGuard.consume("invite.preview.attempt", request.headers, abuseContext);
      await asyncAbuseGuard.assertNotBlocked("invite.preview.failed", request.headers, abuseContext);
    }
    try {
      const { inviteLink, team, memberInvitesEnabled } = await asyncTenancy.previewTeamInviteLink(inviteLinkId);
      return json({ inviteLink: { id: inviteLink.id, status: inviteLink.status }, team: { id: team.id, name: team.name }, memberInvitesEnabled, inviteEmailDomainRestricted: team.inviteEmailDomainPattern !== null });
    } catch (error) {
      if (isExpectedInviteFailure(error)) {
        await asyncAbuseGuard.consume("invite.preview.failed", request.headers, abuseContext);
      }
      throw error;
    }
  });
}

export async function POST(request: Request, context: Context) {
  return handle(request, async ({ hostScope }) => {
    const { asyncTenancy, asyncAbuseGuard, application, config } = await services();
    const { inviteLinkId } = await context.params;
    assertProductionHttps(request, config, "Invite acceptance");
    const requestId = requestIdFromHeaders(request.headers);
    const abuseContext = { routePattern: "/api/invite-links/:inviteLinkId", requestId };
    const consume = (bucket: "invite.accept.attempt" | "invite.accept.failed") => asyncAbuseGuard.consume(bucket, request.headers, abuseContext);
    await consume("invite.accept.attempt");
    await asyncAbuseGuard.assertNotBlocked("invite.accept.failed", request.headers, abuseContext);
    try {
      const claims = await optionalAsyncWebClaims(request, asyncTenancy);
      if (claims) {
        const result = await asyncTenancy.acceptTeamInviteLink(inviteLinkId, { userId: claims.sub }, { actor: actorFromClaims(claims), source: "web", requestId });
        return json({ outcome: result.outcome, user: result.user, membership: result.membership });
      }
      const authRequest = createValidatedAuthMutationRequest(request, hostScope.publicOrigin);
      // Invite registration credentials are sensitive: parse only after the HTTPS guard and never log or capture this body.
      const body = await bodyJson<{ email?: unknown; password?: unknown }>(request);
      const email = String(body.email ?? "");
      const password = body.password;
      const accepted = await asyncTenancy.acceptTeamInviteLinkWithCredentialsAndBetterAuth(inviteLinkId, { email, password }, authRequest, { source: "web", requestId });
      const response = json({
        outcome: accepted.result.outcome,
        accountOutcome: accepted.accountOutcome,
        user: accepted.session.user,
        membership: accepted.result.membership
      });
      for (const cookie of accepted.session.setCookieHeaders) response.headers.append("set-cookie", cookie);
      return response;
    } catch (error) {
      if (isExpectedInviteFailure(error)) await consume("invite.accept.failed");
      throw error;
    }
  });
}

function isExpectedInviteFailure(error: unknown): boolean {
  return error instanceof RelayError
    && error.status >= 400
    && error.status < 500
    && error.code !== "rate_limited";
}

async function optionalAsyncWebClaims(request: Request, tenancy: Awaited<ReturnType<typeof services>>["asyncTenancy"]) {
  try {
    return await tenancy.requireUser(request.headers);
  } catch (error) {
    if (error instanceof RelayError && error.code === "unauthorized") return null;
    throw error;
  }
}
