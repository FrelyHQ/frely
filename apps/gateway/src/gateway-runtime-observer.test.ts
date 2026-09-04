import { describe, expect, test } from "vitest";
import { RequestTiming } from "@frely/gateway-core";
import { gatewayRoutePattern, GatewayRuntimeObserver, type GatewayRuntimeMeasurement, type RuntimeSampler } from "./gateway-runtime-observer.js";
import { WeightedBodyRequestCapacity } from "./request-body.js";

describe("REQ-OPS-002 Gateway runtime observer", () => {
  test("logs only fixed route patterns", () => {
    expect(gatewayRoutePattern("/v1/responses")).toBe("/v1/responses");
    expect(gatewayRoutePattern("/v1/prompt-sentinel")).toBe("/v1/*");
    expect(gatewayRoutePattern("/prompt-sentinel")).toBe("unmatched");
  });

  test("logs request starts and bounded in-flight runtime state with fixed stages", () => {
    const entries: Array<Record<string, unknown>> = [];
    const sampler = new FakeRuntimeSampler({
      windowMs: 30_000,
      eventLoopUtilization: 0.75,
      eventLoopDelayMs: { p50: 12.5, p95: 80, max: 125 },
      cpu: { userMs: 8_000, systemMs: 2_000 },
      memoryBytes: { rss: 100, heapUsed: 60, external: 10 }
    });
    const bodyCapacity = new WeightedBodyRequestCapacity();
    bodyCapacity.updateMemory({
      effectiveLimitBytes: 2 * 1024 ** 3,
      effectiveAvailableBytes: 1024 ** 3,
      cgroupMemory: {
        currentBytes: 1536 * 1024 ** 2,
        inactiveFileBytes: 512 * 1024 ** 2,
        activeFileBytes: 256 * 1024 ** 2,
        workingSetBytes: 1024 ** 3,
        workingsetRefaultFile: 10
      }
    });
    bodyCapacity.updateMemory({
      effectiveLimitBytes: 2 * 1024 ** 3,
      effectiveAvailableBytes: 1024 ** 3,
      cgroupMemory: {
        currentBytes: 1600 * 1024 ** 2,
        inactiveFileBytes: 512 * 1024 ** 2,
        activeFileBytes: 300 * 1024 ** 2,
        workingSetBytes: 1088 * 1024 ** 2,
        workingsetRefaultFile: 13
      }
    });
    bodyCapacity.recordContentLength(true);
    const observer = new GatewayRuntimeObserver({ log: (entry) => entries.push(entry), now: () => 10_000, runtimeSampler: sampler, bodyCapacity });
    const timings = Array.from({ length: 7 }, () => new RequestTiming());
    timings[0]!.start("provider.invoke");
    timings[1]!.start("http.respond");
    timings[1]!.start("stream.forward");

    for (let index = 0; index < timings.length; index += 1) {
      observer.requestStarted({
        requestId: `req_${index}`,
        route: "/v1/responses",
        method: "POST",
        timing: timings[index]!,
        startedAtMs: 1_000 + index
      });
    }
    observer.markStream("req_1", true);
    const sample = observer.sample(10_000) as {
      inFlight: { total: number; streaming: number; byStage: Record<string, number>; oldest: Array<Record<string, unknown>> };
    };

    expect(entries[0]).toEqual({
      event: "gateway.request.started",
      requestId: "req_0",
      route: "/v1/responses",
      method: "POST",
      startedAt: "1970-01-01T00:00:01.000Z"
    });
    expect(sample.inFlight).toMatchObject({
      total: 7,
      streaming: 1,
      byStage: { "provider.invoke": 1, "stream.forward": 1, unmeasured: 5 }
    });
    expect(sample.inFlight.oldest).toHaveLength(5);
    expect(sample.inFlight.oldest.map((request) => request.requestId)).toEqual(["req_0", "req_1", "req_2", "req_3", "req_4"]);
    expect(
      (sample as unknown as {
        bodyCapacity: { totalUnits: number; contentLength: { present: number }; cgroupMemory: Record<string, number> };
      }).bodyCapacity
    ).toMatchObject({
      totalUnits: 56,
      contentLength: { present: 1 },
      cgroupMemory: {
        currentBytes: 1600 * 1024 ** 2,
        inactiveFileBytes: 512 * 1024 ** 2,
        activeFileBytes: 300 * 1024 ** 2,
        workingSetBytes: 1088 * 1024 ** 2,
        workingsetRefaultFileDelta: 3
      }
    });
    expect(JSON.stringify(entries)).not.toContain("Authorization");
    expect(JSON.stringify(entries)).not.toContain("prompt-sentinel");

    observer.requestFinished("req_0");
    const nextSample = observer.sample(10_001) as {
      inFlight: { total: number };
      bodyCapacity: { cgroupMemory: { workingsetRefaultFileDelta: number } };
    };
    expect(nextSample.inFlight.total).toBe(6);
    expect(nextSample.bodyCapacity.cgroupMemory.workingsetRefaultFileDelta).toBe(0);
    observer.stop();
    expect(sampler.closed).toBe(true);
  });

  test("keeps the cgroup memory shape null without a finite working-set sample", () => {
    const bodyCapacity = new WeightedBodyRequestCapacity();
    bodyCapacity.updateMemory({ effectiveLimitBytes: 2 * 1024 ** 3, effectiveAvailableBytes: 1024 ** 3 });
    const observer = new GatewayRuntimeObserver({
      now: () => 10_000,
      log: () => undefined,
      runtimeSampler: new FakeRuntimeSampler({
        windowMs: 30_000,
        eventLoopUtilization: 0,
        eventLoopDelayMs: { p50: 0, p95: 0, max: 0 },
        cpu: { userMs: 0, systemMs: 0 },
        memoryBytes: { rss: 0, heapUsed: 0, external: 0 }
      }),
      bodyCapacity
    });

    expect((observer.sample() as { bodyCapacity: { cgroupMemory: unknown } }).bodyCapacity.cgroupMemory).toBeNull();
    observer.stop();
  });
});

class FakeRuntimeSampler implements RuntimeSampler {
  closed = false;

  constructor(private readonly measurement: GatewayRuntimeMeasurement) {}

  sample(): GatewayRuntimeMeasurement {
    return this.measurement;
  }

  close(): void {
    this.closed = true;
  }
}
