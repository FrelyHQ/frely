import { createServer } from "node:http";
import { loadConfig } from "@frely/config";
import { errorPayload, requestIdFromHeaders, RelayError } from "@frely/core";
import { assertSharedCaptureStorageForConfig, RequestCaptureV3Storage } from "@frely/capture";
import { auditDeniedAsync, openRuntimeDatabase } from "@frely/application/runtime";
import { AsyncGatewayExecutor, AsyncGatewayModelService, createPostgresGatewayPolicyGuards, pipeReadableStreamToWritable, providerErrorCodeFromBody, RequestTiming } from "@frely/gateway-core";
import { registerFridayRelayGatewayMetrics } from "@frely/observability/gateway-metrics";
import { createAsyncAbuseGuard, isExpectedApiKeyAuthenticationFailure, normalizeApiKeyAuthenticationFailure } from "@frely/tenancy";
import { gatewaySummaryLog, recordGatewayRequestFailure, type GatewaySummaryContext } from "./gateway-summary.js";
import { configureGatewayFatalReports } from "./gateway-fatal-reports.js";
import { gatewayRoutePattern, GatewayRuntimeObserver } from "./gateway-runtime-observer.js";
import { createProviderRuntime } from "./provider-adapter.js";
import { resolveGatewayRequestHostAsync, type GatewayHostResolution } from "./gateway-hosts.js";
import { productionShadowRiskGuardFromDatabaseEnvironment } from "./production-shadow-risk-runtime.js";
import { createStreamingGatewayResponse, gatewayResponseHeaders } from "./streaming-response.js";
import gatewayPackage from "../package.json" with { type: "json" };
import {
  admissionBodyBytes,
  acquireBodyRequestLease,
  type BodyAdmissionErrorCode,
  BodyMemoryController,
  type BodyRequestLease,
  cancelRequestBody,
  gatewayBodyRequestKind,
  inspectRequestBodyFraming,
  rawHeadersContain,
  readBoundedJsonBody,
  type RequestBodyFraming,
  WeightedBodyRequestCapacity
} from "./request-body.js";

const config = await loadConfig();
assertSharedCaptureStorageForConfig(config);
const gatewayMetrics = safelyRegisterGatewayMetrics();
await configureGatewayFatalReports(config.archive.directory);
const runtime = await openRuntimeDatabase({
  backend: "postgres",
  config,
  environment: process.env,
});
const captureStorage = new RequestCaptureV3Storage({ archiveDirectory: config.archive.directory });
const abandonedCaptureStagingFiles = captureStorage.cleanupAbandonedStreamCaptures();
if (abandonedCaptureStagingFiles > 0) {
  console.log(JSON.stringify({
    event: "request_capture.staging_cleanup",
    removedFiles: abandonedCaptureStagingFiles
  }));
}
const tenancy = runtime.gatewayIdentity;
const abuseGuard = createAsyncAbuseGuard({ queries: runtime.gatewayQueries, commands: runtime.gatewayCommands, config, source: "gateway" });
const providerRuntime = createProviderRuntime(runtime.providerRuntimeTargets);
const productionShadowRiskGuard = productionShadowRiskGuardFromDatabaseEnvironment(runtime.shadowRisk, process.env);
const requestCaptureStore = {
  writeCapturedExchange: (input: Parameters<RequestCaptureV3Storage["writeExchange"]>[0]) => captureStorage.writeExchange(input),
  beginCapturedStream: (input: Parameters<RequestCaptureV3Storage["beginStreamExchange"]>[0]) => captureStorage.beginStreamExchange(input),
};
const policyGuards = createPostgresGatewayPolicyGuards(runtime.gatewayQueries, runtime.gatewayEntitlementQueries);
const executor = new AsyncGatewayExecutor(
  runtime.gatewayQueries,
  runtime.gatewayCommands,
  providerRuntime,
  requestCaptureStore,
  policyGuards,
  (input) => auditDeniedAsync(runtime.audit, input),
  productionShadowRiskGuard,
  { leaseTtlSeconds: config.requestExecution.leaseTtlSeconds },
  runtime.backend === "postgres" ? runtime.requestExecutionCommands : undefined,
  runtime.modelAccessRoutingQueries,
  runtime.requestExecutionLeases,
  runtime.billingCommerceQueries,
);
const asyncModels = new AsyncGatewayModelService(runtime.gatewayQueries, policyGuards, runtime.modelAccessRoutingQueries);
const bodyRequestCapacity = new WeightedBodyRequestCapacity();
const bodyMemoryController = new BodyMemoryController(bodyRequestCapacity);
await bodyMemoryController.refresh();
bodyMemoryController.start();
const runtimeObserver = new GatewayRuntimeObserver({ bodyCapacity: bodyRequestCapacity });
runtimeObserver.start();

