import { requestIdFromHeaders } from "@frely/core";
import type { PasskeyHttpContext } from "@frely/tenancy";
import { handle, services } from "./server";

export async function handleWebPasskey(
  request: Request,
  action: (context: PasskeyHttpContext) => Promise<Response> | Response
): Promise<Response> {
  const response = await handle(request, async () => {
    const { asyncTenancy, application, asyncAbuseGuard, config } = await services();
    return action({
      asyncTenancy,
      asyncRepo: {
        consumeAbuseRateLimit: application.commands.consumeAbuseRateLimit,
        consumeAbuseRateLimits: application.commands.consumeAbuseRateLimits,
        listPasskeyCredentials: application.queries.listPasskeyCredentials,
      },
      asyncAbuseGuard,
      config,
      surface: "web",
      requestId: requestIdFromHeaders(request.headers),
    });
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
