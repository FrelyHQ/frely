import { traceHttpRequest } from "@frely/observability/server";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import { registerAdminObservability } from "./server/observability-bootstrap";
import { createAdminRequestScope } from "./server/request";
import { withAdminSecurityHeaders } from "./server/security-response";

await registerAdminObservability();
const startHandler = createStartHandler(defaultStreamHandler);

export default createServerEntry({
  async fetch(incomingRequest) {
    const { request, requestId } = createAdminRequestScope(incomingRequest);
    return traceHttpRequest(request, async () => {
      try {
        const response = await startHandler(request);
        return withAdminSecurityHeaders(response, { requestId });
      } catch {
        process.stdout.write(`${JSON.stringify({ event: "admin.request.failed", code: "internal_server_error" })}\n`);
        return withAdminSecurityHeaders(
          Response.json({ error: "internal_server_error" }, { status: 500 }),
          { requestId },
        );
      }
    });
  },
});
