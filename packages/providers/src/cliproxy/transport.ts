import {
  CPA_BASIC_EVIDENCE_CONTRACT,
  parseCpaBasicJsonEnvelope,
  parseCpaBasicStreamEvidenceEvent,
  unresolvedProviderExecutionEvidence,
  unresolvedProviderFailure,
  type CpaBasicEvidenceEnvelopeV1,
  type ProviderStreamEvent,
} from "@frely/provider-runtime";
import type { ProviderAdapter, ProviderAdapterRequest, ProviderAdapterResponse } from "@frely/provider-runtime/adapter";
import { RelayError } from "@frely/core";
import { CliProxyClient, safeCliProxyResponseHeaders } from "./client.js";
import { assertProviderPrefix } from "./catalog.js";
import { DEFAULT_CLIPROXY_TIMEOUT_MS } from "./config.js";
import { CliProxyError, cliProxyAttemptFailure, cliProxyErrorResponse, cliProxyHttpError, cliProxyStreamError } from "./errors.js";
import { parseCliProxySse, type CliProxySseLimits } from "./sse.js";

const CLIPROXY_SERVER_OWNED_FIELDS = new Set(["model", "stream", "store"]);
export const DEFAULT_CLIPROXY_STREAM_IDLE_TIMEOUT_MS = DEFAULT_CLIPROXY_TIMEOUT_MS;

const CLIPROXY_FORBIDDEN_CONTROL_FIELDS = new Set([
  "headers", "baseurl", "providerurl", "apikey", "managementapikey", "authorization", "credential",
  "credentials", "credentialref", "proxy", "proxyurl", "signal", "timeout", "timeoutms", "transport",
  "websocketconnecttimeoutms", "maxretries", "maxretrydelayms", "fetch", "dispatcher", "agent", "onpayload",
  "onresponse", "ontransport", "ontransporterror", "onevent", "onchunk", "onerror", "fridaymaxcontexttokens"
]);

export interface CliProxyTransportOptions {
  sseLimits?: Partial<CliProxySseLimits>;
  streamIdleTimeoutMs?: number;
}

export class CliProxyTransport implements ProviderAdapter {
  private readonly client: CliProxyClient;
  private readonly options: CliProxyTransportOptions;

  constructor(client: CliProxyClient, options: CliProxyTransportOptions = {}) {
    this.client = client;
    this.options = options;
  }

  async invoke(request: ProviderAdapterRequest): Promise<ProviderAdapterResponse> {
    try {
      assertCliProxyRequest(request);
      const payload = cliProxyPayload(request);
      const response = request.kind === "responses"
        ? await this.client.responses(payload, cliProxyRequestOptions(request))
        : request.kind === "messages"
          ? await this.client.messages(payload, cliProxyRequestOptions(request))
          : await this.client.chatCompletions(payload, cliProxyRequestOptions(request));
      if (request.stream && response.ok) return this.streamingResponse(response, request);
      const result = await this.client.readJson(response);
      const envelope = parseCpaBasicJsonEnvelope(result.body, request.metadata.providerAttemptId);
      const evidence = envelope ? projectCpaEvidence(envelope.evidence) : unresolvedProviderExecutionEvidence();
      const publicBody = envelope?.response ?? cpaJsonPublicBody(result.body);
      if (result.status >= 400) {
        const errorResponse = cliProxyErrorResponse(cliProxyHttpError(result.status, publicBody));
        return {
          ...errorResponse,
          headers: result.headers,
          evidence,
          ...(envelope?.evidence.failureClass ? { failure: {
            version: 1 as const,
            failureClass: envelope.evidence.failureClass,
            ...(errorResponse.failure.failureReason ? { failureReason: errorResponse.failure.failureReason } : {}),
            costExposure: evidence.costExposure,
            finalUsageEvidence: evidence.finalUsageEvidence,
            ...(evidence.trustedUsage ? { trustedUsage: evidence.trustedUsage } : {}),
          } } : {}),
        };
      }
      const body = rewriteCliProxyModelForClient(publicBody, request);
      return {
        status: result.status,
        headers: result.headers,
        body,
        evidence,
        ...(envelope?.evidence.failureClass ? { failure: {
          version: 1 as const,
          failureClass: envelope.evidence.failureClass,
          costExposure: evidence.costExposure,
          finalUsageEvidence: evidence.finalUsageEvidence,
          ...(evidence.trustedUsage ? { trustedUsage: evidence.trustedUsage } : {}),
        } } : {}),
        ...(evidence.finalUsageEvidence === "final" && evidence.trustedUsage ? { usage: evidence.trustedUsage } : {}),
        ...(envelope?.evidence.serviceTier ? { serviceTier: envelope.evidence.serviceTier } : {})
      };
    } catch (error) {
      if (error instanceof RelayError && !(error instanceof CliProxyError)) throw error;
      return cliProxyErrorResponse(error);
    }
  }

