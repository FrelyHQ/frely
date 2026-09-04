import { createRequire } from "node:module";
import { assertCliProxyInferenceConfig, type CliProxyConfig } from "./config.js";
import { CliProxyError, cliProxyFetchError, cliProxyHttpError, cliProxyProtocolError } from "./errors.js";
import { StreamingJsonValueParser } from "./streaming-json.js";

export const CLIPROXY_REQUEST_HEADER_ALLOWLIST = ["accept", "content-type", "x-request-id", "x-friday-cpa-evidence-contract"] as const;
export const CLIPROXY_RESPONSE_HEADER_ALLOWLIST = ["content-type", "x-request-id", "retry-after"] as const;
export const CLIPROXY_ERROR_BODY_MAX_BYTES = 64 * 1024;
export const DEFAULT_CLIPROXY_STREAM_HARD_LIFETIME_MS = 30 * 60_000;
export const CLIPROXY_UNDICI_TIMEOUTS = Object.freeze({
  headersTimeout: 0,
  bodyTimeout: 0
});

type CliProxyFetch = (input: string, init: RequestInit) => Promise<Response>;

const require = createRequire(import.meta.url);
const Agent = require("undici/lib/dispatcher/agent.js") as typeof import("undici").Agent;
const undiciFetch = require("undici/lib/web/fetch/index.js").fetch as typeof import("undici").fetch;
const cliProxyDispatcher = new Agent(CLIPROXY_UNDICI_TIMEOUTS);
const defaultCliProxyFetch: CliProxyFetch = async (input, init) => (
  await undiciFetch(
    input,
    { ...init, dispatcher: cliProxyDispatcher } as unknown as NonNullable<Parameters<typeof undiciFetch>[1]>
  ) as unknown as Response
);

export interface CliProxyClientOptions {
  fetch?: typeof fetch;
  responseHeaderTimeoutMs?: number;
  nonStreamingBodyTimeoutMs?: number;
  streamHardLifetimeMs?: number;
}

export interface CliProxyRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: HeadersInit;
  requestId?: string;
}

export interface CliProxyJsonResult<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

export class CliProxyClient {
  readonly config: CliProxyConfig;
  private readonly fetchImpl: CliProxyFetch;
  private readonly responseHeaderTimeoutMs: number;
  private readonly nonStreamingBodyTimeoutMs: number;
  private readonly streamHardLifetimeMs: number;

  constructor(config: CliProxyConfig, options: CliProxyClientOptions = {}) {
    this.config = config;
    this.fetchImpl = options.fetch ?? defaultCliProxyFetch;
    this.responseHeaderTimeoutMs = validTimeout(options.responseHeaderTimeoutMs ?? config.timeoutMs);
    this.nonStreamingBodyTimeoutMs = validTimeout(options.nonStreamingBodyTimeoutMs ?? config.timeoutMs);
    this.streamHardLifetimeMs = validTimeout(options.streamHardLifetimeMs ?? DEFAULT_CLIPROXY_STREAM_HARD_LIFETIME_MS);
  }

  responses(payload: Record<string, unknown>, options: CliProxyRequestOptions = {}): Promise<Response> {
    return this.request("/v1/responses", { method: "POST", body: payload }, options);
  }

  chatCompletions(payload: Record<string, unknown>, options: CliProxyRequestOptions = {}): Promise<Response> {
    return this.request("/v1/chat/completions", { method: "POST", body: payload }, options);
  }

  messages(payload: Record<string, unknown>, options: CliProxyRequestOptions = {}): Promise<Response> {
    return this.request("/v1/messages", { method: "POST", body: payload }, options);
  }

  models(options: CliProxyRequestOptions = {}): Promise<Response> {
    return this.request("/v1/models", { method: "GET" }, options);
  }

  async responsesJson<T = unknown>(payload: Record<string, unknown>, options: CliProxyRequestOptions = {}): Promise<CliProxyJsonResult<T>> {
    return this.readJson<T>(await this.responses(payload, options));
  }

  async chatCompletionsJson<T = unknown>(payload: Record<string, unknown>, options: CliProxyRequestOptions = {}): Promise<CliProxyJsonResult<T>> {
    return this.readJson<T>(await this.chatCompletions(payload, options));
  }

  async messagesJson<T = unknown>(payload: Record<string, unknown>, options: CliProxyRequestOptions = {}): Promise<CliProxyJsonResult<T>> {
    return this.readJson<T>(await this.messages(payload, options));
  }

  async modelsJson<T = unknown>(options: CliProxyRequestOptions = {}): Promise<CliProxyJsonResult<T>> {
    return this.readJson<T>(await this.models(options));
  }