const server = createServer(async (incoming, outgoing) => {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  incoming.once("aborted", abort);
  incoming.once("error", abort);
  outgoing.once("error", abort);
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) abort();
  });
  const timing = new RequestTiming();
  timing.start("http.receive");
  let requestBodyFraming: RequestBodyFraming | undefined;
  let requestBodyFramingError: unknown;
  try {
    requestBodyFraming = inspectRequestBodyFraming(incoming.rawHeaders);
  } catch (error) {
    requestBodyFramingError = error;
  }
  const request = toRequest(incoming, abortController.signal);
  timing.end("http.receive");
  const requestId = requestIdFromHeaders(request.headers);
  const url = new URL(request.url);
  const routePattern = gatewayRoutePattern(url.pathname);
  const bodyRequestKind = gatewayBodyRequestKind(url.pathname);
  if (bodyRequestKind) bodyRequestCapacity.recordContentLength(rawHeadersContain(incoming.rawHeaders, "content-length"));
  const summary: GatewaySummaryContext = {
    requestId,
    route: routePattern,
    method: request.method,
    status: 500,
    stream: false,
    gateway: null,
    errorCode: null
  };
  const observeRuntime = url.pathname !== "/health";
  let bodyRequestLease: BodyRequestLease | undefined;
  if (observeRuntime) runtimeObserver.requestStarted({ requestId, route: routePattern, method: request.method, timing });
  try {
    const response = await route(request, requestId, timing, summary, requestBodyFraming, requestBodyFramingError, (bodyBytes) => {
      if (bodyRequestLease) throw new Error("Gateway body request lease was acquired more than once");
      bodyRequestLease = acquireBodyRequestLease(bodyRequestCapacity, bodyBytes);
    });
    summary.status = response.status;
    summary.stream = response.headers.get("content-type")?.startsWith("text/event-stream") ?? false;
    if (observeRuntime) runtimeObserver.markStream(requestId, summary.stream);
    timing.start("http.respond");
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      if (summary.stream) timing.start("stream.forward");
      try {
        await pipeReadableStreamToWritable(response.body, outgoing, {
          signal: request.signal,
          onCancel: abort
        });
      } finally {
        if (summary.stream) timing.end("stream.forward");
      }
    }
    await endOutgoingResponse(outgoing);
    timing.end("http.respond");
  } catch (error) {
    const payload = errorPayload(error, requestId);
    recordGatewayRequestFailure(summary, error, request.signal.aborted);
    if (bodyRequestKind && summary.errorCode && isBodyAdmissionErrorCode(summary.errorCode)) bodyRequestCapacity.recordOutcome(summary.errorCode);
    timing.start("http.respond");
    if (summary.errorCode === "invalid_content_length") outgoing.shouldKeepAlive = false;
    if (summary.errorCode !== "request_aborted" && !outgoing.headersSent && !outgoing.destroyed) {
      const retryAfterSeconds = error instanceof RelayError && "retryAfterSeconds" in error
        ? Number((error as RelayError & { retryAfterSeconds: number }).retryAfterSeconds)
        : null;
      outgoing.writeHead(summary.status, {
        "content-type": "application/json",
        "x-request-id": requestId,
        ...(retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {}),
        ...(summary.errorCode === "invalid_content_length" ? { connection: "close" } : {})
      });
      await endOutgoingResponse(outgoing, JSON.stringify(payload));
    } else if (!outgoing.destroyed) {
      outgoing.destroy();
    }
    timing.end("http.respond");
  } finally {
    try {
      bodyRequestLease?.release();
    } finally {
      try {
        console.log(JSON.stringify(gatewaySummaryLog(summary, timing)));
      } finally {
        if (observeRuntime) runtimeObserver.requestFinished(requestId);
      }
    }
  }
});

