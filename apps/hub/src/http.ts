import { createServer } from "node:http";
import { errorPayload, errorStatus, requestIdFromHeaders, RelayError } from "@frely/core";
import { HubExecutor, type HubEndpoint, type HubSummary } from "./executor.js";
import type { HubConfig, HubProtocol } from "./config.js";
import { HubModelDiscovery } from "./models.js";
import { isLoopbackListenHost } from "./security.js";

export interface HubHttpServerOptions {
  logger?: (summary: ReturnType<typeof hubSummaryLog>) => void;
}

export function createHubServer(config: HubConfig, options: HubHttpServerOptions = {}) {
  const token = process.env[config.server.authTokenEnv];
  if (!isLoopbackListenHost(config.server.host) && !token) {
    throw new RelayError("hub_auth_required", "Non-loopback friday-hub listen host requires a local bearer token", 500);
  }

  const executor = new HubExecutor(config);
  const modelDiscovery = new HubModelDiscovery(config);
  const logger = options.logger ?? ((summary: ReturnType<typeof hubSummaryLog>) => console.log(JSON.stringify(summary)));

  return createServer(async (incoming, outgoing) => {
    const startedAt = performance.now();
    const request = toRequest(config, incoming);
    const requestId = requestIdFromHeaders(request.headers);
    const summary: HubSummary = {
      requestId,
      protocol: "openai",
      routeModel: "*",
      upstreamId: null,
      status: 500,
      durationMs: 0,
      proxyMode: null,
      errorCode: null,
      fallbackFrom: null,
      fallbackTo: null,
      modelDiscoveryStale: false
    };

    try {
      const response = await route(config, token, executor, modelDiscovery, request, requestId, summary);
      summary.status = response.status;
      await writeResponse(outgoing, response);
    } catch (error) {
      summary.status = errorStatus(error);
      summary.errorCode = error instanceof RelayError ? error.code : "internal_error";
      await writeResponse(outgoing, Response.json(errorPayload(error, requestId), {
        status: summary.status,
        headers: { "x-request-id": requestId }
      }));
    } finally {
      summary.durationMs = Math.round(performance.now() - startedAt);
      logger(hubSummaryLog(summary));
    }
  });
}

async function route(
  config: HubConfig,
  token: string | undefined,
  executor: HubExecutor,
  modelDiscovery: HubModelDiscovery,
  request: Request,
  requestId: string,
  summary: HubSummary
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    assertMethod(request.method, "GET");
    return Response.json({ ok: true, service: "friday-hub" });
  }
  if (url.pathname === "/ready") {
    assertMethod(request.method, "GET");
    return Response.json({ ok: true, service: "friday-hub", routes: config.routes.length, upstreams: config.upstreams.length });
  }
  if (!url.pathname.startsWith("/v1/")) throw new RelayError("not_found", "Not found", 404);
  assertLocalAuth(config, token, request.headers);
  if (url.pathname === "/v1/models") {
    assertMethod(request.method, "GET");
    const body = await modelDiscovery.listModels();
    return Response.json(body, { headers: { "x-request-id": requestId } });
  }
  assertMethod(request.method, "POST");

  const endpoint = endpointFromPath(url.pathname);
  const protocol = protocolFromEndpoint(endpoint);
  summary.protocol = protocol;
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  summary.routeModel = String(payload.model ?? "*");
  const result = await executor.invoke({
    endpoint,
    protocol,
    payload,
    stream: Boolean(payload.stream),
    requestId
  });
  Object.assign(summary, result.summary);
  return result.response;
}

function assertMethod(actual: string, expected: "GET" | "POST"): void {
  if (actual !== expected) throw new RelayError("method_not_allowed", "Method not allowed", 405);
}

function assertLocalAuth(config: HubConfig, token: string | undefined, headers: Headers): void {
  if (!token && isLoopbackListenHost(config.server.host)) return;
  const authorization = headers.get("authorization") ?? "";
  if (authorization !== `Bearer ${token}`) throw new RelayError("unauthorized", "Unauthorized", 401);
}

function endpointFromPath(pathname: string): HubEndpoint {
  if (pathname === "/v1/chat/completions") return "chat.completions";
  if (pathname === "/v1/responses") return "responses";
  if (pathname === "/v1/messages") return "messages";
  throw new RelayError("not_found", "friday-hub endpoint not found", 404);
}

function protocolFromEndpoint(endpoint: HubEndpoint): HubProtocol {
  return endpoint === "messages" ? "claude" : "openai";
}

export function hubSummaryLog(summary: HubSummary) {
  return {
    event: summary.status >= 500 || summary.errorCode ? "hub.request.failed" : "hub.request.completed",
    requestId: summary.requestId,
    protocol: summary.protocol,
    routeModel: summary.routeModel,
    upstreamId: summary.upstreamId,
    status: summary.status,
    durationMs: summary.durationMs,
    proxyMode: summary.proxyMode,
    errorCode: summary.errorCode,
    fallbackFrom: summary.fallbackFrom,
    fallbackTo: summary.fallbackTo,
    modelDiscoveryStale: summary.modelDiscoveryStale
  };
}

async function writeResponse(outgoing: import("node:http").ServerResponse, response: Response): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      outgoing.write(value);
    }
  }
  outgoing.end();
}

function toRequest(config: HubConfig, message: import("node:http").IncomingMessage): Request {
  const protocol = "http";
  const host = message.headers.host ?? `${config.server.host}:${config.server.port}`;
  const url = `${protocol}://${host}${message.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(","));
    else if (value !== undefined) headers.set(key, value);
  }
  const method = message.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = message as unknown as BodyInit;
    init.duplex = "half";
  }
  return new Request(url, init);
}
