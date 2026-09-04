import { dialogNames } from "@frely/observability/generated-dialog-registry";
import { createBrowserTelemetryHandler } from "@frely/observability/server";
import { routeNames } from "@admin/telemetry/generated-route-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = createBrowserTelemetryHandler({
  dialogNames,
  release: process.env.FRIDAY_RELAY_RELEASE ?? "dev",
  routeNames,
  service: "admin",
});
