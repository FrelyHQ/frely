import { describe, expect, test } from "vitest";
import {
  parseProviderFetchDiagnostic,
  providerFetchCauseCode,
  type ProviderFetchDiagnosticV1
} from "@frely/core";
import { RequestTiming, streamToSse, type ProviderStreamEvent } from "@frely/gateway-core";
import { gatewaySummaryLog, recordGatewayRequestFailure } from "../apps/gateway/src/gateway-summary";

describe("REQ-OPS-002 Gateway provider fetch diagnostics", () => {
  test("extracts only a stable cause code and prefers error.cause.code", () => {
    const error = Object.assign(new Error("fetch failed https://secret.example Authorization: Bearer token"), {
      code: "ECONNRESET",
      cause: { code: "UND_ERR_SOCKET", stack: "prompt-sentinel", authorization: "Bearer secret" }
    });
    expect(providerFetchCauseCode(error)).toBe("UND_ERR_SOCKET");
    expect(providerFetchCauseCode({ code: "ENOTFOUND" })).toBe("ENOTFOUND");
    expect(providerFetchCauseCode({ cause: { code: "bad code with spaces" }, code: "bad/code" })).toBeUndefined();
  });

  test("does not invoke malicious getters or recursively serialize errors", () => {
    let getterCalls = 0;
    const cause = {};
    Object.defineProperty(cause, "code", { enumerable: true, get() { getterCalls += 1; throw new Error("getter should not run"); } });
    const cyclic: Record<string, unknown> = { code: "ECONNRESET", cause };
    cyclic.self = cyclic;
    expect(providerFetchCauseCode(cyclic)).toBe("ECONNRESET");
    expect(getterCalls).toBe(0);

    const malicious = { version: 1, transport: "sse", retryable: true, eventsReceived: 0 } as Record<string, unknown>;
    Object.defineProperty(malicious, "stage", { enumerable: true, get() { getterCalls += 1; return "response_headers"; } });
    expect(parseProviderFetchDiagnostic(malicious as unknown as ProviderFetchDiagnosticV1)).toBeNull();
    expect(getterCalls).toBe(0);
  });

  test("strictly validates versioned, bounded diagnostics", () => {
    const diagnostic: ProviderFetchDiagnosticV1 = {
      version: 1,
      stage: "response_headers",
      transport: "sse",
      continuationMode: "sse-fallback",
      causeCode: "UND_ERR_SOCKET",
      retryable: true,
      eventsReceived: 0
    };
    expect(parseProviderFetchDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(parseProviderFetchDiagnostic({ ...diagnostic, eventsReceived: 1 })).toBeNull();
    expect(parseProviderFetchDiagnostic({ ...diagnostic, prompt: "prompt-sentinel" })).toBeNull();
  });

  test("keeps diagnostics out of the public SSE contract", async () => {
    const diagnostic = parseProviderFetchDiagnostic({ version: 1, stage: "stream_read", transport: "sse", causeCode: "ECONNRESET", retryable: true, eventsReceived: 1 })!;
    const sse = await new Response(streamToSse(iterable<ProviderStreamEvent>([
      { type: "error", code: "provider_fetch_failed", message: "fetch failed", retryable: true, diagnostic }
    ]))).text();
    expect(sse).toContain("provider_fetch_failed");
    expect(sse).not.toContain("diagnostic");
    expect(sse).not.toContain("ECONNRESET");
  });

  test("preserves a stable stream error when downstream cancellation throws", () => {
    const summary = {
      requestId: "req_cancelled_stream",
      route: "/v1/messages",
      method: "POST",
      status: 200,
      stream: true,
      errorCode: null,
      gateway: {
        providerKind: "cliproxy",
        accessPointId: "ap_1",
        billingSubscriptionId: "sub_1",
        usageSource: null,
        errorCode: "cliproxy_request_aborted",
        captureErrorCode: null,
      },
    };

    recordGatewayRequestFailure(summary, new Error("Downstream connection closed"), true);

    expect(summary.status).toBe(499);
    expect(summary.errorCode).toBe("cliproxy_request_aborted");
  });

  test("adds the allowlisted fields to the Gateway summary", () => {
    const diagnostic = parseProviderFetchDiagnostic({ version: 1, stage: "stream_read", transport: "sse", continuationMode: "sse-fallback", causeCode: "UND_ERR_SOCKET", retryable: true, eventsReceived: 2 })!;
    const summary = gatewaySummaryLog({
      requestId: "req_summary",
      route: "/v1/responses",
      method: "POST",
      status: 200,
      stream: true,
      errorCode: null,
      gateway: { providerKind: "cliproxy", accessPointId: "ap_1", billingSubscriptionId: "sub_1", usageSource: null, errorCode: "provider_fetch_failed", captureErrorCode: "request_capture_stream_write_failed", errorDiagnostic: diagnostic }
    }, new RequestTiming());
    expect(summary).toEqual(expect.objectContaining({
      event: "gateway.request.failed",
      errorStage: "stream_read",
      errorTransport: "sse",
      errorContinuationMode: "sse-fallback",
      errorCauseCode: "UND_ERR_SOCKET",
      providerEventsReceived: 2,
      retryable: true,
      captureErrorCode: "request_capture_stream_write_failed"
    }));
  });
});

async function* iterable<T>(events: readonly T[]): AsyncIterable<T> {
  for (const event of events) yield event;
}
