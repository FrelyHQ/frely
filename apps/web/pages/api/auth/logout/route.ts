import { clearAuthCookieHeaders, createValidatedAuthMutationRequest } from "@frely/auth";
import { requestIdFromHeaders } from "@frely/core";
import { assertProductionHttps, handle, json, services } from "../../../../lib/server";

export async function POST(request: Request) {
  return handle(request, async ({ hostScope }) => {
    const { asyncTenancy, config } = await services();
    assertProductionHttps(request, config, "Logout");
    const authRequest = createValidatedAuthMutationRequest(request, hostScope.publicOrigin);
    const setCookieHeaders = await asyncTenancy.logoutWithBetterAuth(authRequest, { source: "web", requestId: requestIdFromHeaders(request.headers) });
    const response = json({ ok: true });
    for (const cookie of setCookieHeaders) response.headers.append("set-cookie", cookie);
    for (const cookie of clearAuthCookieHeaders(config, "web")) response.headers.append("set-cookie", cookie);
    return response;
  });
}