server.once("close", () => {
  runtimeObserver.stop();
  bodyMemoryController.stop();
  void gatewayMetrics?.shutdown().catch(() => undefined);
  void runtime.close().catch(() => undefined);
});

server.listen(config.gateway.port, config.gateway.host, () => {
  console.log(`gateway-srv listening on ${config.gateway.host}:${config.gateway.port}`);
});

function safelyRegisterGatewayMetrics() {
  try {
    return registerFridayRelayGatewayMetrics({ serviceVersion: gatewayPackage.version });
  } catch {
    console.warn(JSON.stringify({
      event: "gateway.metrics.registration_failed",
      errorCode: "metric_provider_registration_failed",
    }));
    return null;
  }
}

async function route(
  request: Request,
  requestId: string,
  timing: RequestTiming,
  summary: GatewaySummaryContext,
  bodyFraming: RequestBodyFraming | undefined,
  bodyFramingError: unknown,
  acquireBodyLease: (bodyBytes: number) => void
): Promise<Response> {
  const url = new URL(request.url);
  // Validate the ingress Host before path dispatch, authentication, or body
  // materialization so every Gateway route has the same rejection boundary.
  const hostResolution = await resolveGatewayRequestHostAsync(runtime.gatewayQueries, config, request.headers);
  if (url.pathname === "/health") {
    await productionShadowRiskGuard.selfCheck();
    return Response.json({
      ok: true,
      service: "gateway-srv",
      version: gatewayPackage.version,
      instance: process.env.FRIDAY_RELAY_INSTANCE ?? null,
      releaseId: process.env.FRIDAY_RELAY_RELEASE_ID ?? null,
      sourceSha: process.env.FRIDAY_RELAY_SOURCE_SHA ?? null,
    });
  }
  if (!url.pathname.startsWith("/v1/")) throw new RelayError("not_found", "Not found", 404);
  // Do not authenticate or read a request body before the exact Host is trusted.
  let principal;
  try {
    const authenticatedPrincipal = await restrictPrincipalToHost(
      await timing.measureAsync("auth.api_key", () => tenancy.authenticateApiKey(request.headers)),
      hostResolution,
      tenancy.tenancy,
    );
    principal = {
      ...authenticatedPrincipal,
      apiKeyPlanSourceRestriction: await runtime.gatewayEntitlementQueries.decideApiKeyPlanSourceRestriction(authenticatedPrincipal.apiKey.id),
    };
  } catch (error) {
    if (isExpectedApiKeyAuthenticationFailure(error)) {
      await abuseGuard.consume("gateway.auth.failed", request.headers, { routePattern: gatewayRoutePattern(url.pathname), requestId });
      throw normalizeApiKeyAuthenticationFailure(error);
    }
    throw error;
  }
  if (url.pathname === "/v1/models") {
    const response = await timing.measureAsync("access.resolve", () => asyncModels.listModels(principal, request.signal));
    summary.gateway = response.gatewaySummary ?? null;
    return Response.json(response.body, { status: response.status, headers: { "x-request-id": requestId } });
  }
  const kind = gatewayBodyRequestKind(url.pathname);
  if (!kind) throw new RelayError("not_found", "Gateway endpoint not found", 404);
  const framing = bodyFraming ?? { contentLengthPresent: false };
  try {
    if (bodyFramingError) throw bodyFramingError;
    acquireBodyLease(admissionBodyBytes(framing, config.gateway.maxRequestBodyBytes));
  } catch (error) {
    await cancelRequestBody(request.body);
    throw error;
  }
  const body = await timing.measureAsync("body.parse", () => readBoundedJsonBody(request, config.gateway.maxRequestBodyBytes, framing));
  const stream = Boolean(body.stream);
  const model = String(body.model ?? body.model_name ?? "*");
  const providerInvocation = executor.invoke(principal, { kind, model, payload: body, stream, requestId, requestPath: url.pathname, ingressHostname: hostResolution.hostname, ingressRouteId: hostResolution.ingressRouteId, timing, signal: request.signal });
  if (stream) {
    return createStreamingGatewayResponse(providerInvocation, {
      requestId,
      signal: request.signal,
      onProviderResponse: (providerResponse) => {
        summary.gateway = providerResponse.gatewaySummary ?? null;
        if (providerResponse.status >= 400 && !providerResponse.stream) {
          summary.errorCode = providerErrorCodeFromBody(providerResponse.body);
        }
      },
      onErrorCode: (errorCode) => {
        summary.errorCode = errorCode;
      },
    });
  }
  const providerResponse = await providerInvocation;
  summary.gateway = providerResponse.gatewaySummary ?? null;
  if (providerResponse.status >= 400 && !providerResponse.stream) {
    summary.errorCode = providerErrorCodeFromBody(providerResponse.body);
  }
  return Response.json(providerResponse.body, { status: providerResponse.status, headers: gatewayResponseHeaders(providerResponse.headers, { "x-request-id": requestId }) });
}

