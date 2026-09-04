import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { AggregationType, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { registerOTel } from "@vercel/otel";
import { performance } from "node:perf_hooks";
import { normalizeRelease } from "./contracts.js";

export interface FridayRelayInstrumentationOptions {
  serviceName: "friday-relay-admin" | "friday-relay-web";
  serviceVersion: string;
}

const globalState = globalThis as typeof globalThis & {
  __fridayRelayOtelServices?: Set<string>;
};

export function registerFridayRelayObservability(options: FridayRelayInstrumentationOptions): void {
  const registered = globalState.__fridayRelayOtelServices ??= new Set<string>();
  if (registered.has(options.serviceName)) return;

  const endpoint = metricsEndpoint();
  const metricReaders = endpoint ? [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: endpoint,
        timeoutMillis: boundedInteger(process.env.OTEL_EXPORTER_OTLP_TIMEOUT, 3_000, 500, 10_000),
        concurrencyLimit: 1,
      }),
      exportIntervalMillis: boundedInteger(process.env.OTEL_METRIC_EXPORT_INTERVAL, 15_000, 5_000, 60_000),
      exportTimeoutMillis: boundedInteger(process.env.OTEL_EXPORTER_OTLP_TIMEOUT, 3_000, 500, 10_000),
    }),
  ] : [];

  registerOTel({
    serviceName: options.serviceName,
    attributes: {
      "service.version": safeToken(options.serviceVersion),
      "deployment.environment": deploymentEnvironment(),
      "deployment.environment.name": deploymentEnvironment(),
      "friday.release": normalizeRelease(process.env.FRIDAY_RELAY_RELEASE ?? "dev"),
      "friday.runtime_fingerprint": safeToken(process.env.FRIDAY_RELAY_RUNTIME_FINGERPRINT),
    },
    autoDetectResources: false,
    instrumentations: ["fetch"],
    instrumentationConfig: {
      fetch: {
        propagateContextUrls: [
          /^https?:\/\/(?:127\.0\.0\.1|localhost|gateway-srv|web|admin)(?::\d+)?(?:\/|$)/,
        ],
      },
    },
    metricReaders,
    views: [
      {
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: {
            boundaries: [50, 100, 200, 300, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 7_500, 10_000, 15_000, 30_000, 60_000, 120_000],
          },
        },
        aggregationCardinalityLimit: 512,
        instrumentName: "ui_surface_open_duration_ms",
      },
      {
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: {
            boundaries: [10, 25, 50, 75, 100, 250, 500, 750, 1_000, 2_000, 3_000, 5_000, 7_500, 10_000, 15_000, 30_000, 60_000],
          },
        },
        aggregationCardinalityLimit: 512,
        instrumentName: "web_vital_*_ms",
      },
      {
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: {
            boundaries: [0, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2, 5],
          },
        },
        aggregationCardinalityLimit: 512,
        instrumentName: "web_vital_cls_score",
      },
    ],
    propagators: ["tracecontext"],
    traceSampler: "auto",
  });

  registered.add(options.serviceName);
  registerRuntimeMetrics(options.serviceName);
}

function registerRuntimeMetrics(serviceName: string): void {
  const meter = metrics.getMeter("@frely/observability");
  const attributes = { service: serviceName === "friday-relay-admin" ? "admin" : "web" };
  meter.createObservableGauge("process_runtime_heap_used_bytes", { unit: "By" }).addCallback((result) => {
    result.observe(process.memoryUsage().heapUsed, attributes);
  });
  meter.createObservableGauge("process_runtime_rss_bytes", { unit: "By" }).addCallback((result) => {
    result.observe(process.memoryUsage().rss, attributes);
  });
  let previous = performance.eventLoopUtilization();
  meter.createObservableGauge("process_runtime_event_loop_utilization", { unit: "1" }).addCallback((result) => {
    const current = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(current, previous);
    previous = current;
    result.observe(delta.utilization, attributes);
  });
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
