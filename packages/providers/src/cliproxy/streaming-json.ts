import * as streamJsonParserModule from "stream-json/core/parser.js";

type JsonToken =
  | { name: "startObject" | "endObject" | "startArray" | "endArray" }
  | { name: "keyValue"; value: string }
  | { name: "stringValue"; value: string }
  | { name: "numberValue"; value: string }
  | { name: "nullValue"; value: null }
  | { name: "trueValue"; value: true }
  | { name: "falseValue"; value: false };

type JsonTokenizer = (value: string | symbol) => unknown;

const NO_TOKENIZER_INPUT = Symbol.for("object-stream.none");
const createJsonTokenizer = (
  streamJsonParserModule as unknown as {
    jsonParser(options: {
      packValues: boolean;
      streamValues: boolean;
      jsonStreaming: boolean;
    }): JsonTokenizer;
  }
).jsonParser;

type ObjectState = "key-or-end" | "key" | "colon" | "value" | "comma-or-end";
type ArrayState = "value-or-end" | "value" | "comma-or-end";

interface ObjectFrame {
  kind: "object";
  value: Record<string, unknown>;
  state: ObjectState;
  key: string | undefined;
}

interface ArrayFrame {
  kind: "array";
  value: unknown[];
  state: ArrayState;
}

type ContainerFrame = ObjectFrame | ArrayFrame;

export interface StreamingJsonResult {
  hasValue: boolean;
  value?: unknown;
  decodedByteLength: number;
}

/**
 * Incrementally decodes and assembles one JSON value without retaining the raw
 * response text. Property definition deliberately matches JSON.parse for keys
 * such as "__proto__" instead of invoking Object.prototype setters.
 */
export class StreamingJsonValueParser {
  private readonly decoder: TextDecoder;
  private readonly encoder = new TextEncoder();
  private readonly tokenizer = createJsonTokenizer({
    packValues: true,
    streamValues: false,
    jsonStreaming: false
  });
  private readonly stack: ContainerFrame[] = [];
  private root: unknown;
  private rootAssigned = false;
  private rootComplete = false;
  private ended = false;
  private decodedBytes = 0;

  constructor(options: { stripLeadingBom?: boolean } = {}) {
    this.decoder = new TextDecoder("utf-8", { ignoreBOM: options.stripLeadingBom === false });
  }

  get decodedByteLength(): number {
    return this.decodedBytes;
  }

  write(bytes: Uint8Array | string): void {
    if (this.ended) throw new Error("JSON parser already ended");
    const decoded = typeof bytes === "string"
      ? bytes
      : this.decoder.decode(bytes, { stream: true });
    this.writeDecoded(decoded);
  }

  finish(): StreamingJsonResult {
    if (this.ended) throw new Error("JSON parser already ended");
    this.ended = true;
    this.writeDecoded(this.decoder.decode());
    this.consumeOutput(this.tokenizer(NO_TOKENIZER_INPUT));
    if (this.stack.length > 0 || (this.rootAssigned && !this.rootComplete)) {
      throw new Error("JSON parser ended before the root value completed");
    }
    return {
      hasValue: this.rootComplete,
      ...(this.rootComplete ? { value: this.root } : {}),
      decodedByteLength: this.decodedBytes
    };
  }

  private writeDecoded(decoded: string): void {
    if (!decoded) return;
    this.decodedBytes += this.encoder.encode(decoded).byteLength;
    this.consumeOutput(this.tokenizer(decoded));
  }

  private consumeOutput(output: unknown): void {
    if (output === NO_TOKENIZER_INPUT) return;
    if (!isTokenBatch(output)) throw new Error("JSON tokenizer returned an invalid token batch");
    for (const token of output.values) this.consume(token);
  }