  async readJson<T = unknown>(response: Response): Promise<CliProxyJsonResult<T>> {
    try {
      assertJsonContentType(response.headers);
    } catch (error) {
      await response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
    const body = await readResponseJson(response);
    return { status: response.status, headers: safeCliProxyResponseHeaders(response.headers), body: body as T };
  }

  private async request(
    endpoint: "/v1/responses" | "/v1/chat/completions" | "/v1/messages" | "/v1/models",
    request: { method: "GET" | "POST"; body?: Record<string, unknown> },
    options: CliProxyRequestOptions
  ): Promise<Response> {
    assertCliProxyInferenceConfig(this.config);
    const requestTimeoutMs = options.timeoutMs === undefined ? undefined : validTimeout(options.timeoutMs);
    const responseHeaderTimeoutMs = requestTimeoutMs ?? this.responseHeaderTimeoutMs;
    const nonStreamingBodyTimeoutMs = requestTimeoutMs ?? this.nonStreamingBodyTimeoutMs;
    const streaming = request.body?.stream === true;
    const lifecycle = createAbortLifecycle(options.signal);
    lifecycle.setTimeout(responseHeaderTimeoutMs, new CliProxyError(
      "cliproxy_timeout",
      "CLIProxyAPI response headers timed out",
      504,
      { retryable: true, stage: "response_headers", costExposure: "accruing", finalUsageEvidence: "pending" }
    ));
    const headers = safeCliProxyRequestHeaders(options.headers);
    headers.set("accept", streaming ? "text/event-stream" : "application/json");
    if (request.body) headers.set("content-type", "application/json");
    if (options.requestId) headers.set("x-request-id", options.requestId);
    if (endpoint === "/v1/messages") {
      headers.set("x-api-key", this.config.apiKey);
      headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${this.config.apiKey}`);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${endpoint}`, {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        signal: lifecycle.signal,
        redirect: "error"
      });
    } catch (error) {
      lifecycle.dispose();
      throw cliProxyFetchError(error, lifecycle.signal);
    }
    lifecycle.setTimeout(
      streaming ? this.streamHardLifetimeMs : nonStreamingBodyTimeoutMs,
      streaming
        ? new CliProxyError(
            "cliproxy_stream_lifetime_limit",
            "CLIProxyAPI stream lifetime limit exceeded",
            504,
            { retryable: false, stage: "stream_read" }
          )
        : new CliProxyError(
            "cliproxy_timeout",
            "CLIProxyAPI response body timed out",
            504,
            { retryable: true, stage: "request" }
          )
    );
    const negotiatedJsonErrorEnvelope = headers.get("x-friday-cpa-evidence-contract") === "cpa-basic@1"
      && isJsonContentType(response.headers);
    if (!response.ok && !negotiatedJsonErrorEnvelope) {
      const errorBody = await safeErrorBody(response);
      lifecycle.dispose();
      throw cliProxyHttpError(response.status, errorBody);
    }
    return responseWithLifecycle(response, lifecycle);
  }
}

export function assertJsonContentType(headers: Headers): void {
  if (!isJsonContentType(headers)) throw cliProxyProtocolError("CLIProxyAPI did not return a JSON response");
}

function isJsonContentType(headers: Headers): boolean {
  const value = headers.get("content-type");
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

export function safeCliProxyRequestHeaders(input?: HeadersInit): Headers {
  const source = new Headers(input);
  const headers = new Headers();
  for (const name of CLIPROXY_REQUEST_HEADER_ALLOWLIST) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

export function safeCliProxyResponseHeaders(input: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of CLIPROXY_RESPONSE_HEADER_ALLOWLIST) {
    const value = input.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

interface AbortLifecycle {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  setTimeout(timeoutMs: number, reason: CliProxyError): void;
  dispose(): void;
}

function createAbortLifecycle(external: AbortSignal | undefined): AbortLifecycle {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external?.aborted) controller.abort(external.reason);
  else external?.addEventListener("abort", onExternalAbort, { once: true });
  const setLifecycleTimeout = (timeoutMs: number, reason: CliProxyError) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(reason), timeoutMs);
  };
  const dispose = () => {
    if (timeout) clearTimeout(timeout);
    external?.removeEventListener("abort", onExternalAbort);
  };
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    setTimeout: setLifecycleTimeout,
    dispose
  };
}

function validTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw cliProxyProtocolError("CLIProxyAPI request timeout is invalid");
  return value;
}

function responseWithLifecycle(response: Response, lifecycle: AbortLifecycle): Response {
  if (!response.body) {
    lifecycle.dispose();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await readBodyWithSignal(reader, lifecycle.signal);
        if (next.done) {
          lifecycle.dispose();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        lifecycle.dispose();
        controller.error(lifecycle.signal.aborted ? lifecycle.signal.reason : error);
      }
    },
    async cancel(reason) {
      lifecycle.abort(reason);
      lifecycle.dispose();
      await reader.cancel(reason).catch(() => undefined);
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function readBodyWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function safeErrorBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await readResponseTextBounded(response, CLIPROXY_ERROR_BODY_MAX_BYTES);
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readResponseTextBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw cliProxyProtocolError("CLIProxyAPI response exceeded the configured byte limit");
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const parser = new StreamingJsonValueParser();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parser.write(next.value);
    }
    const result = parser.finish();
    if (!result.hasValue) {
      if (result.decodedByteLength === 0) return {};
      throw cliProxyProtocolError("CLIProxyAPI returned invalid JSON");
    }
    return result.value;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (error instanceof CliProxyError) throw error;
    throw cliProxyProtocolError("CLIProxyAPI returned invalid JSON");
  } finally {
    reader.releaseLock();
  }
}