  private streamingResponse(response: Response, request: ProviderAdapterRequest): ProviderAdapterResponse {
    if (!response.body) return cliProxyErrorResponse(new CliProxyError("cliproxy_stream_missing", "CLIProxyAPI stream body is missing", 502, { stage: "response_headers" }));
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      void response.body.cancel().catch(() => undefined);
      return cliProxyErrorResponse(new CliProxyError("cliproxy_stream_content_type_invalid", "CLIProxyAPI did not return an SSE stream", 502, { stage: "response_headers" }));
    }
    return {
      status: response.status,
      headers: safeCliProxyResponseHeaders(response.headers),
      stream: this.providerStream(response.body, request)
    };
  }

  private async *providerStream(body: ReadableStream<Uint8Array>, request: ProviderAdapterRequest): AsyncIterable<ProviderStreamEvent> {
    const requestAbortSignal = requestSignal(request);
    const idleController = new AbortController();
    const signal = requestAbortSignal
      ? AbortSignal.any([requestAbortSignal, idleController.signal])
      : idleController.signal;
    const streamIdleTimeoutMs = positiveSafeInteger(this.options.streamIdleTimeoutMs ?? DEFAULT_CLIPROXY_STREAM_IDLE_TIMEOUT_MS);
    let cpaEvidence: CpaBasicEvidenceEnvelopeV1 | null = null;
    let evidenceInvalid = false;
    let eventsReceived = 0;
    let doneMarker = false;
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimeout = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        idleController.abort(new CliProxyError(
          "cliproxy_stream_idle_timeout",
          "CLIProxyAPI stream idle timeout exceeded",
          504,
          { retryable: true, stage: "stream_read" }
        ));
      }, streamIdleTimeoutMs);
    };
    armIdleTimeout();
    try {
      for await (const event of parseCliProxySse(body, {
        ...(signal ? { signal } : {}),
        ...(this.options.sseLimits ? { limits: this.options.sseLimits } : {}),
        onBytes: armIdleTimeout
      })) {
        if (event.type === "done") {
          if (doneMarker) throw new CliProxyError("cliproxy_sse_terminal_invalid", "CLIProxyAPI stream contained duplicate wire terminal markers", 502, { stage: "protocol" });
          doneMarker = true;
          continue;
        }
        if (doneMarker) throw new CliProxyError("cliproxy_sse_terminal_invalid", "CLIProxyAPI stream contained data after its wire terminal marker", 502, { stage: "protocol" });
        eventsReceived += 1;
        if (isCpaBasicEvidenceEvent(event.data)) {
          const parsed = parseCpaBasicStreamEvidenceEvent(event.data, request.metadata.providerAttemptId);
          if (!parsed || cpaEvidence) {
            evidenceInvalid = true;
            cpaEvidence = null;
          } else {
            cpaEvidence = parsed;
          }
          continue;
        }
        const data = rewriteCliProxyModelForClient(event.data, request);
        if (!evidenceInvalid && cpaEvidence) {
          const evidence = projectCpaEvidence(cpaEvidence);
          if (cpaEvidence.failureClass) {
            const error = cliProxyEventError(data, eventsReceived);
            const normalizedFailure = cliProxyAttemptFailure(error);
            const failure = {
              version: 1 as const,
              failureClass: cpaEvidence.failureClass,
              ...(normalizedFailure.failureReason ? { failureReason: normalizedFailure.failureReason } : {}),
              costExposure: evidence.costExposure,
              finalUsageEvidence: evidence.finalUsageEvidence,
              ...(evidence.trustedUsage ? { trustedUsage: evidence.trustedUsage } : {}),
            };
            const terminal = {
              outcome: "failed" as const,
              code: error.code,
              message: error.message,
              retryable: failure.failureClass !== "non_retryable",
              failure,
              ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
            };
            yield { type: "chunk", data, terminal };
            yield { type: "error", ...terminal };
            return;
          }
          const terminal = {
            outcome: "succeeded" as const,
            evidence,
            ...(evidence.trustedUsage ? { usage: evidence.trustedUsage } : {}),
            ...(cpaEvidence.serviceTier ? { serviceTier: cpaEvidence.serviceTier } : {}),
          };
          yield { type: "chunk", data, terminal };
          yield {
            type: "done",
            ...(evidence.trustedUsage ? { usage: evidence.trustedUsage } : {}),
            ...(cpaEvidence.serviceTier ? { serviceTier: cpaEvidence.serviceTier } : {}),
            evidence,
          };
          return;
        }
        if (isCliProxyErrorEvent(data)) {
          const error = cliProxyEventError(data, eventsReceived);
          const failure = unresolvedProviderFailure(cliProxyAttemptFailure(error).failureClass);
          yield {
            type: "error",
            code: error.code,
            message: error.message,
            retryable: failure.failureClass !== "non_retryable",
            failure,
            ...(error.diagnostic ? { diagnostic: error.diagnostic } : {})
          };
          return;
        }
        yield { type: "chunk", data };
      }
      yield {
        type: "done",
        evidence: unresolvedProviderExecutionEvidence(),
      };
    } catch (error) {
      const normalized = cliProxyStreamError(error, eventsReceived, signal);
      yield {
        type: "error",
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        failure: cliProxyAttemptFailure(normalized),
        ...(normalized.diagnostic ? { diagnostic: normalized.diagnostic } : {})
      };
      return;
    } finally {
      if (idleTimeout) clearTimeout(idleTimeout);
      if (!doneMarker) await body.cancel().catch(() => undefined);
    }
  }
}

