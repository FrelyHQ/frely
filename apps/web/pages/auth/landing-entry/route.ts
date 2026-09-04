import { landingRegistrationEntryCookieHeaders, verifyLandingEntryState } from "@frely/auth";
import { readBoundedRequestText, RelayError } from "@frely/core";
import { assertProductionHttps, handle, services } from "../../../lib/server";

export async function POST(request: Request) {
  const response = await handle(request, async ({ hostScope }) => {
    const { application, config } = await services();
    if (hostScope.kind !== "platform" || hostScope.publicOrigin !== new URL(config.app.publicBaseUrl).origin) {
      throw new RelayError("landing_entry_unavailable", "Landing entry is unavailable", 404);
    }
    assertProductionHttps(request, config, "Landing entry");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      throw new RelayError("invalid_form_data", "Landing entry form data is invalid", 400);
    }
    const raw = await readBoundedRequestText(request, 8_192);
    const params = new URLSearchParams(raw);
    if (params.getAll("state").length !== 1 || [...params.keys()].some((key) => key !== "state")) {
      throw new RelayError("invalid_landing_entry_request", "Landing entry form data is invalid", 400);
    }
    const state = verifyLandingEntryState(config, params.get("state") ?? "", { canonicalOrigin: config.app.publicBaseUrl });
    const binding = await application.queries.resolveActiveDomainBinding(state.hostname);
    if (!binding || binding.id !== state.domainBindingId) throw new RelayError("landing_entry_unavailable", "Landing entry is unavailable", 404);
    const response = new Response(null, {
      status: 303,
      headers: {
        location: new URL("/login?entry=partner&next=/user", config.app.publicBaseUrl).toString(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer"
      }
    });
    for (const cookie of landingRegistrationEntryCookieHeaders(config, params.get("state")!)) response.headers.append("set-cookie", cookie);
    return response;
  });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
