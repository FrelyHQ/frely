import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const span = {
    end: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
  };
  return {
    span,
    options: [] as Array<Record<string, unknown>>,
    extractedHeaders: [] as Headers[],
  };
});

vi.mock("@opentelemetry/api", () => ({
  SpanKind: { SERVER: 1 },
  SpanStatusCode: { ERROR: 2 },
  context: {
    active: () => ({ root: true }),
    with: (_context: unknown, work: () => unknown) => work(),
  },
  propagation: {
    extract: (context: unknown, carrier: Headers) => {
      mocks.extractedHeaders.push(carrier);
      return context;
    },
  },
  metrics: { getMeter: vi.fn() },
  trace: {
    getTracer: () => ({
      startActiveSpan: (_name: string, options: Record<string, unknown>, work: (span: typeof mocks.span) => unknown) => {
        mocks.options.push(options);
        return work(mocks.span);
      },
    }),
  },
}));

import { recordRepositoryOperation, traceHttpRequest } from "./server";

beforeEach(() => {
  mocks.span.end.mockClear();
  mocks.span.setAttribute.mockClear();
  mocks.span.setStatus.mockClear();
  mocks.options.length = 0;
  mocks.extractedHeaders.length = 0;
});

describe("server span lifecycle", () => {
  test("ends repository spans only after an asynchronous operation settles", async () => {
    let resolveOperation: ((value: string) => void) | undefined;
    const operation = new Promise<string>((resolve) => { resolveOperation = resolve; });

    const result = recordRepositoryOperation("queries.teams.pageDirectory", () => operation, {
      pageSize: 20,
      itemsReturned: 3,
    });
    expect(mocks.span.end).not.toHaveBeenCalled();

    resolveOperation?.("done");
    await expect(result).resolves.toBe("done");
    expect(mocks.span.setAttribute).toHaveBeenCalledWith("terminal", "success");
    expect(mocks.span.setAttribute).toHaveBeenCalledWith("friday.collection.items_returned", 3);
    expect(mocks.span.end).toHaveBeenCalledTimes(1);
  });

  test("extracts propagation while keeping HTTP span attributes bounded", async () => {
    const request = new Request("https://admin.test/owner/teams?secret=value", {
      headers: {
        authorization: "Bearer secret",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
    });

    const response = await traceHttpRequest(request, async () => new Response(null, { status: 204 }));

    expect(response.status).toBe(204);
    expect(mocks.options[0]).toEqual({
      kind: 1,
      attributes: { "http.request.method": "GET" },
    });
    expect(JSON.stringify(mocks.options[0])).not.toContain("secret");
    expect(mocks.extractedHeaders.at(-1)).toBe(request.headers);
    expect(mocks.span.end).toHaveBeenCalledTimes(1);
  });

  test("keeps a streaming HTTP span open until the response body completes without prefetching chunks", async () => {
    const chunk = new Uint8Array([1, 2, 3]);
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(chunk);
        else controller.close();
      },
    }, { highWaterMark: 0 });

    const response = await traceHttpRequest(
      new Request("https://admin.test/stream"),
      async () => new Response(source, { headers: { "content-type": "application/octet-stream" } }),
    );

    expect(pulls).toBe(0);
    expect(mocks.span.end).not.toHaveBeenCalled();
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first).toEqual({ done: false, value: chunk });
    expect(first.value).toBe(chunk);
    expect(mocks.span.end).not.toHaveBeenCalled();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(mocks.span.setAttribute).toHaveBeenCalledWith("terminal", "success");
    expect(mocks.span.end).toHaveBeenCalledTimes(1);
  });

  test("propagates stream cancellation and ends the HTTP span once", async () => {
    const cancel = vi.fn(async () => undefined);
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const response = await traceHttpRequest(
      new Request("https://admin.test/stream"),
      async () => new Response(source),
    );

    await response.body!.cancel("client-disconnected");

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("client-disconnected");
    expect(mocks.span.setAttribute).toHaveBeenCalledWith("terminal", "cancelled");
    expect(mocks.span.end).toHaveBeenCalledTimes(1);
  });

  test("propagates response body errors and ends the HTTP span once as failed", async () => {
    const streamFailure = new Error("stream failed");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(streamFailure);
      },
    }, { highWaterMark: 0 });
    const response = await traceHttpRequest(
      new Request("https://admin.test/stream"),
      async () => new Response(source),
    );

    await expect(response.body!.getReader().read()).rejects.toBe(streamFailure);

    expect(mocks.span.setAttribute).toHaveBeenCalledWith("terminal", "failed");
    expect(mocks.span.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(mocks.span.end).toHaveBeenCalledTimes(1);
  });
});
