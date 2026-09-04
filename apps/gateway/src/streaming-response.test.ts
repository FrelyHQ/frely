import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProviderAdapterResponse, ProviderStreamEvent } from "@frely/gateway-core";
import { createStreamingGatewayResponse } from "./streaming-response.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function* providerEvents(events: readonly ProviderStreamEvent[]): AsyncIterable<ProviderStreamEvent> {
  for (const event of events) yield event;
}

describe("Gateway streaming response liveness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("preserves an HTTP error that settles before the stream grace period", async () => {
    vi.useFakeTimers();
    const onProviderResponse = vi.fn();
    const response = await createStreamingGatewayResponse(Promise.resolve({
      status: 429,
      headers: { "retry-after": "1" },
      body: { error: { code: "rate_limited", message: "Retry later" } },
    }), {
      requestId: "req_early",
      graceMs: 100,
      heartbeatIntervalMs: 50,
      onProviderResponse,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: { code: "rate_limited", message: "Retry later" } });
    expect(onProviderResponse).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("sends an initial heartbeat when a settled Provider stream delays its first event", async () => {
    vi.useFakeTimers();
    const streamReady = deferred<undefined>();
    const response = await createStreamingGatewayResponse(Promise.resolve({
      status: 200,
      headers: {},
      stream: (async function* (): AsyncIterable<ProviderStreamEvent> {
        await streamReady.promise;
        yield { type: "chunk", data: { delta: "ready" } };
        yield { type: "done" };
      })(),
    }), {
      requestId: "req_early_stream",
      graceMs: 100,
      heartbeatIntervalMs: 50,
    });

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keepalive\n\n");
    const eventRead = reader.read();
    streamReady.resolve(undefined);
    expect(new TextDecoder().decode((await eventRead).value)).toContain("ready");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: [DONE]\n\n");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  test("commits SSE after the grace period and forwards the delayed provider stream", async () => {
    vi.useFakeTimers();
    const invocation = deferred<ProviderAdapterResponse>();
    const onProviderResponse = vi.fn();
    const responsePromise = createStreamingGatewayResponse(invocation.promise, {
      requestId: "req_delayed",
      graceMs: 100,
      heartbeatIntervalMs: 50,
      onProviderResponse,
    });

    await vi.advanceTimersByTimeAsync(100);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");

    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keepalive\n\n");
    invocation.resolve({
      status: 200,
      headers: {},
      stream: providerEvents([
        { type: "chunk", data: { delta: "ready" } },
        { type: "done" },
      ]),
    });

    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: [DONE]\n\n");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(onProviderResponse).toHaveBeenCalledTimes(1);
  });

  test("converts a delayed non-stream Provider failure into a safe SSE error", async () => {
    vi.useFakeTimers();
    const invocation = deferred<ProviderAdapterResponse>();
    const onErrorCode = vi.fn();
    const responsePromise = createStreamingGatewayResponse(invocation.promise, {
      requestId: "req_late_error",
      graceMs: 100,
      heartbeatIntervalMs: 50,
      onErrorCode,
    });

    await vi.advanceTimersByTimeAsync(100);
    const reader = (await responsePromise).body!.getReader();
    await reader.read();
    invocation.resolve({
      status: 503,
      body: { error: { code: "provider_unavailable", message: "prompt-secret-sentinel" } },
    });

    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toContain("event: error");
    expect(frame).toContain("provider_unavailable");
    expect(frame).toContain("Provider request failed");
    expect(frame).not.toContain("prompt-secret-sentinel");
    expect(onErrorCode).toHaveBeenCalledWith("provider_unavailable");
  });

  test("sanitizes an unknown invocation rejection after SSE has committed", async () => {
    vi.useFakeTimers();
    const invocation = deferred<ProviderAdapterResponse>();
    const onErrorCode = vi.fn();
    const responsePromise = createStreamingGatewayResponse(invocation.promise, {
      requestId: "req_late_rejection",
      graceMs: 100,
      heartbeatIntervalMs: 50,
      onErrorCode,
    });

    await vi.advanceTimersByTimeAsync(100);
    const reader = (await responsePromise).body!.getReader();
    await reader.read();
    invocation.reject(new Error("authorization prompt-secret-sentinel"));

    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toContain("internal_error");
    expect(frame).toContain("Unexpected error");
    expect(frame).not.toContain("prompt-secret-sentinel");
    expect(onErrorCode).toHaveBeenCalledWith("internal_error");
  });

  test("aborts promptly and clears the grace timer before response commit", async () => {
    vi.useFakeTimers();
    const invocation = deferred<ProviderAdapterResponse>();
    const abortController = new AbortController();
    const response = createStreamingGatewayResponse(invocation.promise, {
      requestId: "req_aborted",
      signal: abortController.signal,
      graceMs: 100,
      heartbeatIntervalMs: 50,
    });

    abortController.abort();
    await expect(response).rejects.toMatchObject({ code: "request_aborted", status: 499 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
