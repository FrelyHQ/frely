import WebSocket from "ws";
import { describe, expect, test, vi } from "vitest";
import { OpaqueForwardQueue } from "./backpressure.js";
import { PiTunnelMetrics } from "./observability.js";

describe("Pi Tunnel bounded backpressure", () => {
  test("queues multiple frames below the absolute bound and rejects aggregate buffered overflow", () => {
    const sent: Buffer[] = [];
    const target = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 100,
      send: vi.fn((frame: Buffer, _options: object, callback: (error?: Error) => void) => {
        sent.push(frame);
        callback();
      }),
    } as unknown as WebSocket;
    const metrics = new PiTunnelMetrics();
    const overflow = vi.fn();
    const queue = new OpaqueForwardQueue(target, {
      highWaterBytes: 64,
      absoluteBytes: 400,
      maxQueuedFrames: 16,
      metrics,
      onOverflow: overflow,
      drainIntervalMs: 10_000,
    });

    expect(queue.forward(Buffer.alloc(40, 1))).toBe(true);
    expect(queue.forward(Buffer.alloc(40, 2))).toBe(true);
    expect(queue.forward(Buffer.alloc(50, 3))).toBe(false);
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    expect(metrics.snapshot().opaque_bytes_forwarded).toBe(0);
    queue.clear();
  });

  test("drops a queued drain when the target is no longer open without timer spin", () => {
    vi.useFakeTimers();
    try {
      const target = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 100,
        send: vi.fn(),
      } as unknown as WebSocket;
      const queue = new OpaqueForwardQueue(target, {
        highWaterBytes: 64,
        absoluteBytes: 220,
        maxQueuedFrames: 16,
        metrics: new PiTunnelMetrics(),
        onOverflow: vi.fn(),
        drainIntervalMs: 5,
      });
      expect(queue.forward(Buffer.alloc(40))).toBe(true);
      Object.assign(target, { readyState: WebSocket.CLOSING });
      vi.advanceTimersByTime(5);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds empty and tiny frames by queue cardinality and fixed frame accounting", () => {
    const overflow = vi.fn();
    const target = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 100,
      send: vi.fn(),
    } as unknown as WebSocket;
    const queue = new OpaqueForwardQueue(target, {
      highWaterBytes: 64,
      absoluteBytes: 10_000,
      maxQueuedFrames: 4,
      metrics: new PiTunnelMetrics(),
      onOverflow: overflow,
      drainIntervalMs: 10_000,
    });

    for (let index = 0; index < 4; index += 1) expect(queue.forward(Buffer.alloc(index % 2))).toBe(true);
    expect(queue.forward(Buffer.alloc(0))).toBe(false);
    expect(overflow).toHaveBeenCalledTimes(1);
    queue.clear();
  });
});
