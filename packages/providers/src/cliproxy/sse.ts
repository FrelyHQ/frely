import { cliProxyProtocolError, cliProxyStreamError } from "./errors.js";
import { StreamingJsonValueParser } from "./streaming-json.js";

export const DEFAULT_CLIPROXY_SSE_LIMITS = Object.freeze({
  maxQueueFrames: 128
});
export const DEFAULT_CLIPROXY_SSE_RAW_BYTE_WORK_QUANTUM = 2 * 1024 * 1024;

export interface CliProxySseLimits {
  /** @deprecated Retained as the complete-frame event-loop work quantum. */
  maxQueueFrames: number;
}

export type CliProxySseEvent =
  | { type: "event"; event?: string; data: unknown; dataBytes: number }
  | { type: "done" };

export interface ParseCliProxySseOptions {
  signal?: AbortSignal;
  limits?: Partial<CliProxySseLimits>;
  onBytes?: (byteLength: number) => void;
}

export async function* parseCliProxySse(
  stream: ReadableStream<Uint8Array>,
  options: ParseCliProxySseOptions = {}
): AsyncIterable<CliProxySseEvent> {
  const limits = validatedLimits(options.limits);
  const reader = stream.getReader();
  const scanner = new SseSemanticScanner();
  let framesSinceYield = 0;
  let bytesSinceYield = 0;
  let eventsReceived = 0;
  let readerCancelPromise: Promise<void> | undefined;
  const cancelReader = async (reason?: unknown) => {
    readerCancelPromise ??= reader.cancel(reason).catch(() => undefined);
    await readerCancelPromise;
  };
  const yieldForWorkQuantum = async () => {
    await eventLoopTurn();
    framesSinceYield = 0;
    bytesSinceYield = 0;
    if (options.signal?.aborted) throw cliProxyStreamError(options.signal.reason, eventsReceived, options.signal);
  };
  try {
    while (true) {
      if (options.signal?.aborted) throw cliProxyStreamError(options.signal.reason, eventsReceived, options.signal);
      const next = await readWithSignal(reader, options.signal, eventsReceived, cancelReader);
      if (next.done) {
        const event = scanner.finish();
        if (event) {
          if (event.type === "event") eventsReceived += 1;
          yield event;
        }
        break;
      }
      if (next.value.byteLength > 0) options.onBytes?.(next.value.byteLength);
      for (const byte of next.value) {
        const complete = scanner.push(byte);
        bytesSinceYield += 1;
        if (complete) {
          framesSinceYield += 1;
          const { event } = complete;
          if (event) {
            if (event.type === "event") eventsReceived += 1;
            framesSinceYield = 0;
            bytesSinceYield = 0;
            yield event;
          } else if (framesSinceYield >= limits.maxQueueFrames || bytesSinceYield >= DEFAULT_CLIPROXY_SSE_RAW_BYTE_WORK_QUANTUM) {
            await yieldForWorkQuantum();
          }
        } else if (bytesSinceYield >= DEFAULT_CLIPROXY_SSE_RAW_BYTE_WORK_QUANTUM) {
          await yieldForWorkQuantum();
        }
      }
    }
  } catch (error) {
    await cancelReader(error);
    throw cliProxyStreamError(error, eventsReceived, options.signal);
  } finally {
    await cancelReader();
    reader.releaseLock();
  }
}