async function restrictPrincipalToHost<T extends { user: { id: string }; effectiveScopes: readonly string[] }>(
  principal: T,
  resolution: GatewayHostResolution,
  tenancyQueries: Pick<import("@frely/tenancy/server").TenancyQueries, "listAvailableMembershipsForUser">,
): Promise<T> {
  if (resolution.kind !== "domain") return principal;
  const { binding } = resolution;
  const memberships = (await tenancyQueries.listAvailableMembershipsForUser(principal.user.id)).map((membership) => membership.teamId);
  if (!binding.teamIds.some((teamId) => memberships.includes(teamId))) throw new RelayError("domain_binding_membership_forbidden", "This API key user is not a member of a Team allowed on this hostname", 403);
  return { ...principal, effectiveScopes: principal.effectiveScopes.filter((scope) => binding.teamIds.includes(scope.replace(/^team:/, ""))) };
}

function isBodyAdmissionErrorCode(value: string): value is BodyAdmissionErrorCode {
  return value === "gateway_capacity_exceeded"
    || value === "request_aborted"
    || value === "incomplete_request_body"
    || value === "invalid_content_length"
    || value === "request_body_too_large";
}

function endOutgoingResponse(response: import("node:http").ServerResponse, data?: string): Promise<void> {
  if (response.writableFinished || response.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = () => {
      response.off("finish", settle);
      response.off("close", settle);
      response.off("error", settle);
      resolve();
    };
    response.once("finish", settle);
    response.once("close", settle);
    response.once("error", settle);
    response.end(data);
  });
}

function toRequest(message: import("node:http").IncomingMessage, signal: AbortSignal): Request {
  const protocol = "http";
  const host = message.headers.host ?? `localhost:${config.gateway.port}`;
  const url = `${protocol}://${host}${message.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(","));
    else if (value !== undefined) headers.set(key, value);
  }
  const method = message.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal };
  if (method !== "GET" && method !== "HEAD") {
    init.body = message as unknown as BodyInit;
    init.duplex = "half";
  }
  return new Request(url, init);
}
