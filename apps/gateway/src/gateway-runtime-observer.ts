import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import type { RequestTiming, RequestTimingStage } from "@frely/gateway-core";
import type { WeightedBodyRequestCapacity } from "./request-body.js";

const SAMPLE_INTERVAL_MS = 30_000;
const MAX_OLDEST_REQUESTS = 5;
const GATEWAY_ROUTES = new Set(["/health", "/v1/models", "/v1/messages", "/v1/responses", "/v1/embeddings", "/v1/chat/completions"]);

export type GatewayRuntimeStage = RequestTimingStage | "unmeasured";

export function gatewayRoutePattern(pathname: string): string {
  if (GATEWAY_ROUTES.has(pathname)) return pathname;
  return pathname.startsWith("/v1/") ? "/v1/*" : "unmatched";
}

export interface GatewayRuntimeMeasurement {
  windowMs: number;
  eventLoopUtilization: number;
  eventLoopDelayMs: { p50: number; p95: number; max: number };
  cpu: { userMs: number; systemMs: number };
  memoryBytes: { rss: number; heapUsed: number; external: number };
}

export interface RuntimeSampler {
  sample(nowMs: number): GatewayRuntimeMeasurement;
  close(): void;
}

interface InFlightRequest {
  requestId: string;
  route: string;
  method: string;
  startedAtMs: number;
  stream: boolean;
  timing: RequestTiming;
}

export interface GatewayRuntimeObserverOptions {
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
  runtimeSampler?: RuntimeSampler;
  bodyCapacity?: Pick<WeightedBodyRequestCapacity, "takeRuntimeSnapshot">;
}

export class GatewayRuntimeObserver {
  private readonly requests = new Map<string, InFlightRequest>();
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly runtimeSampler: RuntimeSampler;
  private readonly bodyCapacity: Pick<WeightedBodyRequestCapacity, "takeRuntimeSnapshot"> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: GatewayRuntimeObserverOptions = {}) {
    this.log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
    this.now = options.now ?? Date.now;
    this.runtimeSampler = options.runtimeSampler ?? new NodeRuntimeSampler(this.now());
    this.bodyCapacity = options.bodyCapacity;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.runtimeSampler.close();
  }

  requestStarted(input: { requestId: string; route: string; method: string; timing: RequestTiming; startedAtMs?: number }): void {
    const startedAtMs = input.startedAtMs ?? this.now();
    this.requests.set(input.requestId, { ...input, startedAtMs, stream: false });
    this.log({
      event: "gateway.request.started",
      requestId: input.requestId,
      route: input.route,
      method: input.method,
      startedAt: new Date(startedAtMs).toISOString()
    });
  }

  markStream(requestId: string, stream: boolean): void {
    const request = this.requests.get(requestId);
    if (request) request.stream = stream;
  }

  requestFinished(requestId: string): void {
    this.requests.delete(requestId);
  }

  sample(nowMs = this.now()): Record<string, unknown> {
    const measurement = this.runtimeSampler.sample(nowMs);
    const requests = [...this.requests.values()];
    const byStage: Partial<Record<GatewayRuntimeStage, number>> = {};
    for (const request of requests) {
      const stage = currentStage(request.timing);
      byStage[stage] = (byStage[stage] ?? 0) + 1;
    }
    const oldest = requests
      .sort((left, right) => left.startedAtMs - right.startedAtMs || left.requestId.localeCompare(right.requestId))
      .slice(0, MAX_OLDEST_REQUESTS)
      .map((request) => ({
        requestId: request.requestId,
        ageMs: Math.max(0, Math.round(nowMs - request.startedAtMs)),
        route: request.route,
        method: request.method,
        stream: request.stream,
        stage: currentStage(request.timing)
      }));
    const entry = {
      event: "gateway.runtime.sample",
      sampledAt: new Date(nowMs).toISOString(),
      windowMs: measurement.windowMs,
      eventLoopUtilization: measurement.eventLoopUtilization,
      eventLoopDelayMs: measurement.eventLoopDelayMs,
      cpu: measurement.cpu,
      memoryBytes: measurement.memoryBytes,
      ...(this.bodyCapacity ? { bodyCapacity: this.bodyCapacity.takeRuntimeSnapshot() } : {}),
      inFlight: {
        total: requests.length,
        streaming: requests.filter((request) => request.stream).length,
        byStage,
        oldest
      }
    };
    this.log(entry);
    return entry;
  }
}

class NodeRuntimeSampler implements RuntimeSampler {
  private readonly eventLoopDelay: IntervalHistogram;
  private previousAtMs: number;
  private previousCpu = process.cpuUsage();
  private previousEventLoopUtilization = performance.eventLoopUtilization();

  constructor(startedAtMs: number) {
    this.previousAtMs = startedAtMs;
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopDelay.enable();
  }

  sample(nowMs: number): GatewayRuntimeMeasurement {
    const currentCpu = process.cpuUsage();
    const currentEventLoopUtilization = performance.eventLoopUtilization();
    const eventLoopDelta = performance.eventLoopUtilization(currentEventLoopUtilization, this.previousEventLoopUtilization);
    const memory = process.memoryUsage();
    const result: GatewayRuntimeMeasurement = {
      windowMs: Math.max(0, Math.round(nowMs - this.previousAtMs)),
      eventLoopUtilization: round(eventLoopDelta.utilization, 4),
      eventLoopDelayMs: {
        p50: nanosecondsToMilliseconds(this.eventLoopDelay.percentile(50)),
        p95: nanosecondsToMilliseconds(this.eventLoopDelay.percentile(95)),
        max: nanosecondsToMilliseconds(this.eventLoopDelay.max)
      },
      cpu: {
        userMs: round((currentCpu.user - this.previousCpu.user) / 1_000, 1),
        systemMs: round((currentCpu.system - this.previousCpu.system) / 1_000, 1)
      },
      memoryBytes: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external }
    };
    this.previousAtMs = nowMs;
    this.previousCpu = currentCpu;
    this.previousEventLoopUtilization = currentEventLoopUtilization;
    this.eventLoopDelay.reset();
    return result;
  }

  close(): void {
    this.eventLoopDelay.disable();
  }
}

function currentStage(timing: RequestTiming): GatewayRuntimeStage {
  const active = timing.activeStages();
  if (active.includes("stream.forward")) return "stream.forward";
  return active.at(-1) ?? "unmeasured";
}

function nanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) ? round(value / 1_000_000, 2) : 0;
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
