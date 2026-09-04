import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { normalizeRelease } from "./contracts.js";

export interface FridayRelayGatewayMetricsOptions {
  serviceVersion: string;
}

export interface FridayRelayGatewayMetricsControl {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

const globalState = globalThis as typeof globalThis & {
  __fridayRelayGatewayMetricsControl?: FridayRelayGatewayMetricsControl;
};

export function registerFridayRelayGatewayMetrics(
  options: FridayRelayGatewayMetricsOptions,
): FridayRelayGatewayMetricsControl | null {
  if (globalState.__fridayRelayGatewayMetricsControl) {
    return globalState.__fridayRelayGatewayMetricsControl;
  }

  const endpoint = metricsEndpoint();
  if (!endpoint) return null;

  const timeoutMillis = boundedInteger(process.env.OTEL_EXPORTER_OTLP_TIMEOUT, 3_000, 500, 10_000);
  const reader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: endpoint,
      timeoutMillis,
      concurrencyLimit: 1,
    }),
    exportIntervalMillis: boundedInteger(process.env.OTEL_METRIC_EXPORT_INTERVAL, 15_000, 5_000, 60_000),
    exportTimeoutMillis: timeoutMillis,
  });
  const provider = new MeterProvider({
    resource: resourceFromAttributes(gatewayMetricResourceAttributes(options)),
    readers: [reader],
  });
  if (!metrics.setGlobalMeterProvider(provider)) {
    void provider.shutdown();
    throw new Error("Gateway metric provider could not be registered because a global provider already exists");
  }

  let shutDown = false;
  const control: FridayRelayGatewayMetricsControl = {
    forceFlush: () => shutDown ? Promise.resolve() : provider.forceFlush(),
    shutdown: async () => {
      if (shutDown) return;
      shutDown = true;
      await provider.shutdown();
    },
  };
  globalState.__fridayRelayGatewayMetricsControl = control;
  return control;
}

export function gatewayMetricResourceAttributes(options: FridayRelayGatewayMetricsOptions): Record<string, string> {
  const environment = deploymentEnvironment();
  return {
    "service.name": "friday-relay-gateway",
    "service.version": safeToken(options.serviceVersion),
    "deployment.environment": environment,
    "deployment.environment.name": environment,
    "friday.release": normalizeRelease(process.env.FRIDAY_RELAY_RELEASE ?? "dev"),
    "friday.runtime_fingerprint": safeToken(process.env.FRIDAY_RELAY_RUNTIME_FINGERPRINT),
  };
}

function metricsEndpoint(): string | null {
  const explicit = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  if (explicit) return explicit;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, "");
  return base ? `${base}/v1/metrics` : null;
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function deploymentEnvironment(): string {
  const value = process.env.FRIDAY_RELAY_DEPLOYMENT_ENVIRONMENT;
  return value === "llm" || value === "review-dev" || value === "local" ? value : "unknown";
}

function safeToken(value: string | undefined): string {
  const candidate = value?.trim();
  return candidate && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(candidate)
    ? candidate
    : "unknown";
}
