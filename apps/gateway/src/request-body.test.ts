import { describe, expect, it, vi } from "vitest";
import {
  admissionBodyBytes,
  acquireBodyRequestLease,
  BODY_BYTES_PER_UNIT,
  BodyMemoryController,
  gatewayBodyRequestKind,
  inspectRequestBodyFraming,
  MEMORY_BYTES_PER_UNIT,
  readBoundedJsonBody,
  requiredBodyUnits,
  SystemBodyMemorySampler,
  WeightedBodyRequestCapacity
} from "./request-body.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("Gateway bounded request bodies", () => {
  it("accepts exactly-at-limit JSON and counts UTF-8 bytes instead of characters", async () => {
    const json = JSON.stringify({ input: "你好" });
    const bytes = Buffer.byteLength(json);

    await expect(readBoundedJsonBody(requestWithStream([Buffer.from(json)], { "content-length": String(bytes) }), bytes)).resolves.toEqual({ input: "你好" });
    await expect(readBoundedJsonBody(requestWithStream([Buffer.from(json)]), bytes - 1)).rejects.toMatchObject({
      code: "request_body_too_large",
      status: 413,
      message: "Gateway request body is too large",
      details: {}
    });
  });

  it("rejects a declared oversized body before reading it", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const request = requestWithStream([], { "content-length": "101" }, { pull, cancel });

    await expect(readBoundedJsonBody(request, 100)).rejects.toMatchObject({ code: "request_body_too_large", status: 413 });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("enforces the actual byte limit when Content-Length is absent", async () => {
    const body = Buffer.from(JSON.stringify({ input: "0123456789" }));
    const chunks = [body.subarray(0, 5), body.subarray(5)];

    await expect(readBoundedJsonBody(requestWithStream(chunks), body.byteLength - 1)).rejects.toMatchObject({ code: "request_body_too_large" });
  });

  it("distinguishes understated, incomplete, and aborted declared bodies", async () => {
    const validBody = Buffer.from('{"ok":true}');
    await expect(readBoundedJsonBody(requestWithStream([validBody], { "content-length": "1" }), validBody.byteLength)).rejects.toMatchObject({
      code: "invalid_content_length",
      status: 400
    });
    await expect(readBoundedJsonBody(requestWithStream([validBody], { "content-length": String(validBody.byteLength + 1) }), validBody.byteLength + 1)).rejects.toMatchObject({
      code: "incomplete_request_body",
      status: 400
    });

    const controller = new AbortController();
    const aborted = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-length": String(validBody.byteLength + 1) },
      body: new ReadableStream<Uint8Array>({
        pull(streamController) {
          controller.abort();
          streamController.error(new Error("connection reset"));
        }
      }),
      duplex: "half",
      signal: controller.signal
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedJsonBody(aborted, validBody.byteLength + 1)).rejects.toMatchObject({ code: "request_aborted", status: 499 });
  });

  it("accepts a normal body larger than 8 MiB when the deployment limit allows it", async () => {
    const json = JSON.stringify({ input: "x".repeat(8 * MIB + 1) });
    const bytes = Buffer.from(json);
    const payload = await readBoundedJsonBody(requestWithStream([bytes]), bytes.byteLength);
    expect((payload.input as string).length).toBe(8 * MIB + 1);
  });

  it("preserves the existing malformed JSON fallback", async () => {
    await expect(readBoundedJsonBody(requestWithStream([Buffer.from("{not-json")]), 1024)).resolves.toEqual({});
    await expect(readBoundedJsonBody(new Request("http://localhost/v1/responses", { method: "POST" }), 1024)).resolves.toEqual({});
  });
});

