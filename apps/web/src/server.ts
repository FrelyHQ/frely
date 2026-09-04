import { errorPayload, errorStatus, RelayError } from "@frely/core";
import { loadConfig } from "@frely/config";
import { traceHttpRequest } from "@frely/observability/server";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import { isCanonicalWebHost, resolveWebHostScopeAsync } from "../lib/domain-binding";
import { assertProductionHttps, withWebRequestServices } from "../lib/server";
import { registerWebObservability } from "./server/observability-bootstrap";
import { createWebRequestScope } from "./server/request";
import { withWebSecurityHeaders } from "./server/security-response";

await registerWebObservability();
const startHandler = createStartHandler(defaultStreamHandler);

export default createServerEntry({
  async fetch(incomingRequest) {
    const { request, requestId } = createWebRequestScope(incomingRequest);
    return traceHttpRequest(request, async () => {
      try {
        // Health is a transport-level probe with no authentication or request body. Keep it
        // reachable from the loopback Docker healthcheck before the business Host/HTTPS prelude.
        if (request.method === "GET" && new URL(request.url).pathname === "/api/health") {
          return withWebSecurityHeaders(await startHandler(request), { requestId });
        }
        const config = await loadConfig();
        // The canonical Host is self-authenticating from configuration; avoid opening the database
        // just to reject an unknown page when the standalone image has no database attached.
        if (isCanonicalWebHost(config, request.headers)) {
          // Production Web traffic must be HTTPS before Start or any route handler can authenticate or read a body.
          assertProductionHttps(request, config, "Web requests");
          return withWebSecurityHeaders(await startHandler(request), { requestId });
        }
        const response = await withWebRequestServices(async (appServices) => {
          // Non-canonical Hosts are an authorization boundary. Resolve them before Start routing, auth, or body parsing.
          await resolveWebHostScopeAsync(appServices.application.queries, appServices.config, request.headers);
          // Production Web traffic must be HTTPS before Start or any route handler can authenticate or read a body.
          assertProductionHttps(request, appServices.config, "Web requests");
          return startHandler(request);
        });
        return withWebSecurityHeaders(response, { requestId });
      } catch (error) {
        const safeError = error instanceof RelayError
          ? error
          : new RelayError("internal_error", "Internal server error", 500);
        process.stdout.write(`${JSON.stringify({ event: "web.request.failed", code: safeError.code })}\n`);
        return withWebSecurityHeaders(Response.json(errorPayload(safeError, requestId), {
          status: errorStatus(safeError),
          headers: { "x-request-id": requestId },
        }), { requestId });
      }
    });
  },
});
