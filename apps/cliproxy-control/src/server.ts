import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CLIPROXY_CONTROL_PAYLOAD_MAX_BYTES } from "@frely/providers";
import { CpaManagementClient } from "./cpa.js";
import { loadCliProxyControlRuntimeConfig } from "./runtime-config.js";
import { CliProxyControlService } from "./service.js";
import { CredentialStore } from "./store.js";

const runtime = loadCliProxyControlRuntimeConfig();
const store = new CredentialStore(runtime.storePath, runtime.storeKey);
const cpa = new CpaManagementClient({
  baseUrl: runtime.baseUrl,
  managementKey: runtime.managementKey,
  inferenceKey: runtime.inferenceKey
});
const service = new CliProxyControlService(store, cpa, {
  oauthSessionTtlMs: runtime.oauthSessionTtlMs,
  cpaInstanceId: runtime.cpaInstanceId,
  ...(runtime.privateProviderOrigin ? { privateProviderOrigin: runtime.privateProviderOrigin } : {})
});

await service.initialize();

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const code = safeErrorCode(error);
    respond(response, statusForCode(code), { error: { code } });
  }
});

server.listen(runtime.port, "0.0.0.0");
let reconcileTimer: NodeJS.Timeout | undefined;
let stopping = false;
scheduleReconciliation(service.isReady() ? 60_000 : 10_000);

function scheduleReconciliation(delayMs: number): void {
  if (stopping) return;
  reconcileTimer = setTimeout(() => { void runScheduledReconciliation(); }, delayMs);
  reconcileTimer.unref();
}

async function runScheduledReconciliation(): Promise<void> {
  try {
    await service.reconcile();
  } catch {
    // Readiness carries the failure state; the next attempt stays on the fast cadence.
  } finally {
    scheduleReconciliation(service.isReady() ? 60_000 : 10_000);
  }
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://cliproxy-control");
  if (request.method === "GET" && url.pathname === "/healthz") {
    respond(response, service.isReady() ? 200 : 503, { status: service.isReady() ? "ok" : "not_ready" });
    return;
  }
  authorize(request);
  if (request.method === "GET" && url.pathname === "/v1/runtime") {
    respond(response, 200, service.runtimeIdentity());
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/readiness/credential-probes") {
    const report = await service.semanticReadiness();
    respond(response, 200, report);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/providers/reconcile") {
    const body = await readJson(request);
    const providerIds = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).providerIds : undefined;
    respond(response, 200, { items: await service.reconcileProviders(providerIds) });
    return;
  }
  const oauthMatch = /^\/v1\/providers\/([^/]+)\/oauth\/(start|callback|status)$/.exec(url.pathname);
  if (oauthMatch) {
    const providerId = decodeURIComponent(oauthMatch[1]!);
    const action = oauthMatch[2]!;
    if (action === "start" && request.method === "POST") {
      respond(response, 200, await service.startOAuth(providerId, await readJson(request)));
      return;
    }
    if (action === "callback" && request.method === "POST") {
      respond(response, 200, await service.submitOAuthCallback(providerId, await readJson(request)));
      return;
    }
    if (action === "status" && request.method === "GET") {
      respond(response, 200, await service.oauthStatus(providerId, url.searchParams.get("sessionId") ?? "", url.searchParams.get("actorId") ?? ""));
      return;
    }
    throw new Error("cliproxy_control_method_not_allowed");
  }
  const match = /^\/v1\/providers\/([^/]+)\/(credential|credential-import|catalog|reconcile)$/.exec(url.pathname);
  if (!match) throw new Error("cliproxy_control_route_not_found");
  const providerId = decodeURIComponent(match[1]!);
  const action = match[2]!;
  if (action === "credential" && request.method === "PUT") {
    respond(response, 200, await service.putCredential(providerId, await readJson(request)));
    return;
  }
  if (action === "credential-import" && request.method === "POST") {
    respond(response, 200, await service.importCredential(providerId, await readJson(request)));
    return;
  }
  if (action === "credential" && request.method === "GET") {
    const credential = await service.getCredential(providerId);
    if (!credential) throw new Error("cliproxy_credential_not_found");
    respond(response, 200, credential);
    return;
  }
  if (action === "credential" && request.method === "DELETE") {
    respond(response, 200, { providerId, deleted: await service.deleteCredential(providerId) });
    return;
  }
  if (action === "catalog" && request.method === "GET") {
    respond(response, 200, { providerId, models: await service.catalog(providerId) });
    return;
  }
  if (action === "reconcile" && request.method === "POST") {
    respond(response, 200, await service.reconcileProvider(providerId));
    return;
  }
  throw new Error("cliproxy_control_method_not_allowed");
}

function authorize(request: IncomingMessage): void {
  const value = request.headers.authorization;
  if (value !== `Bearer ${runtime.controlKey}`) throw new Error("cliproxy_control_unauthorized");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > CLIPROXY_CONTROL_PAYLOAD_MAX_BYTES) throw new Error("cliproxy_control_request_too_large");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("cliproxy_control_request_invalid");
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > CLIPROXY_CONTROL_PAYLOAD_MAX_BYTES) throw new Error("cliproxy_control_response_too_large");
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store" });
  response.end(encoded);
}

function statusForCode(code: string): number {
  if (code === "cliproxy_control_unauthorized") return 401;
  if (code === "cliproxy_credential_not_found" || code === "cliproxy_control_route_not_found") return 404;
  if (code === "cliproxy_control_method_not_allowed") return 405;
  if (code === "cliproxy_base_url_not_allowed") return 400;
  if (code.endsWith("_invalid") || code.endsWith("_required") || code === "cliproxy_kind_unsupported" || code === "cliproxy_auth_method_unsupported") return 400;
  return 503;
}

function safeErrorCode(error: unknown): string {
  const relayCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const candidate = typeof relayCode === "string"
    ? relayCode
    : error instanceof Error ? error.message : "cliproxy_control_error";
  if (candidate === "invalid_provider_url") return "cliproxy_base_url_invalid";
  if (candidate === "provider_url_not_allowed") return "cliproxy_base_url_not_allowed";
  return /^cliproxy_[a-z0-9_]{1,96}$/.test(candidate) ? candidate : "cliproxy_control_error";
}

function shutdown(): void {
  stopping = true;
  if (reconcileTimer) clearTimeout(reconcileTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
