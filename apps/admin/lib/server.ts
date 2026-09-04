import { AsyncLocalStorage } from "node:async_hooks";
import { loadConfig, loadConfigSync, type AppConfig } from "@frely/config";
import { type AccessTokenClaims } from "@frely/auth";
import { archiveReadRemoteFromConfig, openRequestCaptureStoreForConfig, openUiApplicationBoundary, RequestCaptureReader, RequestLogArchiveReader, type UiApplicationBoundary } from "@frely/ui-application/server";
import { errorPayload, errorStatus, readBoundedRequestText, RelayError, requestIdFromHeaders, resolveExternalRequestOrigin } from "@frely/core";
import { AsyncAccessResolutionService, AsyncPricingService, createPostgresGatewayPolicyGuards } from "@frely/gateway-core";
import { AsyncExternalPricingService } from "@frely/pricing";
import { adminRequestHeaders } from "../src/server/request";
import { createAsyncAbuseGuard } from "@frely/tenancy";
import { createRetryablePromiseCache } from "./retryable-promise-cache";

export async function services() {
  const requestScoped = requestServices.getStore();
  if (requestScoped) return requestScoped;
  const config = await loadConfig();
  return servicesForConfig(config);
}

async function servicesForConfig(config: AppConfig) {
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
      source: "admin",
    }),
    asyncAccessResolution: new AsyncAccessResolutionService(application.queries, policyGuards, application.modelAccessRoutingQueries),
    asyncPricing: new AsyncPricingService(application.billingQueries),
    asyncExternalPricing: new AsyncExternalPricingService(application.billingQueries),
  };
}

type AppServices = Awaited<ReturnType<typeof servicesForConfig>>;

const requestServices = new AsyncLocalStorage<AppServices>();
const sharedApplication = createRetryablePromiseCache<UiApplicationBoundary>();

async function applicationBoundary(config: AppConfig): Promise<UiApplicationBoundary> {
  return sharedApplication.get(() => openUiApplicationBoundary({ backend: "postgres", environment: process.env, config }));
}

export async function adminPageServices() {
  const session = await adminPageSession();
  if (!session) return null;
  return { ...session.appServices, claims: session.claims };
}

export async function adminPageConfig() {
  return (await adminPageSession())?.config ?? null;
}

export async function adminPageSessionIdentity() {
  const session = await adminPageSession();
  return session ? { userId: session.claims.sub, expiresAtEpochSeconds: session.claims.exp } : null;
}

export async function adminPublicAuthContext(): Promise<{ environment: string }> {
  try {
    const config = loadConfigSync();
    return { environment: config.app.environment };
  } catch {
    return { environment: process.env.NODE_ENV ?? "development" };
  }
}

export async function adminRootSessionProjection() {
  let config: AppConfig;
  try {
    config = loadConfigSync();
  } catch {
    return {
      authContext: { environment: process.env.NODE_ENV ?? "development" },
      environment: process.env.NODE_ENV ?? "development",
      ownerAuthorized: false,
      sessionIdentity: null,
    };
  }

  const authContext = { environment: config.app.environment };
  try {
    const appServices = await servicesForConfig(config);
    const claims = await appServices.asyncTenancy.requireOwner(adminRequestHeaders());
    return {
      authContext,
      environment: config.app.environment,
      ownerAuthorized: true,
      sessionIdentity: { userId: claims.sub, expiresAtEpochSeconds: claims.exp },
    };
  } catch {
    return {
      authContext,
      environment: config.app.environment,
      ownerAuthorized: false,
      sessionIdentity: null,
    };
  }
}

async function adminPageSession(): Promise<{
  config: AppConfig;
  claims: AccessTokenClaims;
  appServices: Awaited<ReturnType<typeof servicesForConfig>>;
} | null> {
  try {
    const config = loadConfigSync();
    const appServices = await servicesForConfig(config);
    const claims = await appServices.asyncTenancy.requireOwner(adminRequestHeaders());
    return { config, claims, appServices };
  } catch {
    return null;
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function handle(
  request: Request,
  action: () => Promise<Response> | Response,
  options: { passwordChangeSafeErrors?: boolean } = {}
): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  try {
    const appServices = await servicesForConfig(await loadConfig());
    return await requestServices.run(appServices, async () => {
      const response = await action();
      response.headers.set("x-request-id", requestId);
      return response;
    });
  } catch (error) {
    const safeError = options.passwordChangeSafeErrors && !(error instanceof RelayError)
      ? new RelayError("internal_error", "Password change failed", 500)
      : error;
    const retryAfterSeconds = safeError instanceof RelayError && "retryAfterSeconds" in safeError
      ? Number((safeError as RelayError & { retryAfterSeconds: number }).retryAfterSeconds)
      : null;
    return Response.json(errorPayload(safeError, requestId), {
      status: errorStatus(safeError),
      headers: { "x-request-id": requestId, ...(retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {}) }
    });
  }
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
