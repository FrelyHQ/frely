import { RelayError } from "@frely/core";
import type { GatewayProviderSummary, RequestTiming } from "@frely/gateway-core";

export interface GatewaySummaryContext {
  requestId: string;
  route: string;
  method: string;
  status: number;
  stream: boolean;
  gateway: GatewayProviderSummary | null;
  errorCode: string | null;
}

export function recordGatewayRequestFailure(summary: GatewaySummaryContext, error: unknown, aborted: boolean): void {
  summary.status = error instanceof RelayError ? error.status : aborted ? 499 : 500;
  summary.errorCode = summary.errorCode
    ?? summary.gateway?.errorCode
    ?? (error instanceof RelayError ? error.code : aborted ? "request_aborted" : "internal_error");
}

export function gatewaySummaryLog(summary: GatewaySummaryContext, timing: RequestTiming) {
  const statusClass = `${Math.floor(summary.status / 100)}xx`;
  const errorCode = summary.errorCode ?? summary.gateway?.errorCode ?? null;
  const diagnostic = summary.gateway?.errorDiagnostic;
  return {
    event: summary.status >= 500 || errorCode ? "gateway.request.failed" : "gateway.request.completed",
    requestId: summary.requestId,
    route: summary.route,
    method: summary.method,
    status: summary.status,
    statusClass,
    stream: summary.stream,
    providerKind: summary.gateway?.providerKind ?? null,
    accessPointId: summary.gateway?.accessPointId ?? null,
    billingSubscriptionId: summary.gateway?.billingSubscriptionId ?? null,
    usageSource: summary.gateway?.usageSource ?? null,
    captureErrorCode: summary.gateway?.captureErrorCode ?? null,
    errorStage: diagnostic?.stage ?? null,
    errorTransport: diagnostic?.transport ?? null,
    errorContinuationMode: diagnostic?.continuationMode ?? null,
    errorCauseCode: diagnostic?.causeCode ?? null,
    providerEventsReceived: diagnostic?.eventsReceived ?? null,
    retryable: diagnostic?.retryable ?? null,
    durationMs: timing.durationMs(),
    stageMs: timing.stageMs(),
    errorCode
  };
}
