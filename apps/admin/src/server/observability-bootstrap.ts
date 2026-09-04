import { ADMIN_VERSION } from "../../lib/admin-version";

let registration: Promise<void> | undefined;

export function registerAdminObservability(): Promise<void> {
  registration ??= import("@frely/observability/instrumentation")
    .then(({ registerFridayRelayObservability }) => {
      registerFridayRelayObservability({
        serviceName: "friday-relay-admin",
        serviceVersion: ADMIN_VERSION,
      });
    })
    .catch(() => {
      process.stdout.write(`${JSON.stringify({ event: "admin.observability.unavailable", code: "observability_bootstrap_failed" })}\n`);
    });
  return registration;
}