function validatedLimits(input: Partial<CliProxySseLimits> | undefined): CliProxySseLimits {
  const limits = { ...DEFAULT_CLIPROXY_SSE_LIMITS, ...input };
  if (!Number.isSafeInteger(limits.maxQueueFrames) || limits.maxQueueFrames <= 0) {
    throw cliProxyProtocolError("CLIProxyAPI SSE limits are invalid");
  }
  return limits;
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  eventsReceived: number,
  cancelReader: (reason?: unknown) => Promise<void>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw cliProxyStreamError(signal.reason, eventsReceived, signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const error = cliProxyStreamError(signal.reason, eventsReceived, signal);
      void cancelReader(error);
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

interface CompletedSseFrame {
  event: CliProxySseEvent | null;
}

const ASCII_CR = 13;
const ASCII_LF = 10;
const ASCII_COLON = 58;
const ASCII_SPACE = 32;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

class SseSemanticScanner {
  private frame = new SseFrameBuilder();
  private readonly line = new SseLine();
  private lineHasBytes = false;
  private pendingCr = false;
  private bomResolved = false;
  private readonly bomPending: number[] = [];

  push(byte: number): CompletedSseFrame | null {
    if (!this.bomResolved) return this.pushInitialByte(byte);
    return this.pushResolvedByte(byte);
  }

  finish(): CliProxySseEvent | null {
    if (!this.bomResolved) {
      this.bomResolved = true;
      for (const byte of this.bomPending) this.pushResolvedByte(byte);
      this.bomPending.length = 0;
    }
    if (this.pendingCr) {
      this.pendingCr = false;
      const completed = this.finishLine();
      if (completed?.event) return completed.event;
    }
    if (this.lineHasBytes) {
      this.line.finish(this.frame);
      this.line.reset();
      this.lineHasBytes = false;
    }
    return this.finishFrame();
  }

  private pushInitialByte(byte: number): CompletedSseFrame | null {
    const expected = UTF8_BOM[this.bomPending.length];
    if (byte === expected) {
      this.bomPending.push(byte);
      if (this.bomPending.length === UTF8_BOM.length) {
        this.bomResolved = true;
        this.bomPending.length = 0;
      }
      return null;
    }
    this.bomResolved = true;
    let complete: CompletedSseFrame | null = null;
    for (const pending of this.bomPending) complete ??= this.pushResolvedByte(pending);
    this.bomPending.length = 0;
    return complete ?? this.pushResolvedByte(byte);
  }

  private pushResolvedByte(byte: number): CompletedSseFrame | null {
    if (this.pendingCr) {
      this.pendingCr = false;
      if (byte === ASCII_LF) return this.finishLine();
      const completed = this.finishLine();
      if (byte === ASCII_CR) {
        this.pendingCr = true;
      } else if (byte === ASCII_LF) {
        return completed ?? this.finishLine();
      } else {
        this.lineHasBytes = true;
        this.line.push(byte, this.frame);
      }
      return completed;
    }
    if (byte === ASCII_CR) {
      this.pendingCr = true;
      return null;
    }
    if (byte === ASCII_LF) return this.finishLine();
    this.lineHasBytes = true;
    this.line.push(byte, this.frame);
    return null;
  }

  private finishLine(): CompletedSseFrame | null {
    if (!this.lineHasBytes) return { event: this.finishFrame() };
    this.line.finish(this.frame);
    this.line.reset();
    this.lineHasBytes = false;
    return null;
  }

  private finishFrame(): CliProxySseEvent | null {
    const frame = this.frame;
    this.frame = new SseFrameBuilder();
    return frame.finish();
  }
}

type SseLineMode = "field" | "ignore" | "data-space" | "data" | "event-space" | "event";

class SseLine {
  private mode: SseLineMode = "field";
  private readonly field: number[] = [];
  private eventValue: Utf8StringAccumulator | undefined;

  push(byte: number, frame: SseFrameBuilder): void {
    if (this.mode === "ignore") return;
    if (this.mode === "data-space") {
      this.mode = "data";
      if (byte !== ASCII_SPACE) frame.pushDataByte(byte);
      return;
    }
    if (this.mode === "data") {
      frame.pushDataByte(byte);
      return;
    }
    if (this.mode === "event-space") {
      this.mode = "event";
      if (byte !== ASCII_SPACE) this.eventValue?.push(byte);
      return;
    }
    if (this.mode === "event") {
      this.eventValue?.push(byte);
      return;
    }
    if (this.field.length === 0 && byte === ASCII_COLON) {
      this.mode = "ignore";
      return;
    }
    if (byte === ASCII_COLON) {
      this.startKnownField(frame);
      return;
    }
    if (this.field.length >= 5) {
      this.mode = "ignore";
      return;
    }
    this.field.push(byte);
  }

  finish(frame: SseFrameBuilder): void {
    if (this.mode === "field") this.startKnownField(frame);
    if (this.mode === "event-space" || this.mode === "event") {
      frame.setEventName(this.eventValue?.finish() ?? "");
    }
  }

  reset(): void {
    this.mode = "field";
    this.field.length = 0;
    this.eventValue = undefined;
  }

  private startKnownField(frame: SseFrameBuilder): void {
    const field = String.fromCharCode(...this.field);
    if (field === "data") {
      frame.startDataLine();
      this.mode = "data-space";
      return;
    }
    if (field === "event") {
      this.eventValue = new Utf8StringAccumulator();
      this.mode = "event-space";
      return;
    }
    this.mode = "ignore";
  }
}

class SseFrameBuilder {
  private data: SseJsonData | undefined;
  private eventName: string | undefined;

  startDataLine(): void {
    this.data ??= new SseJsonData();
    this.data.startLine();
  }

  pushDataByte(byte: number): void {
    this.data?.push(byte);
  }

  setEventName(value: string): void {
    this.eventName = value;
  }

  finish(): CliProxySseEvent | null {
    if (!this.data) return null;
    try {
      const result = this.data.finish();
      if (result.type === "done") return result;
      return {
        type: "event",
        ...(this.eventName ? { event: this.eventName } : {}),
        data: result.value,
        dataBytes: result.dataBytes
      };
    } catch {
      throw cliProxyProtocolError("CLIProxyAPI SSE event contained invalid JSON");
    }
  }
}

const DONE_BYTES = new TextEncoder().encode("[DONE]");

class SseJsonData {
  private mode: "leading" | "candidate" | "trailing" | "json" = "leading";
  private candidateLength = 0;
  private discardedWhitespaceBytes = 0;
  private lineCount = 0;
  private sink: JsonByteSink | undefined;

  startLine(): void {
    if (this.lineCount > 0) this.push(ASCII_LF);
    this.lineCount += 1;
  }

  push(byte: number): void {
    if (this.mode === "json") {
      this.sink?.push(byte);
      return;
    }
    if (this.mode === "leading") {
      if (isJsonWhitespace(byte)) {
        this.discardedWhitespaceBytes += 1;
        return;
      }
      if (byte === DONE_BYTES[0]) {
        this.mode = "candidate";
        this.candidateLength = 1;
        return;
      }
      this.startJson([byte]);
      return;
    }
    if (this.mode === "candidate") {
      if (byte === DONE_BYTES[this.candidateLength]) {
        this.candidateLength += 1;
        if (this.candidateLength === DONE_BYTES.length) this.mode = "trailing";
        return;
      }
      this.startJson([...DONE_BYTES.subarray(0, this.candidateLength), byte]);
      return;
    }
    if (isJsonWhitespace(byte)) {
      this.discardedWhitespaceBytes += 1;
      return;
    }
    this.startJson([...DONE_BYTES, byte]);
  }

  finish(): { type: "done" } | { type: "event"; value: unknown; dataBytes: number } {
    if (this.mode === "trailing") return { type: "done" };
    if (this.mode === "candidate") {
      this.startJson(DONE_BYTES.subarray(0, this.candidateLength));
    }
    if (!this.sink) throw new Error("SSE data was empty");
    const parsed = this.sink.finish();
    if (!parsed.hasValue) throw new Error("SSE data was empty");
    return {
      type: "event",
      value: parsed.value,
      dataBytes: parsed.decodedByteLength + this.discardedWhitespaceBytes
    };
  }

  private startJson(bytes: Iterable<number>): void {
    this.mode = "json";
    this.sink = new JsonByteSink();
    for (const byte of bytes) this.sink.push(byte);
  }
}

class JsonByteSink {
  private readonly parser = new StreamingJsonValueParser({ stripLeadingBom: false });
  private readonly bytes = new Uint8Array(64 * 1024);
  private length = 0;

  push(byte: number): void {
    this.bytes[this.length] = byte;
    this.length += 1;
    if (this.length === this.bytes.byteLength) this.flush();
  }

  finish(): ReturnType<StreamingJsonValueParser["finish"]> {
    this.flush();
    return this.parser.finish();
  }

  private flush(): void {
    if (this.length === 0) return;
    this.parser.write(this.bytes.subarray(0, this.length));
    this.length = 0;
  }
}

class Utf8StringAccumulator {
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  private readonly bytes = new Uint8Array(4096);
  private readonly chunks: string[] = [];
  private length = 0;

  push(byte: number): void {
    this.bytes[this.length] = byte;
    this.length += 1;
    if (this.length === this.bytes.byteLength) this.flush();
  }

  finish(): string {
    this.flush();
    this.chunks.push(this.decoder.decode());
    return this.chunks.join("");
  }

  private flush(): void {
    if (this.length === 0) return;
    this.chunks.push(this.decoder.decode(this.bytes.subarray(0, this.length), { stream: true }));
    this.length = 0;
  }
}

function isJsonWhitespace(byte: number): boolean {
  return byte === ASCII_SPACE || byte === ASCII_LF || byte === ASCII_CR || byte === 9;
}

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
