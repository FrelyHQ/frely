import { afterEach, describe, expect, test } from "vitest";
import { gatewayMetricResourceAttributes, registerFridayRelayGatewayMetrics } from "./gateway-metrics";

const originalEnvironment = {
  deployment: process.env.FRIDAY_RELAY_DEPLOYMENT_ENVIRONMENT,
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  metricsEndpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  release: process.env.FRIDAY_RELAY_RELEASE,
  runtimeFingerprint: process.env.FRIDAY_RELAY_RUNTIME_FINGERPRINT,
};

afterEach(() => {
  restore("FRIDAY_RELAY_DEPLOYMENT_ENVIRONMENT", originalEnvironment.deployment);
  restore("OTEL_EXPORTER_OTLP_ENDPOINT", originalEnvironment.endpoint);
  restore("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", originalEnvironment.metricsEndpoint);
  restore("FRIDAY_RELAY_RELEASE", originalEnvironment.release);
  restore("FRIDAY_RELAY_RUNTIME_FINGERPRINT", originalEnvironment.runtimeFingerprint);
});

describe("Gateway metric-only observability", () => {
  test("remains optional when no OTLP endpoint is configured", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    expect(registerFridayRelayGatewayMetrics({ serviceVersion: "0.54.0" })).toBeNull();
  });

  test("uses bounded deployment identity without request or principal attributes", () => {
    process.env.FRIDAY_RELAY_DEPLOYMENT_ENVIRONMENT = "review-dev";
    process.env.FRIDAY_RELAY_RELEASE = "v0.54.0";
    process.env.FRIDAY_RELAY_RUNTIME_FINGERPRINT = "sha256:abc123";

    expect(gatewayMetricResourceAttributes({ serviceVersion: "0.54.0" })).toEqual({
      "service.name": "friday-relay-gateway",
      "service.version": "0.54.0",
      "deployment.environment": "review-dev",
      "deployment.environment.name": "review-dev",
      "friday.release": "v0.54.0",
      "friday.runtime_fingerprint": "sha256:abc123",
    });
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
