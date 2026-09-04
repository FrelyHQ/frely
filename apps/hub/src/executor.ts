import { errorPayload, RelayError } from "@frely/core";
import {
  extractTextFromProviderResponse,
  hubFormatForEndpoint,
  providerResponseToHubResponse,
  translateHubRequest,
  translateHubStream,
  type HubProviderFormat
} from "./protocol.js";
import type { HubConfig, HubProtocol } from "./config.js";
import { invokeMockOpenAi } from "./mock-openai.js";
import { fallbackCandidates, resolveHubRoute, type ResolvedHubRoute } from "./routing.js";
import { joinUpstreamUrl, proxyModeLabel, requestUpstream, resolveProxyConfig } from "./transport.js";

export type HubEndpoint = "chat.completions" | "responses" | "messages";

export interface HubInvokeInput {
  endpoint: HubEndpoint;
  protocol: HubProtocol;
  payload: Record<string, unknown>;
  stream: boolean;
  requestId: string;
}

export interface HubInvokeResult {
  response: Response;
  summary: Partial<HubSummary>;
}

export interface HubSummary {
  requestId: string;
  protocol: HubProtocol;
  routeModel: string;
  upstreamId: string | null;
  status: number;
  durationMs: number;
  proxyMode: string | null;
  errorCode: string | null;
  fallbackFrom: string | null;
  fallbackTo: string | null;
  modelDiscoveryStale: boolean;
}

export class HubExecutor {
  constructor(private readonly config: HubConfig) {}

  async invoke(input: HubInvokeInput): Promise<HubInvokeResult> {
    const model = String(input.payload.model ?? "");
    if (!model) throw new RelayError("missing_model", "Request body must include model", 400);
    const primary = resolveHubRoute(this.config, input.protocol, model);
    const candidates = [primary, ...fallbackCandidates(this.config, primary, input.protocol, model)];
    let fallbackFrom: string | null = null;
    let lastResult: HubInvokeResult | null = null;

    const sourceFormat = hubFormatForEndpoint(input.endpoint);
    for (const [index, candidate] of candidates.entries()) {
      let result: HubInvokeResult;
      try {
        result = await this.invokeCandidate(input, candidate, fallbackFrom);
      } catch (error) {
        if (!isUnsupportedProtocolFeature(error) || !hasSameSourceProtocolFallback(input, candidates.slice(index + 1), sourceFormat)) throw error;
        fallbackFrom = candidate.upstream.id;
        continue;
      }
      if (!shouldFallback(result.response.status) || candidate === candidates[candidates.length - 1]) {
        return {
          ...result,
          summary: {
            ...result.summary,
            fallbackFrom,
            fallbackTo: fallbackFrom ? candidate.upstream.id : null
          }
        };
      }
      fallbackFrom = candidate.upstream.id;
      lastResult = result;
    }

    if (lastResult) return lastResult;
    throw new RelayError("route_not_found", "No friday-hub route candidate available", 404);
  }