export function cliProxyPayload(request: ProviderAdapterRequest): Record<string, unknown> {
  assertCliProxyRequest(request);
  const options = sanitizeCliProxyPayload(request.options);
  const prefixedModel = cliProxyPrefixedModel(request.provider.id, request.tarModel);
  return {
    ...options,
    model: prefixedModel,
    stream: request.stream,
    ...(request.kind === "responses" || request.kind === "chat.completions" ? { store: false } : {})
  };
}

export function cliProxyPrefixedModel(providerId: string, tarModel: string): string {
  assertProviderPrefix(providerId);
  if (!tarModel || tarModel.startsWith("/") || tarModel.trim() !== tarModel) {
    throw new RelayError("cliproxy_target_model_invalid", "CLIProxyAPI target model is invalid", 500);
  }
  return `${providerId}/${tarModel}`;
}

export function sanitizeCliProxyPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (CLIPROXY_FORBIDDEN_CONTROL_FIELDS.has(normalizeControlFieldName(key))) {
      throw new RelayError("provider_control_field_forbidden", "Provider transport control fields cannot be supplied by the request", 400);
    }
    if (CLIPROXY_SERVER_OWNED_FIELDS.has(key)) continue;
    if (value === undefined || typeof value === "function") continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function normalizeControlFieldName(value: string): string {
  return value.replaceAll("_", "").replaceAll("-", "").toLowerCase();
}

