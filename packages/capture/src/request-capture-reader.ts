import { RelayError } from "@frely/core";
import type { CapturedExchange, RequestCapturePresence, RequestCaptureStore } from "./request-captures.js";
import type { RequestLog } from "./contracts.js";

export interface LocatedCapturedExchange {
  exchange: CapturedExchange;
}

export type RequestCaptureView = "original" | "effective" | "response";

export type RequestCaptureViewResponse = {
  view: RequestCaptureView;
  body: unknown | null;
  capturedAt: string | null;
  status?: number | null;
  errorCode?: string | null;
  effectiveStatus?: "verified" | "unavailable";
  effectiveRepresentation?: "identity" | "rfc6902" | "full" | null;
  effectiveUnavailableReason?: string | null;
};

export function parseRequestCaptureView(value: string | null): RequestCaptureView | null {
  if (value === null) return null;
  if (value === "original" || value === "effective" || value === "response") return value;
  throw new RelayError("invalid_request_capture_view", "Request Capture view must be original, effective, or response", 400);
}

export function requestCaptureViewResponse(exchange: CapturedExchange, view: RequestCaptureView): RequestCaptureViewResponse {
  if (view === "original") {
    return { view, body: exchange.request?.payload ?? null, capturedAt: exchange.request?.createdAt ?? null };
  }
  if (view === "effective") {
    const effective = exchange.request?.effective;
    return {
      view,
      body: effective?.status === "verified" ? effective.body : null,
      capturedAt: exchange.request?.createdAt ?? null,
      effectiveStatus: effective?.status ?? "unavailable",
      effectiveRepresentation: effective?.status === "verified" ? effective.representation : null,
      effectiveUnavailableReason: effective?.status === "unavailable" ? effective.reason : null
    };
  }
  return {
    view,
    body: exchange.response?.body ?? null,
    capturedAt: exchange.response?.createdAt ?? null,
    status: exchange.response?.status ?? null,
    errorCode: exchange.response?.errorCode ?? null
  };
}

/**
 * REQ-MEMBER-009: callers must supply already-authorized Request Logs. The
 * reader derives one hot v3 path or one cold month Catalog lookup from
 * `startedAt + id`; it never scans arbitrary client paths. A missing Catalog
 * or archive-format-v2 month uses the bounded, read-only pack-scan fallback.
 */
export class RequestCaptureReader {
  constructor(readonly repo: RequestCaptureStore) {}

  getCapturePresenceForRequestLogsAsync(
    requestLogs: ReadonlyArray<Pick<RequestLog, "id" | "startedAt">>,
  ): Promise<Map<string, RequestCapturePresence>> {
    return this.repo.hasRequestCaptureForRequestLogsAsync(requestLogs);
  }

  async getCapturedExchangeForRequestLogAsync(requestLog: Pick<RequestLog, "id" | "startedAt">): Promise<LocatedCapturedExchange | null> {
    const exchange = await this.repo.getCapturedExchangeForRequestLogAsync(requestLog);
    return exchange ? { exchange } : null;
  }

  async getCapturedExchangesForRequestLogs(requestLogs: ReadonlyArray<Pick<RequestLog, "id" | "startedAt">>): Promise<Map<string, LocatedCapturedExchange>> {
    const result = new Map<string, LocatedCapturedExchange>();
    await this.visitCapturedExchangesForRequestLogs(requestLogs, (requestId, located) => { result.set(requestId, located); });
    return result;
  }

  async visitCapturedExchangesForRequestLogs(
    requestLogs: ReadonlyArray<Pick<RequestLog, "id" | "startedAt">>,
    visitor: (requestId: string, located: LocatedCapturedExchange) => void | Promise<void>
  ): Promise<{ matchedRequestIds: Set<string> }> {
    const unique = new Map(requestLogs.map((requestLog) => [requestLog.id, requestLog]));
    const matchedRequestIds = new Set<string>();
    for (const requestLog of unique.values()) {
      let exchange: CapturedExchange | null;
      try {
        exchange = await this.repo.getCapturedExchangeForRequestLogAsync(requestLog);
      } catch (error) {
        if (error instanceof RelayError) throw error;
        throw new RelayError("request_capture_unavailable", "Request Capture v3 file is unavailable", 503);
      }
      if (!exchange) continue;
      matchedRequestIds.add(requestLog.id);
      await visitor(requestLog.id, { exchange });
    }
    return { matchedRequestIds };
  }
}
