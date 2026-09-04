import { AsyncLocalStorage } from "node:async_hooks";
import { loadConfig, type AppConfig } from "@frely/config";
import { archiveReadRemoteFromConfig, openRequestCaptureStoreForConfig, openUiApplicationBoundary, RequestCaptureReader, RequestLogArchiveReader, type UiApplicationBoundary } from "@frely/ui-application/server";
import { errorPayload, errorStatus, readBoundedRequestText, RelayError, requestIdFromHeaders, resolveExternalRequestOrigin } from "@frely/core";
import { AsyncAccessResolutionService, AsyncPricingService, createPostgresGatewayPolicyGuards } from "@frely/gateway-core";
import { createAsyncAbuseGuard } from "@frely/tenancy";
import { resolveWebHostScopeAsync, type WebHostScope } from "./domain-binding";

async function createServices() {
  const config = await loadConfig();
  const application = await applicationBoundary(config);
  const requestCaptureClient = openRequestCaptureStoreForConfig(config);
  const requestCaptureReader = new RequestCaptureReader(requestCaptureClient.repo);
  const requestLogArchiveReader = new RequestLogArchiveReader(
    application.queries,
    archiveReadRemoteFromConfig(config.archive.directory, config.archive.coldDirectory),
  );
  const authorityEntitlement = application.authorityEntitlement;
  const policyGuards = createPostgresGatewayPolicyGuards(application.queries, authorityEntitlement.entitlement);
  return {
    config,
    application,
    requestCaptureClient,
    requestCaptureReader,
    requestLogArchiveReader,
    asyncTenancy: application.identityTenancy,
    authorityEntitlement,
    billingCommerce: application.billingCommerce,
    asyncAbuseGuard: createAsyncAbuseGuard({
      queries: application.queries,
      commands: application.commands,
      config,
      source: "web",
    }),
    asyncAccessResolution: new AsyncAccessResolutionService(application.queries, policyGuards, application.modelAccessRoutingQueries),
    asyncPricing: new AsyncPricingService(application.billingQueries),
  };
}

type AppServices = Awaited<ReturnType<typeof createServices>>;
export type WebAppServices = AppServices;

const requestServices = new AsyncLocalStorage<AppServices>();
let sharedApplication: UiApplicationBoundary | undefined;

async function applicationBoundary(config: AppConfig): Promise<UiApplicationBoundary> {
  if (sharedApplication) return sharedApplication;
  sharedApplication = await openUiApplicationBoundary({ backend: "postgres", environment: process.env, config });
  return sharedApplication;
}

export async function services() {
  return requestServices.getStore() ?? createServices();
}

export async function withWebRequestServices<T>(
  work: (appServices: WebAppServices) => Promise<T> | T,
): Promise<T> {
  const current = requestServices.getStore();
  if (current) return work(current);
  const created = await createServices();
  return requestServices.run(created, () => work(created));
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export interface WebRequestContext {
  hostScope: WebHostScope;
}

export async function handle(
  request: Request,
  action: (context: WebRequestContext) => Promise<Response> | Response,
  options: { passwordChangeHostBoundary?: boolean; passwordChangeSafeErrors?: boolean } = {}
): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  try {
    // Host is an authorization boundary. Resolve it before any route authenticates or parses a body.
    return await withWebRequestServices(async (appServices) => {
      const { config, application } = appServices!;
      let hostScope: WebHostScope;
      try {
        hostScope = await resolveWebHostScopeAsync(application.queries, config, request.headers);
      } catch (error) {
        if (options.passwordChangeHostBoundary && isWebHostBoundaryError(error)) {
          throw new RelayError("request_origin_forbidden", "Request origin is not allowed", 403);
        }
        throw error;
      }
      const response = await action({ hostScope });
      response.headers.set("x-request-id", requestId);
      if (new URL(request.url).pathname.startsWith("/api/invite-links/")) response.headers.set("referrer-policy", "no-referrer");
      return response;
    });
  } catch (error) {
    const safeError = options.passwordChangeSafeErrors && !(error instanceof RelayError)
      ? new RelayError("internal_error", "Password change failed", 500)
      : error;
    const retryAfterSeconds = safeError instanceof RelayError && "retryAfterSeconds" in safeError
      ? Number((safeError as RelayError & { retryAfterSeconds: number }).retryAfterSeconds)
      : null;
    const response = Response.json(errorPayload(safeError, requestId), {
      status: errorStatus(safeError),
      headers: { "x-request-id": requestId, ...(retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {}) }
    });
    if (new URL(request.url).pathname.startsWith("/api/invite-links/")) response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
}

function isWebHostBoundaryError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && ["host_required", "host_invalid", "host_not_allowed", "domain_binding_not_active"].includes(error.code)
  );
}

export async function bodyJson<T>(request: Request, maxBytes = 1_048_576): Promise<T> {
  const raw = await readBoundedRequestText(request, maxBytes);
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

export function assertProductionHttps(request: Request, config: AppConfig, operation = "This operation"): void {
  if (config.app.environment !== "production") return;
  const externalOrigin = resolveExternalRequestOrigin(request);
  if (externalOrigin && new URL(externalOrigin).protocol === "https:") return;
  throw new RelayError("https_required", `${operation} requires HTTPS in production.`, 400);
}