describe("Gateway request body framing", () => {
  it("accepts one canonical Content-Length and treats a missing header as legal", () => {
    expect(inspectRequestBodyFraming(["Content-Length", "0"])).toEqual({ contentLengthPresent: true, contentLength: 0 });
    expect(inspectRequestBodyFraming(["content-length", "1048577"])).toEqual({ contentLengthPresent: true, contentLength: 1_048_577 });
    expect(inspectRequestBodyFraming(["content-type", "application/json"])).toEqual({ contentLengthPresent: false });
  });

  it("rejects duplicate, conflicting, non-canonical, unsafe, and TE plus CL framing", () => {
    const invalid = [
      ["Content-Length", "1", "Content-Length", "1"],
      ["Content-Length", "1", "Content-Length", "2"],
      ["Content-Length", "-1"],
      ["Content-Length", "01"],
      ["Content-Length", "1.5"],
      ["Content-Length", "9007199254740992"],
      ["Transfer-Encoding", "chunked", "Content-Length", "1"]
    ];
    for (const rawHeaders of invalid) {
      expect(() => inspectRequestBodyFraming(rawHeaders)).toThrow(expect.objectContaining({ code: "invalid_content_length", status: 400 }));
    }
  });

  it("uses declared bytes for admission and the maximum body limit when absent", () => {
    expect(admissionBodyBytes({ contentLengthPresent: true, contentLength: 1 }, 32 * MIB)).toBe(1);
    expect(admissionBodyBytes({ contentLengthPresent: false }, 32 * MIB)).toBe(32 * MIB);
    expect(() => admissionBodyBytes({ contentLengthPresent: true, contentLength: 33 * MIB }, 32 * MIB)).toThrow(
      expect.objectContaining({ code: "request_body_too_large", status: 413 })
    );
  });
});

