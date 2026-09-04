import { RelayError } from "@frely/core";
import {
  providerErrorCodeFromBody,
  streamToSse,
  type ProviderAdapterResponse,
  type ProviderStreamEvent,
} from "@frely/gateway-core";

export const STREAM_RESPONSE_GRACE_MS = 30_000;
export const STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

export interface StreamingGatewayResponseOptions {
  requestId: string;
  signal?: AbortSignal;
  graceMs?: number;
  heartbeatIntervalMs?: number;
  onProviderResponse?: (response: ProviderAdapterResponse) => void;
  onErrorCode?: (errorCode: string) => void;
}

type InvocationSettlement =
  | { status: "fulfilled"; value: ProviderAdapterResponse }
  | { status: "rejected"; reason: unknown };

export async function createStreamingGatewayResponse(
  invocation: Promise<ProviderAdapterResponse>,
  options: StreamingGatewayResponseOptions,
): Promise<Response> {
  const graceMs = positiveSafeInteger(options.graceMs ?? STREAM_RESPONSE_GRACE_MS, "graceMs");
  const heartbeatIntervalMs = positiveSafeInteger(
    options.heartbeatIntervalMs ?? STREAM_HEARTBEAT_INTERVAL_MS,
    "heartbeatIntervalMs",
  );
  const settlement: Promise<InvocationSettlement> = invocation.then(
    (response) => {
      options.onProviderResponse?.(response);
      return { status: "fulfilled" as const, value: response };
    },
    (reason) => {
      options.onErrorCode?.(invocationErrorCode(reason, options.signal));
      return { status: "rejected" as const, reason };
    },
  );

  const graceOutcome = await waitForSettlementGrace(settlement, graceMs, options.signal);
  if (graceOutcome.kind === "aborted") {
    throw new RelayError("request_aborted", "Request was aborted", 499);
  }
  if (graceOutcome.kind === "settled") {
    if (graceOutcome.settlement.status === "rejected") throw graceOutcome.settlement.reason;
    return responseFromEarlySettlement(graceOutcome.settlement.value, options.requestId, heartbeatIntervalMs);
  }

  return new Response(
    streamToSse(deferredProviderEvents(settlement, options), {
      heartbeatIntervalMs,
      initialHeartbeat: true,
    }),
    {
      status: 200,
      headers: gatewayResponseHeaders(undefined, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-request-id": options.requestId,
      }),
    },
  );
}

export function gatewayResponseHeaders(
  _providerHeaders: Record<string, string> | undefined,
  base: Record<string, string>,
): Record<string, string> {
  return { ...base };
}

function responseFromEarlySettlement(
  response: ProviderAdapterResponse,
  requestId: string,
  heartbeatIntervalMs: number,
): Response {
  if (response.stream) {
    return new Response(streamToSse(response.stream, { heartbeatIntervalMs, initialHeartbeat: true }), {
      status: response.status,
      headers: gatewayResponseHeaders(response.headers, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-request-id": requestId,
      }),
    });
  }
  return Response.json(response.body, {
    status: response.status,
    headers: gatewayResponseHeaders(response.headers, { "x-request-id": requestId }),
  });
}

async function* deferredProviderEvents(
  settlement: Promise<InvocationSettlement>,
  options: StreamingGatewayResponseOptions,
): AsyncIterable<ProviderStreamEvent> {
  const result = await settlement;
  if (result.status === "rejected") {
    yield invocationErrorEvent(result.reason, options.signal);
    return;
  }
  const response = result.value;
  if (response.stream) {
    yield* response.stream;
    return;
  }
  const errorCode = response.status >= 400
    ? providerErrorCodeFromBody(response.body)
    : "provider_stream_missing";
  options.onErrorCode?.(errorCode);
  yield {
    type: "error",
    code: errorCode,
    message: response.status >= 400 ? "Provider request failed" : "Provider stream is unavailable",
    retryable: retryableStatus(response.status),
  };
}

function invocationErrorEvent(error: unknown, signal: AbortSignal | undefined): ProviderStreamEvent {
  if (error instanceof RelayError) {
    return {
      type: "error",
      code: error.code,
      message: error.message,
      retryable: retryableStatus(error.status),
    };
  }
  if (signal?.aborted) {
    return {
      type: "error",
      code: "cliproxy_request_aborted",
      message: "Provider request was aborted",
      retryable: false,
    };
  }
  return {
    type: "error",
    code: "internal_error",
    message: "Unexpected error",
    retryable: true,
  };
}

function invocationErrorCode(error: unknown, signal: AbortSignal | undefined): string {
  if (error instanceof RelayError) return error.code;
  return signal?.aborted ? "cliproxy_request_aborted" : "internal_error";
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function waitForSettlementGrace(
  settlement: Promise<InvocationSettlement>,
  graceMs: number,
  signal: AbortSignal | undefined,
): Promise<
  | { kind: "settled"; settlement: InvocationSettlement }
  | { kind: "expired" }
  | { kind: "aborted" }
> {
  if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => settle(() => resolve({ kind: "expired" })), graceMs);
    const onAbort = () => settle(() => resolve({ kind: "aborted" }));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    void settlement.then((result) => settle(() => resolve({ kind: "settled", settlement: result })));
  });
}