  private async invokeCandidate(input: HubInvokeInput, candidate: ResolvedHubRoute, fallbackFrom: string | null): Promise<HubInvokeResult> {
    if (candidate.upstream.kind === "mock-openai") {
      const response = invokeMockOpenAi(candidate.upstream, {
        endpoint: input.endpoint,
        targetModel: candidate.targetModel,
        requestId: input.requestId,
        stream: input.stream,
        payload: input.payload
      });
      return {
        response,
        summary: summaryFor(candidate, input, "none", response.status, fallbackFrom)
      };
    }

    const sourceFormat = hubFormatForEndpoint(input.endpoint);
    const targetFormat = targetFormatFor(input.endpoint, candidate.targetProtocol);
    const upstreamPayload = translateHubRequest(sourceFormat, targetFormat, {
      ...input.payload,
      model: candidate.targetModel,
      stream: input.stream
    });
    const endpoint = endpointForTarget(input.endpoint, targetFormat);
    const proxy = resolveProxyConfig(this.config, candidate.upstream);
    const apiKey = candidate.upstream.apiKeyEnv ? process.env[candidate.upstream.apiKeyEnv] : undefined;
    const upstreamResponse = await requestUpstream(this.config, {
      method: "POST",
      url: joinUpstreamUrl(candidate.upstream.baseUrl, endpoint),
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(upstreamPayload),
      upstream: candidate.upstream,
      proxy
    }).catch((error) => {
      const requestError = error instanceof RelayError ? error : new RelayError("upstream_fetch_failed", "Upstream request failed", 502);
      return new Response(JSON.stringify(errorPayload(requestError, input.requestId)), {
        status: requestError.status,
        headers: {
          "content-type": "application/json",
          "x-request-id": input.requestId,
          "x-friday-hub-safe-error": "1",
          "x-friday-hub-error-code": requestError.code
        }
      });
    });

    const headers = new Headers(upstreamResponse.headers);
    headers.set("x-request-id", input.requestId);
    if (upstreamResponse.status >= 400) {
      if (headers.get("x-friday-hub-safe-error") === "1") {
        const errorCode = headers.get("x-friday-hub-error-code");
        headers.delete("x-friday-hub-safe-error");
        headers.delete("x-friday-hub-error-code");
        return {
          response: new Response(upstreamResponse.body, { status: upstreamResponse.status, headers }),
          summary: summaryFor(candidate, input, proxyModeLabel(proxy), upstreamResponse.status, fallbackFrom, errorCode)
        };
      }
      return {
        response: sanitizedUpstreamErrorResponse(upstreamResponse.status, input.requestId, headers),
        summary: summaryFor(candidate, input, proxyModeLabel(proxy), upstreamResponse.status, fallbackFrom, "upstream_error")
      };
    }

    if (input.stream) {
      const body = upstreamResponse.body
        ? translateHubStream(targetFormat, sourceFormat, upstreamResponse.body)
        : upstreamResponse.body;
      headers.set("content-type", "text/event-stream");
      headers.set("cache-control", "no-cache");
      return {
        response: new Response(body, { status: upstreamResponse.status, headers }),
        summary: summaryFor(candidate, input, proxyModeLabel(proxy), upstreamResponse.status, fallbackFrom)
      };
    }

    const upstreamBody = await upstreamResponse.json().catch(() => ({})) as Record<string, unknown>;
    const body = targetFormat === sourceFormat
      ? upstreamBody
      : providerResponseToHubResponse(targetFormat, sourceFormat, upstreamBody, {
        requestId: input.requestId,
        model: String(input.payload.model),
        text: extractTextFromProviderResponse(targetFormat, upstreamBody)
      });
    headers.set("content-type", "application/json");
    return {
      response: Response.json(body, { status: upstreamResponse.status, headers }),
      summary: summaryFor(candidate, input, proxyModeLabel(proxy), upstreamResponse.status, fallbackFrom)
    };
  }
}

function shouldFallback(status: number): boolean {
  if (status < 400) return false;
  if (status === 401 || status === 402 || status === 403) return false;
  return true;
}

function sanitizedUpstreamErrorResponse(status: number, requestId: string, headers: Headers): Response {
  headers.set("content-type", "application/json");
  return Response.json(errorPayload(new RelayError("upstream_error", "Upstream returned an error", status), requestId), {
    status,
    headers
  });
}

function isUnsupportedProtocolFeature(error: unknown): error is RelayError {
  return error instanceof RelayError && error.code === "unsupported_protocol_feature";
}

function hasSameSourceProtocolFallback(input: HubInvokeInput, candidates: ResolvedHubRoute[], sourceFormat: HubProviderFormat): boolean {
  return candidates.some((candidate) => targetFormatFor(input.endpoint, candidate.targetProtocol) === sourceFormat);
}

function targetFormatFor(endpoint: HubEndpoint, targetProtocol: HubProtocol): HubProviderFormat {
  if (targetProtocol === "claude") return "anthropic";
  return endpoint === "responses" ? "openai-responses" : "openai";
}

function endpointForTarget(endpoint: HubEndpoint, targetFormat: HubProviderFormat): string {
  if (targetFormat === "anthropic") return "/v1/messages";
  if (targetFormat === "openai-responses") return "/responses";
  if (endpoint === "responses") return "/responses";
  return "/chat/completions";
}

function summaryFor(candidate: ResolvedHubRoute, input: HubInvokeInput, proxyMode: string, status: number, fallbackFrom: string | null, errorCode: string | null = null): Partial<HubSummary> {
  return {
    protocol: input.protocol,
    routeModel: String(input.payload.model ?? ""),
    upstreamId: candidate.upstream.id,
    proxyMode,
    status,
    errorCode,
    fallbackFrom
  };
}