describe("Gateway weighted body capacity", () => {
  it("assigns capacity only to the four body-bearing Gateway endpoints", () => {
    expect(gatewayBodyRequestKind("/v1/messages")).toBe("messages");
    expect(gatewayBodyRequestKind("/v1/responses")).toBe("responses");
    expect(gatewayBodyRequestKind("/v1/embeddings")).toBe("embeddings");
    expect(gatewayBodyRequestKind("/v1/chat/completions")).toBe("chat.completions");
    expect(gatewayBodyRequestKind("/v1/models")).toBeUndefined();
    expect(gatewayBodyRequestKind("/health")).toBeUndefined();
    expect(gatewayBodyRequestKind("/v1/unknown")).toBeUndefined();
  });

  it("rounds body weights up to 1 MiB units", () => {
    expect(BODY_BYTES_PER_UNIT).toBe(MIB);
    expect(MEMORY_BYTES_PER_UNIT).toBe(9 * MIB);
    expect(requiredBodyUnits(0)).toBe(1);
    expect(requiredBodyUnits(1)).toBe(1);
    expect(requiredBodyUnits(MIB)).toBe(1);
    expect(requiredBodyUnits(MIB + 1)).toBe(2);
    expect(requiredBodyUnits(32 * MIB)).toBe(32);
  });

  it("rejects without queueing, shrinks without killing leases, and releases exactly once", () => {
    const capacity = new WeightedBodyRequestCapacity();
    capacity.updateMemory({ effectiveLimitBytes: 2 * GIB, effectiveAvailableBytes: 1 * GIB });
    expect(capacity.totalUnits).toBe(56);

    const smallLeases = Array.from({ length: 10 }, () => capacity.tryAcquire(1024));
    expect(smallLeases.every(Boolean)).toBe(true);
    expect(capacity.usedUnits).toBe(10);
    const large = capacity.tryAcquire(32 * MIB);
    expect(large?.units).toBe(32);
    expect(capacity.usedUnits).toBe(42);

    capacity.updateMemory({ effectiveLimitBytes: 2 * GIB, effectiveAvailableBytes: 512 * MIB });
    expect(capacity.totalUnits).toBe(0);
    expect(capacity.usedUnits).toBe(42);
    expect(capacity.tryAcquire(1)).toBeUndefined();
    expect(() => acquireBodyRequestLease(capacity, 1)).toThrow(expect.objectContaining({ code: "gateway_capacity_exceeded", status: 503 }));

    large!.release();
    large!.release();
    for (const lease of smallLeases) lease!.release();
    expect(capacity.usedUnits).toBe(0);
    capacity.updateMemory({ effectiveLimitBytes: 2 * GIB, effectiveAvailableBytes: 1 * GIB });
    expect(capacity.tryAcquire(56 * MIB)).toBeDefined();
  });

  it("keeps weighted units occupied across parse, provider, and stream work until terminal release", async () => {
    const capacity = new WeightedBodyRequestCapacity();
    capacity.updateMemory({ effectiveLimitBytes: 1 * GIB, effectiveAvailableBytes: 521 * MIB });
    expect(capacity.totalUnits).toBe(1);
    const lease = acquireBodyRequestLease(capacity, 1);
    await readBoundedJsonBody(requestWithStream([Buffer.from('{"stream":true}')]), 1024);
    expect(capacity.tryAcquire(1)).toBeUndefined();
    await Promise.resolve("provider-started");
    expect(capacity.tryAcquire(1)).toBeUndefined();
    await new ReadableStream({ start(controller) { controller.close(); } }).pipeTo(new WritableStream());
    expect(capacity.tryAcquire(1)).toBeUndefined();
    lease.release();
    expect(capacity.tryAcquire(1)).toBeDefined();
  });

  it("keeps the 20 percent proportional reserve above the 512 MiB minimum", () => {
    const capacity = new WeightedBodyRequestCapacity();
    capacity.updateMemory({ effectiveLimitBytes: 4 * GIB, effectiveAvailableBytes: 2 * GIB });
    expect(capacity.takeRuntimeSnapshot().safetyReserveBytes).toBe(Math.floor(4 * GIB * 0.2));
  });

  it("fails closed before the first valid memory sample and keeps the last sample after refresh failure", async () => {
    const capacity = new WeightedBodyRequestCapacity();
    expect(capacity.tryAcquire(1)).toBeUndefined();
    const samples = [
      { effectiveLimitBytes: 2 * GIB, effectiveAvailableBytes: 1 * GIB },
      undefined
    ];
    const controller = new BodyMemoryController(capacity, { sample: async () => samples.shift() });
    await expect(controller.refresh()).resolves.toBe(true);
    expect(capacity.totalUnits).toBe(56);
    await expect(controller.refresh()).resolves.toBe(false);
    expect(capacity.totalUnits).toBe(56);
    controller.stop();
  });

  it("reports only aggregate capacity, working set, refault, framing, outcome, and cgroup event deltas", () => {
    const capacity = new WeightedBodyRequestCapacity();
    capacity.updateMemory({
      effectiveLimitBytes: 2 * GIB,
      effectiveAvailableBytes: 1 * GIB,
      cgroupMemory: {
        currentBytes: 1536 * MIB,
        inactiveFileBytes: 512 * MIB,
        activeFileBytes: 256 * MIB,
        workingSetBytes: 1 * GIB,
        workingsetRefaultFile: 100
      },
      cgroupEvents: { high: 2, max: 3, oom: 1, oomKill: 1 }
    });
    capacity.updateMemory({
      effectiveLimitBytes: 2 * GIB,
      effectiveAvailableBytes: 1 * GIB,
      cgroupMemory: {
        currentBytes: 1600 * MIB,
        inactiveFileBytes: 512 * MIB,
        activeFileBytes: 300 * MIB,
        workingSetBytes: 1088 * MIB,
        workingsetRefaultFile: 140
      },
      cgroupEvents: { high: 5, max: 4, oom: 1, oomKill: 2 }
    });
    capacity.recordContentLength(true);
    capacity.recordContentLength(false);
    capacity.recordOutcome("request_aborted");
    capacity.recordOutcome("incomplete_request_body");
    capacity.recordOutcome("invalid_content_length");
    capacity.recordOutcome("request_body_too_large");
    capacity.tryAcquire(65 * MIB);

    expect(capacity.takeRuntimeSnapshot()).toMatchObject({
      sampleValid: true,
      effectiveMemoryLimitBytes: 2 * GIB,
      effectiveMemoryAvailableBytes: 1 * GIB,
      safetyReserveBytes: 512 * MIB,
      totalUnits: 56,
      usedUnits: 0,
      cgroupMemory: {
        currentBytes: 1600 * MIB,
        inactiveFileBytes: 512 * MIB,
        activeFileBytes: 300 * MIB,
        workingSetBytes: 1088 * MIB,
        workingsetRefaultFileDelta: 40
      },
      contentLength: { present: 1, absent: 1 },
      outcomes: {
        capacityExceeded: 1,
        requestAborted: 1,
        incompleteRequestBody: 1,
        invalidContentLength: 1,
        requestBodyTooLarge: 1
      },
      cgroupMemoryEventsDelta: { high: 3, max: 1, oom: 0, oomKill: 1 }
    });
    expect(capacity.takeRuntimeSnapshot()).toMatchObject({
      contentLength: { present: 0, absent: 0 },
      outcomes: { capacityExceeded: 0 },
      cgroupMemory: { workingsetRefaultFileDelta: 0 },
      cgroupMemoryEventsDelta: { high: 0, max: 0, oom: 0, oomKill: 0 }
    });
  });

  it("does not create negative refault deltas and resets the baseline after a sample gap", () => {
    const capacity = new WeightedBodyRequestCapacity();
    const update = (workingsetRefaultFile: number) =>
      capacity.updateMemory({
        effectiveLimitBytes: 2 * GIB,
        effectiveAvailableBytes: 1 * GIB,
        cgroupMemory: {
          currentBytes: 1 * GIB,
          inactiveFileBytes: 256 * MIB,
          activeFileBytes: 128 * MIB,
          workingSetBytes: 768 * MIB,
          workingsetRefaultFile
        }
      });

    update(100);
    update(110);
    update(80);
    expect(capacity.takeRuntimeSnapshot().cgroupMemory?.workingsetRefaultFileDelta).toBe(10);
    update(84);
    expect(capacity.takeRuntimeSnapshot().cgroupMemory?.workingsetRefaultFileDelta).toBe(4);
    expect(capacity.takeRuntimeSnapshot().cgroupMemory?.workingsetRefaultFileDelta).toBe(0);

    capacity.updateMemory({ effectiveLimitBytes: 2 * GIB, effectiveAvailableBytes: 1 * GIB });
    expect(capacity.takeRuntimeSnapshot().cgroupMemory).toBeNull();
    update(20_000);
    expect(capacity.takeRuntimeSnapshot().cgroupMemory?.workingsetRefaultFileDelta).toBe(0);
  });
});

