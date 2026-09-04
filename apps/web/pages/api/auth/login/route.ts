import { clearLandingRegistrationEntryCookieHeaders, createValidatedAuthMutationRequest } from "@frely/auth";
import { requestIdFromHeaders } from "@frely/core";
import { isExpectedLoginFailure, normalizeLoginFailure } from "@frely/tenancy";
import { assertProductionHttps, bodyJson, handle, json, services } from "../../../../lib/server";

export async function POST(request: Request) {
  return handle(request, async ({ hostScope }) => {
    const { asyncTenancy, asyncAbuseGuard, config } = await services();
    assertProductionHttps(request, config, "Login");
    const authRequest = createValidatedAuthMutationRequest(request, hostScope.publicOrigin);
    const context = { routePattern: "/api/auth/login", requestId: requestIdFromHeaders(request.headers) };
    await asyncAbuseGuard.consume("auth.login.attempt", request.headers, context);
    await asyncAbuseGuard.assertNotBlocked("auth.login.failed", request.headers, context);
    // Login credentials are sensitive: parse only after the HTTPS guard and never log or capture this body.
    const body = await bodyJson<{ email?: string; password?: string }>(request);
    let session;
    try {
      session = await asyncTenancy.loginWithBetterAuth(body.email ?? "", body.password ?? "", authRequest, { source: "web", requestId: context.requestId });
    } catch (error) {
      if (isExpectedLoginFailure(error)) {
        await asyncAbuseGuard.consume("auth.login.failed", request.headers, context);
        throw normalizeLoginFailure(error);
      }
      throw error;
    }
    const response = json({ user: session.user });
    for (const cookie of session.setCookieHeaders) response.headers.append("set-cookie", cookie);
    for (const cookie of clearLandingRegistrationEntryCookieHeaders(config)) response.headers.append("set-cookie", cookie);
    return response;
  });
}