  private consume(token: JsonToken): void {
    const frame = this.stack.at(-1);
    if (frame?.kind === "object") {
      this.consumeObject(frame, token);
      return;
    }
    if (frame?.kind === "array") {
      this.consumeArray(frame, token);
      return;
    }
    if (this.rootComplete || this.rootAssigned) this.unexpected(token.name);
    this.consumeValue(token);
  }

  private consumeObject(frame: ObjectFrame, token: JsonToken): void {
    if (frame.state === "key-or-end" || frame.state === "key") {
      if (token.name === "endObject" && frame.state === "key-or-end") {
        this.closeContainer();
        return;
      }
      if (token.name === "keyValue") {
        frame.key = token.value;
        frame.state = "colon";
        return;
      }
      this.unexpected(token.name);
    }
    if (frame.state === "colon") {
      frame.state = "value";
      this.consumeValue(token);
      return;
    }
    if (frame.state === "value") {
      this.consumeValue(token);
      return;
    }
    if (frame.state === "comma-or-end") {
      if (token.name === "keyValue") {
        frame.state = "key";
        frame.key = token.value;
        frame.state = "colon";
        return;
      }
      if (token.name === "endObject") {
        this.closeContainer();
        return;
      }
      this.unexpected(token.name);
    }
  }

  private consumeArray(frame: ArrayFrame, token: JsonToken): void {
    if (frame.state === "value-or-end") {
      if (token.name === "endArray") {
        this.closeContainer();
        return;
      }
      this.consumeValue(token);
      return;
    }
    if (frame.state === "value") {
      this.consumeValue(token);
      return;
    }
    if (frame.state === "comma-or-end") {
      if (token.name === "endArray") {
        this.closeContainer();
        return;
      }
      frame.state = "value";
      this.consumeValue(token);
    }
  }

  private consumeValue(token: JsonToken): void {
    if (isPrimitiveToken(token)) {
      const value = token.name === "numberValue" ? Number(token.value) : token.value;
      this.attachValue(value);
      if (this.stack.length === 0) this.rootComplete = true;
      return;
    }
    if (token.name === "startObject") {
      const object: Record<string, unknown> = {};
      this.attachValue(object);
      this.stack.push({ kind: "object", value: object, state: "key-or-end", key: undefined });
      return;
    }
    if (token.name === "startArray") {
      const array: unknown[] = [];
      this.attachValue(array);
      this.stack.push({ kind: "array", value: array, state: "value-or-end" });
      return;
    }
    this.unexpected(token.name);
  }

  private attachValue(value: unknown): void {
    const parent = this.stack.at(-1);
    if (!parent) {
      if (this.rootAssigned) throw new Error("JSON contained more than one root value");
      this.root = value;
      this.rootAssigned = true;
      return;
    }
    if (parent.kind === "array") {
      if (parent.state !== "value" && parent.state !== "value-or-end") {
        throw new Error("JSON array was not expecting a value");
      }
      parent.value.push(value);
      parent.state = "comma-or-end";
      return;
    }
    if (parent.state !== "value" || parent.key === undefined) {
      throw new Error("JSON object was not expecting a value");
    }
    Object.defineProperty(parent.value, parent.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    });
    parent.state = "comma-or-end";
  }

  private closeContainer(): void {
    this.stack.pop();
    if (this.stack.length === 0) this.rootComplete = true;
  }

  private unexpected(token: JsonToken["name"]): never {
    throw new Error(`Unexpected JSON token ${token}`);
  }
}

function isPrimitiveToken(
  token: JsonToken
): token is Extract<JsonToken, { name: "stringValue" | "numberValue" | "nullValue" | "trueValue" | "falseValue" }> {
  return token.name === "stringValue"
    || token.name === "numberValue"
    || token.name === "trueValue"
    || token.name === "falseValue"
    || token.name === "nullValue";
}

function isTokenBatch(output: unknown): output is { values: JsonToken[] } {
  return typeof output === "object"
    && output !== null
    && Array.isArray((output as { values?: unknown }).values);
}