describe("Gateway system memory sampling", () => {
  it("recovers body capacity when raw cgroup usage is mostly inactive file cache", async () => {
    const capacity = new WeightedBodyRequestCapacity();
    capacity.updateMemory({ effectiveLimitBytes: 1536 * MIB, effectiveAvailableBytes: 136 * MIB });
    expect(capacity.totalUnits).toBe(0);

    const sample = await samplerWithFiles({
      "/proc/meminfo": "MemAvailable:   4194304 kB\n",
      "/sys/fs/cgroup/memory.max": String(1536 * MIB),
      "/sys/fs/cgroup/memory.current": String(1400 * MIB),
      "/sys/fs/cgroup/memory.stat": v2Stat({ inactiveFileBytes: 800 * MIB, activeFileBytes: 200 * MIB, refault: 1 })
    }).sample();
    expect(sample).toBeDefined();
    capacity.updateMemory(sample!);
    expect(capacity.totalUnits).toBeGreaterThan(0);
  });

  it("restores cgroup v2 capacity from inactive file cache and keeps active file in the working set", async () => {
    const sampler = samplerWithFiles({
      "/proc/meminfo": "MemTotal:       8388608 kB\nMemAvailable:   5242880 kB\n",
      "/sys/fs/cgroup/memory.max": String(6 * GIB),
      "/sys/fs/cgroup/memory.current": String(5 * GIB),
      "/sys/fs/cgroup/memory.stat": v2Stat({ inactiveFileBytes: 3 * GIB, activeFileBytes: 1536 * MIB, refault: 42 }),
      "/sys/fs/cgroup/memory.events": "low 0\nhigh 2\nmax 3\noom 1\noom_kill 1\n"
    });
    await expect(sampler.sample()).resolves.toEqual({
      effectiveLimitBytes: 6 * GIB,
      effectiveAvailableBytes: 4 * GIB,
      cgroupMemory: {
        currentBytes: 5 * GIB,
        inactiveFileBytes: 3 * GIB,
        activeFileBytes: 1536 * MIB,
        workingSetBytes: 2 * GIB,
        workingsetRefaultFile: 42
      },
      cgroupEvents: { high: 2, max: 3, oom: 1, oomKill: 1 }
    });
  });

  it("does not treat active file cache as reclaimable and applies the host MemAvailable cap", async () => {
    const sampler = samplerWithFiles({
      "/proc/meminfo": "MemAvailable:   1048576 kB\n",
      "/sys/fs/cgroup/memory.max": String(6 * GIB),
      "/sys/fs/cgroup/memory.current": String(5 * GIB),
      "/sys/fs/cgroup/memory.stat": v2Stat({ inactiveFileBytes: 256 * MIB, activeFileBytes: 4 * GIB, refault: 0 })
    });
    await expect(sampler.sample()).resolves.toMatchObject({
      effectiveAvailableBytes: 1 * GIB,
      cgroupMemory: { activeFileBytes: 4 * GIB, workingSetBytes: 4864 * MIB }
    });
  });

  it("clamps cgroup v2 inactive file bytes to current usage", async () => {
    const sampler = samplerWithFiles({
      "/proc/meminfo": "MemAvailable:   6291456 kB\n",
      "/sys/fs/cgroup/memory.max": String(6 * GIB),
      "/sys/fs/cgroup/memory.current": String(2 * GIB),
      "/sys/fs/cgroup/memory.stat": v2Stat({ inactiveFileBytes: 3 * GIB, activeFileBytes: 1, refault: 1 })
    });
    await expect(sampler.sample()).resolves.toMatchObject({
      effectiveAvailableBytes: 6 * GIB,
      cgroupMemory: { inactiveFileBytes: 2 * GIB, workingSetBytes: 0 }
    });
  });

  it.each([
    ["missing", undefined],
    ["missing inactive_file", "active_file 1\nworkingset_refault_file 1\n"],
    ["negative inactive_file", "inactive_file -1\nactive_file 1\nworkingset_refault_file 1\n"],
    ["non-decimal inactive_file", "inactive_file 1.5\nactive_file 1\nworkingset_refault_file 1\n"],
    ["overflowing inactive_file", "inactive_file 9007199254740992\nactive_file 1\nworkingset_refault_file 1\n"]
  ])("falls back to raw cgroup v2 usage when memory.stat is %s", async (_name, stat) => {
    const files: Record<string, string> = {
      "/proc/meminfo": "MemAvailable:   5242880 kB\n",
      "/sys/fs/cgroup/memory.max": String(6 * GIB),
      "/sys/fs/cgroup/memory.current": String(5 * GIB)
    };
    if (stat !== undefined) files["/sys/fs/cgroup/memory.stat"] = stat;
    await expect(samplerWithFiles(files).sample()).resolves.toEqual({
      effectiveLimitBytes: 6 * GIB,
      effectiveAvailableBytes: 1 * GIB
    });
  });

  it("does not read cgroup v1 files when v2 values are invalid", async () => {
    const sampler = samplerWithFiles({
      "/proc/meminfo": "MemAvailable:   3145728 kB\n",
      "/sys/fs/cgroup/memory.max": "9223372036854771712\n",
      "/sys/fs/cgroup/memory.current": "broken\n",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(4 * GIB),
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(3 * GIB),
      "/sys/fs/cgroup/memory/memory.stat": "total_inactive_file 2147483648\ntotal_active_file 536870912\n"
    });
    await expect(sampler.sample()).resolves.toEqual({ effectiveLimitBytes: 8 * GIB, effectiveAvailableBytes: 3 * GIB });
  });

  it("uses Node memory values outside Linux", async () => {
    const sampler = new SystemBodyMemorySampler({
      platform: "darwin",
      hostTotalMemory: () => 8 * GIB,
      hostFreeMemory: () => 2 * GIB,
      readText: async () => {
        throw new Error("must not read Linux memory files");
      }
    });
    await expect(sampler.sample()).resolves.toEqual({ effectiveLimitBytes: 8 * GIB, effectiveAvailableBytes: 2 * GIB });
  });
});

function samplerWithFiles(files: Record<string, string>): SystemBodyMemorySampler {
  return new SystemBodyMemorySampler({
    platform: "linux",
    hostTotalMemory: () => 8 * GIB,
    hostFreeMemory: () => 2 * GIB,
    readText: async (path) => {
      const value = files[path];
      if (value === undefined) throw new Error("ENOENT");
      return value;
    }
  });
}

function v2Stat(input: { inactiveFileBytes: number; activeFileBytes: number; refault: number }): string {
  return `anon 1\ninactive_file ${input.inactiveFileBytes}\nactive_file ${input.activeFileBytes}\nworkingset_refault_file ${input.refault}\n`;
}

function requestWithStream(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
  hooks: { pull?: () => void; cancel?: () => void } = {}
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks.pull?.();
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      hooks.cancel?.();
    }
  });
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, headers, duplex: "half" };
  return new Request("http://localhost/v1/responses", init);
}
