import { EventEmitter } from "node:events";
import { pipeReadableStreamToWritable, streamToSse, type ProviderStreamEvent } from "@frely/gateway-core";

class ControlledWritable extends EventEmitter {
  readonly chunks: Uint8Array[] = [];
  writableEnded = false;
  destroyed = false;
  #writeResults: boolean[];

  constructor(writeResults: boolean[] = []) {
    super();
    this.#writeResults = [...writeResults];
  }

  write(chunk: Uint8Array): boolean {
    this.chunks.push(chunk);
    return this.#writeResults.shift() ?? true;
  }
}

function controlledEvents(events: ProviderStreamEvent[]) {
  let nextCalls = 0;
  let returnCalls = 0;
  let index = 0;
  const iterator: AsyncIterator<ProviderStreamEvent> = {
    async next() {
      nextCalls += 1;
      const event = events[index++];
      return event === undefined ? { done: true, value: undefined } : { done: false, value: event };
    },
    async return() {
      returnCalls += 1;
      return { done: true, value: undefined };
    }
  };
  const iterable: AsyncIterable<ProviderStreamEvent> = {
    [Symbol.asyncIterator]() {
      return iterator;
    }
  };
  return {
    iterable,
    nextCalls: () => nextCalls,
    returnCalls: () => returnCalls
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not reached");
}

describe("gateway streaming backpressure", () => {
  test("pulls provider events only when downstream requests data", async () => {
    const source = controlledEvents([
      { type: "chunk", data: { delta: "one" } },
      { type: "chunk", data: { delta: "two" } }
    ]);
    const reader = streamToSse(source.iterable).getReader();

    await Promise.resolve();
    expect(source.nextCalls()).toBe(0);

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("one");
    expect(source.nextCalls()).toBe(1);

    await Promise.resolve();
    expect(source.nextCalls()).toBe(1);
    await reader.cancel("client stopped");
    expect(source.returnCalls()).toBe(1);
  });

  test("cancelling the SSE reader closes the provider iterator exactly once", async () => {
    const source = controlledEvents([{ type: "chunk", data: { delta: "one" } }]);
    const reader = streamToSse(source.iterable).getReader();
    await reader.read();

    await reader.cancel(new Error("cancelled"));
    await reader.cancel(new Error("cancelled again"));

    expect(source.nextCalls()).toBe(1);
    expect(source.returnCalls()).toBe(1);
  });

  test("waits for drain before reading the next provider event", async () => {
    const source = controlledEvents([
      { type: "chunk", data: { delta: "one" } },
      { type: "chunk", data: { delta: "two" } }
    ]);
    const writable = new ControlledWritable([false, true]);
    const piping = pipeReadableStreamToWritable(streamToSse(source.iterable), writable);

    await until(() => writable.chunks.length === 1);
    expect(source.nextCalls()).toBe(1);
    await Promise.resolve();
    expect(source.nextCalls()).toBe(1);

    writable.emit("drain");
    await piping;

    expect(writable.chunks).toHaveLength(2);
    expect(source.nextCalls()).toBe(3);
    expect(source.returnCalls()).toBe(0);
  });

  test("a slow client disconnect cancels the reader, provider iterator, and request", async () => {
    const source = controlledEvents([
      { type: "chunk", data: { delta: "one" } },
      { type: "chunk", data: { delta: "two" } }
    ]);
    const writable = new ControlledWritable([false]);
    const abortController = new AbortController();
    const piping = pipeReadableStreamToWritable(streamToSse(source.iterable), writable, {
      signal: abortController.signal,
      onCancel: () => abortController.abort()
    });

    await until(() => writable.chunks.length === 1);
    writable.emit("close");

    await expect(piping).rejects.toThrow("Downstream connection closed");
    expect(abortController.signal.aborted).toBe(true);
    expect(source.nextCalls()).toBe(1);
    expect(source.returnCalls()).toBe(1);
  });

  test("abort while waiting for drain cancels the provider iterator", async () => {
    const source = controlledEvents([
      { type: "chunk", data: { delta: "one" } },
      { type: "chunk", data: { delta: "two" } }
    ]);
    const writable = new ControlledWritable([false]);
    const abortController = new AbortController();
    const piping = pipeReadableStreamToWritable(streamToSse(source.iterable), writable, {
      signal: abortController.signal
    });

    await until(() => writable.chunks.length === 1);
    abortController.abort(new Error("request aborted"));

    await expect(piping).rejects.toThrow("request aborted");
    expect(source.returnCalls()).toBe(1);
  });

  test("normal terminal completion neither cancels the request nor returns the iterator", async () => {
    const source = controlledEvents([
      { type: "chunk", data: { delta: "one" } },
      { type: "done" }
    ]);
    const writable = new ControlledWritable();
    const abortController = new AbortController();
    let cancellations = 0;

    await pipeReadableStreamToWritable(streamToSse(source.iterable), writable, {
      signal: abortController.signal,
      onCancel: () => {
        cancellations += 1;
        abortController.abort();
      }
    });

    expect(new TextDecoder().decode(Buffer.concat(writable.chunks))).toContain("data: [DONE]");
    expect(cancellations).toBe(0);
    expect(abortController.signal.aborted).toBe(false);
    expect(source.returnCalls()).toBe(0);
  });
});

describe("gateway streaming liveness frames", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("emits repeated heartbeats without starting concurrent provider reads", async () => {
    vi.useFakeTimers();
    let resolveNext!: (result: IteratorResult<ProviderStreamEvent>) => void;
    const pending = new Promise<IteratorResult<ProviderStreamEvent>>((resolve) => {
      resolveNext = resolve;
    });
    const iterator = {
      next: vi.fn(() => pending),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const reader = streamToSse({
      [Symbol.asyncIterator]: () => iterator,
    }, { heartbeatIntervalMs: 100 }).getReader();

    const firstRead = reader.read();
    await vi.advanceTimersByTimeAsync(100);
    expect(new TextDecoder().decode((await firstRead).value)).toBe(": keepalive\n\n");
    expect(iterator.next).toHaveBeenCalledTimes(1);

    const secondRead = reader.read();
    await vi.advanceTimersByTimeAsync(100);
    expect(new TextDecoder().decode((await secondRead).value)).toBe(": keepalive\n\n");
    expect(iterator.next).toHaveBeenCalledTimes(1);

    const providerRead = reader.read();
    resolveNext({ done: false, value: { type: "chunk", data: { delta: "provider" } } });
    expect(new TextDecoder().decode((await providerRead).value)).toContain("provider");
    expect(iterator.next).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(iterator.return).toHaveBeenCalledTimes(1);
  });

  test("hidden usage events do not postpone the public heartbeat deadline", async () => {
    vi.useFakeTimers();
    let nextCalls = 0;
    const iterator = {
      next: vi.fn(() => new Promise<IteratorResult<ProviderStreamEvent>>((resolve) => {
        nextCalls += 1;
        setTimeout(() => resolve({
          done: false,
          value: {
            type: "usage",
            usage: { inputTokens: nextCalls, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: nextCalls, source: "provider" },
          },
        }), 40);
      })),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const reader = streamToSse({
      [Symbol.asyncIterator]: () => iterator,
    }, { heartbeatIntervalMs: 100 }).getReader();

    const firstRead = reader.read();
    await vi.advanceTimersByTimeAsync(100);
    expect(new TextDecoder().decode((await firstRead).value)).toBe(": keepalive\n\n");
    expect(iterator.next).toHaveBeenCalledTimes(3);
    await reader.cancel();
  });

  test("emits the initial heartbeat before pulling the provider stream", async () => {
    const source = controlledEvents([{ type: "chunk", data: { delta: "one" } }]);
    const reader = streamToSse(source.iterable, { initialHeartbeat: true, heartbeatIntervalMs: 100 }).getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n");
    expect(source.nextCalls()).toBe(0);

    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("one");
    expect(source.nextCalls()).toBe(1);
    await reader.cancel();
  });

  test("cancelling while a heartbeat waits closes the provider iterator and timer", async () => {
    vi.useFakeTimers();
    const iterator = {
      next: vi.fn(() => new Promise<IteratorResult<ProviderStreamEvent>>(() => undefined)),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const reader = streamToSse({
      [Symbol.asyncIterator]: () => iterator,
    }, { heartbeatIntervalMs: 100 }).getReader();

    const pendingRead = reader.read();
    await Promise.resolve();
    expect(iterator.next).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await reader.cancel("client stopped");
    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not emit heartbeat comments after a terminal public frame", async () => {
    vi.useFakeTimers();
    let resolveFinal!: (result: IteratorResult<ProviderStreamEvent>) => void;
    const final = new Promise<IteratorResult<ProviderStreamEvent>>((resolve) => {
      resolveFinal = resolve;
    });
    let nextCalls = 0;
    const iterator = {
      next: vi.fn(() => {
        nextCalls += 1;
        if (nextCalls === 1) {
          return Promise.resolve({
            done: false as const,
            value: { type: "error" as const, code: "provider_error", message: "failed", retryable: true },
          });
        }
        return final;
      }),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const reader = streamToSse({
      [Symbol.asyncIterator]: () => iterator,
    }, { heartbeatIntervalMs: 100 }).getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: error");
    const completion = reader.read();
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(0);
    resolveFinal({ done: true, value: undefined });
    await expect(completion).resolves.toEqual({ done: true, value: undefined });
  });
});
