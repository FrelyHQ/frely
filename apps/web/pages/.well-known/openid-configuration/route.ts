import { assertProductionHttps, handle, services } from "../../../lib/server";
import { assertOidcRequestHost, maybeMaintainOidcStateAsync, normalizeOidcEndpointError, oidcMetadata } from "../../../lib/oidc";

export async function GET(request: Request) {
  return handle(request, async () => {
    try {
      const { config, application} = await services();
      assertProductionHttps(request, config, "OIDC discovery");
      if (!config.oidc?.enabled) throw new Error("OIDC is disabled");
      assertOidcRequestHost(request, config.oidc.issuer);
      await maybeMaintainOidcStateAsync(application.commands);
      return Response.json(oidcMetadata(config), {
        headers: { "cache-control": "public, max-age=300" }
      });
    } catch (error) {
      throw normalizeOidcEndpointError(error);
    }
  });
}