function assertCliProxyProvider(request: ProviderAdapterRequest): void {
  assertProviderPrefix(request.provider.id);
  if (
    !request.provider.cpaInstanceId
    || !Number.isSafeInteger(request.provider.bindingRevision)
    || request.provider.bindingRevision < 1
    || request.provider.credentialRefCount !== 1
    || request.provider.credentialOwnership !== "cpa-managed"
    || (request.provider.authMethod !== "oauth" && request.provider.authMethod !== "api-key" && request.provider.authMethod !== "credential-import")
  ) {
    throw new RelayError("cliproxy_binding_not_ready", "CLIProxyAPI Provider binding is not ready", 503);
  }
}

function assertCliProxyRequest(request: ProviderAdapterRequest): void {
  assertCliProxyProvider(request);
  if (request.kind !== "responses" && request.kind !== "chat.completions" && request.kind !== "messages") {
    throw new CliProxyError("cliproxy_endpoint_not_supported", "CLIProxyAPI does not support this endpoint", 400, {
      stage: "configuration"
    });
  }
}

function cliProxyRequestOptions(request: ProviderAdapterRequest): { requestId: string; headers: Headers; signal?: AbortSignal } {
  const signal = requestSignal(request);
  const headers = new Headers({ "x-friday-cpa-evidence-contract": CPA_BASIC_EVIDENCE_CONTRACT });
  return { requestId: request.metadata.providerAttemptId, headers, ...(signal ? { signal } : {}) };
}

function requestSignal(request: ProviderAdapterRequest): AbortSignal | undefined {
  return request.signal;
}

function rewriteCliProxyModelForClient(value: unknown, request: ProviderAdapterRequest): unknown {
  const record = recordFromUnknown(value);
  if (!record) return value;
  const publicModel = request.sourceModel ?? (typeof request.options.model === "string" ? request.options.model : request.tarModel);
  const prefix = `${request.provider.id}/`;
  const rewritten = { ...record };
  if (typeof rewritten.model === "string" && rewritten.model.startsWith(prefix)) rewritten.model = publicModel;
  const response = recordFromUnknown(rewritten.response);
  if (response && typeof response.model === "string" && response.model.startsWith(prefix)) {
    rewritten.response = { ...response, model: publicModel };
  }
  return rewritten;
}

function cpaJsonPublicBody(value: unknown): unknown {
  const record = recordFromUnknown(value);
  return record?.contract === "cpa-basic-json@1" && "response" in record ? record.response : value;
}

function projectCpaEvidence(envelope: CpaBasicEvidenceEnvelopeV1) {
  return Object.freeze({
    version: 1 as const,
    costExposure: envelope.costExposure,
    finalUsageEvidence: envelope.finalUsageEvidence,
    ...(envelope.trustedUsage ? { trustedUsage: envelope.trustedUsage } : {}),
  });
}

function isCpaBasicEvidenceEvent(value: unknown): boolean {
  return recordFromUnknown(value)?.type === "cpa.basic.evidence";
}

function isCliProxyErrorEvent(value: unknown): boolean {
  const record = recordFromUnknown(value);
  return record?.type === "error";
}

function cliProxyEventError(value: unknown, eventsReceived: number): CliProxyError {
  const record = recordFromUnknown(value);
  const candidateStatus = record?.status;
  const status = typeof candidateStatus === "number"
    && Number.isSafeInteger(candidateStatus)
    && candidateStatus >= 400
    && candidateStatus <= 599
    ? candidateStatus
    : 502;
  const classified = cliProxyHttpError(status, value);
  return cliProxyStreamError(new CliProxyError(classified.code, classified.message, classified.status, {
    retryable: classified.retryable,
    stage: "stream_read",
    costExposure: classified.costExposure,
    finalUsageEvidence: classified.finalUsageEvidence,
    ...(classified.failureReason ? { failureReason: classified.failureReason } : {}),
    details: classified.details
  }), eventsReceived);
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CliProxyError("cliproxy_stream_limit_invalid", "CLIProxyAPI stream limit is invalid", 500, {
      retryable: false,
      stage: "configuration"
    });
  }
  return value;
}
