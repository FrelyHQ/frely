import { dialogNames } from "@frely/observability/generated-dialog-registry";
import { createBrowserTelemetryHandler } from "@frely/observability/server";
import { routeNames } from "@web/telemetry/generated-route-registry";
import { handle } from "../../../../lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const telemetryHandler = createBrowserTelemetryHandler({
  dialogNames,
  release: process.env.FRIDAY_RELAY_RELEASE ?? "dev",
  routeNames,
  service: "web",
});

export async function POST(request: Request) {
  return handle(request, async () => telemetryHandler(request));
}
