import { WEB_VERSION } from "../web-version";

let registration: Promise<void> | undefined;

export function registerWebObservability(): Promise<void> {
  registration ??= import("@frely/observability/instrumentation")
    .then(({ registerFridayRelayObservability }) => {
      registerFridayRelayObservability({
        serviceName: "friday-relay-web",
        serviceVersion: WEB_VERSION,
      });
    })
    .catch(() => {
      process.stdout.write(`${JSON.stringify({ event: "web.observability.unavailable", code: "observability_bootstrap_failed" })}\n`);
    });
  return registration;
}
