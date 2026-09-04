import {
  assertPasskeyRequest,
  authCookieHeaders,
  clearLandingRegistrationEntryCookieHeaders,
  clearPasskeyCeremonyCookie,
  createPasskeyCeremonyCookie,
  hashPasskeySecret,
  passkeyCeremonyCookie,
  passwordChangeRateLimitSubjects,
  readStrictPasskeyJson,
  strictPasskeyObject
} from "@frely/auth";
import type { AppConfig } from "@frely/config";
import { RelayError } from "@frely/core";
import type { AsyncApplicationOperationPort } from "@frely/application/runtime";
import type { AsyncAbuseGuard } from "./abuse-guard.js";
import type { AsyncControlPlaneTenancyService } from "@frely/application/server";

export type PasskeyHttpSurface = "web" | "owner";

export type AsyncPasskeyApplicationOperationPort = Pick<AsyncApplicationOperationPort,
  | "consumeAbuseRateLimits"
  | "consumeAbuseRateLimit"
  | "listPasskeyCredentials"
>;

export interface PasskeyHttpContext {
  asyncTenancy: AsyncControlPlaneTenancyService;
  asyncRepo: AsyncPasskeyApplicationOperationPort;
  asyncAbuseGuard: AsyncAbuseGuard;
  config: AppConfig;
  surface: PasskeyHttpSurface;
  requestId: string;
}

export async function passkeyAuthenticationOptionsResponse(request: Request, context: PasskeyHttpContext): Promise<Response> {
  return passkeyAuthenticationOptionsResponseAsync(request, context);
}

export async function passkeyAuthenticationVerifyResponse(request: Request, context: PasskeyHttpContext): Promise<Response> {
  return passkeyAuthenticationVerifyResponseAsync(request, context);
}

export function passkeyListResponse(request: Request, context: PasskeyHttpContext): Promise<Response> {
  return passkeyListResponseAsync(request, context);
}

export async function passkeyRegistrationOptionsResponse(request: Request, context: PasskeyHttpContext): Promise<Response> {
  return passkeyRegistrationOptionsResponseAsync(request, context);
}

export async function passkeyRegistrationVerifyResponse(request: Request, context: PasskeyHttpContext): Promise<Response> {
  return passkeyRegistrationVerifyResponseAsync(request, context);
}

export async function passkeyRenameResponse(request: Request, context: PasskeyHttpContext, passkeyId: string): Promise<Response> {
  return passkeyRenameResponseAsync(request, context, passkeyId);
}

export async function passkeyDeleteResponse(request: Request, context: PasskeyHttpContext, passkeyId: string): Promise<Response> {
  return passkeyDeleteResponseAsync(request, context, passkeyId);
}

type AsyncPasskeyContext = PasskeyHttpContext;

async function passkeyAuthenticationOptionsResponseAsync(request: Request, context: AsyncPasskeyContext): Promise<Response> {
  const protocolSurface = protocolSurfaceFor(context.surface);
  assertPasskeyRequest(request, context.config, protocolSurface);
  const guardContext = { routePattern: "/api/auth/passkey/options", requestId: context.requestId };
  await context.asyncAbuseGuard.consume("auth.login.attempt", request.headers, guardContext);
  await context.asyncAbuseGuard.assertNotBlocked("auth.login.failed", request.headers, guardContext);
  const cookie = createPasskeyCeremonyCookie(context.config, protocolSurface, "authentication");
  const options = await context.asyncTenancy.beginPasskeyAuthentication({ surface: asyncSurface(context), sessionHash: cookie.hash });
  return jsonWithCookies({ options }, [cookie.setCookie]);
}

async function passkeyAuthenticationVerifyResponseAsync(request: Request, context: AsyncPasskeyContext): Promise<Response> {
  const protocolSurface = protocolSurfaceFor(context.surface);
  assertPasskeyRequest(request, context.config, protocolSurface);
  const guardContext = { routePattern: "/api/auth/passkey/verify", requestId: context.requestId };
  await context.asyncAbuseGuard.assertNotBlocked("auth.login.failed", request.headers, guardContext);
  const rawCookie = passkeyCeremonyCookie(request.headers, protocolSurface, "authentication");
  if (!rawCookie) throw invalidCredentials();
  const ceremony = await context.asyncTenancy.consumePasskeyCeremony({
    surface: asyncSurface(context),
    purpose: "authentication",
    sessionHash: hashPasskeySecret(rawCookie),
  });
  const body = await readStrictPasskeyJson(request, 65_536, (value) => {
    const record = strictPasskeyObject(value, ["response"]);
    return { response: record.response };
  });
  let session;
  try {
    session = await context.asyncTenancy.completePasskeyAuthentication({
      surface: asyncSurface(context),
      ceremony,
      response: body.response,
      requestId: context.requestId,
    });
  } catch (error) {
    if (error instanceof RelayError && error.code === "invalid_credentials") {
      await context.asyncAbuseGuard.consume("auth.login.failed", request.headers, guardContext);
    }
    throw error;
  }
  const cookies = [
    ...authCookieHeaders(context.config, context.surface, session),
    clearPasskeyCeremonyCookie(context.config, protocolSurface, "authentication"),
  ];
  if (context.surface === "web") cookies.push(...clearLandingRegistrationEntryCookieHeaders(context.config));
  return jsonWithCookies({ user: session.user }, cookies);
}

async function passkeyListResponseAsync(request: Request, context: AsyncPasskeyContext): Promise<Response> {
  const protocolSurface = protocolSurfaceFor(context.surface);
  const surfaceConfig = assertPasskeyRequest(request, context.config, protocolSurface, { requireOrigin: false });
  const claims = await asyncCurrentClaims(context, request.headers);
  await consumePasskeyManagementReadAsync(context, request.headers, claims.sub);
  const passkeys = await context.asyncTenancy.listPasskeys({
    userId: claims.sub,
    expectedAuthVersion: claims.authVersion,
    surface: asyncSurface(context),
    requestId: context.requestId,
  });
  const canAdd = passkeys.length < 20 && (await context.asyncRepo.listPasskeyCredentials(claims.sub, surfaceConfig.rpId)).length < 10;
  return jsonWithCookies({ passkeys, canAdd });
}

async function passkeyRegistrationOptionsResponseAsync(request: Request, context: AsyncPasskeyContext): Promise<Response> {
  const protocolSurface = protocolSurfaceFor(context.surface);
  assertPasskeyRequest(request, context.config, protocolSurface);
  const claims = await asyncCurrentClaims(context, request.headers);
  await consumePasskeySensitiveManagementAsync(context, request.headers, claims.sub);
  const body = await readStrictPasskeyJson(request, 4096, (value) => {
    const record = strictPasskeyObject(value, ["currentPassword", "name"]);
    return { currentPassword: requiredPassword(record.currentPassword), name: requiredString(record.name) };
  });
  const cookie = createPasskeyCeremonyCookie(context.config, protocolSurface, "registration");
  const options = await context.asyncTenancy.beginPasskeyRegistration({
    userId: claims.sub,
    expectedAuthVersion: claims.authVersion,
    surface: asyncSurface(context),
    currentPassword: body.currentPassword,
    name: body.name,
    sessionHash: cookie.hash,
  });
  return jsonWithCookies({ options }, [cookie.setCookie]);
}

async function passkeyRegistrationVerifyResponseAsync(request: Request, context: AsyncPasskeyContext): Promise<Response> {
  const protocolSurface = protocolSurfaceFor(context.surface);
  assertPasskeyRequest(request, context.config, protocolSurface);
  const rawCookie = passkeyCeremonyCookie(request.headers, protocolSurface, "registration");
  if (!rawCookie) throw new RelayError("passkey_ceremony_invalid", "Passkey ceremony is invalid", 400);
  const ceremony = await context.asyncTenancy.consumePasskeyCeremony({
    surface: asyncSurface(context),
    purpose: "registration",
    sessionHash: hashPasskeySecret(rawCookie),
  });
  const body = await readStrictPasskeyJson(request, 131_072, (value) => {
    const record = strictPasskeyObject(value, ["response"]);
    return { response: record.response };
  });
  const claims = await asyncCurrentClaims(context, request.headers);
  const passkey = await context.asyncTenancy.completePasskeyRegistration({
    userId: claims.sub,
    expectedAuthVersion: claims.authVersion,
    surface: asyncSurface(context),
    ceremony,
    response: body.response,
    requestId: context.requestId,
  });
  return jsonWithCookies({ passkey }, [clearPasskeyCeremonyCookie(context.config, protocolSurface, "registration")]);
}

async function passkeyRenameResponseAsync(request: Request, context: AsyncPasskeyContext, passkeyId: string): Promise<Response> {
  const protocolSurface = protocolSurfaceFor(context.surface);
  assertPasskeyRequest(request, context.config, protocolSurface);
  const claims = await asyncCurrentClaims(context, request.headers);
  await consumePasskeyManagementReadAsync(context, request.headers, claims.sub);
  const body = await readStrictPasskeyJson(request, 4096, (value) => {
    const record = strictPasskeyObject(value, ["name"]);
    return { name: requiredString(record.name) };
  });
  const passkey = await context.asyncTenancy.renamePasskey({
    userId: claims.sub,
    expectedAuthVersion: claims.authVersion,
    surface: asyncSurface(context),
    passkeyId: requiredPasskeyId(passkeyId),
    name: body.name,
    requestId: context.requestId,
  });
  return jsonWithCookies({ passkey });
}

async function passkeyDeleteResponseAsync(request: Request, context: AsyncPasskeyContext, passkeyId: string): Promise<Response> {
  const protocolSurface = protocolSurfaceFor(context.surface);
  assertPasskeyRequest(request, context.config, protocolSurface);
  const claims = await asyncCurrentClaims(context, request.headers);
  await consumePasskeySensitiveManagementAsync(context, request.headers, claims.sub);
  const body = await readStrictPasskeyJson(request, 4096, (value) => {
    const record = strictPasskeyObject(value, ["currentPassword"]);
    return { currentPassword: requiredPassword(record.currentPassword) };
  });
  const session = await context.asyncTenancy.deletePasskey({
    userId: claims.sub,
    expectedAuthVersion: claims.authVersion,
    surface: asyncSurface(context),
    passkeyId: requiredPasskeyId(passkeyId),
    currentPassword: body.currentPassword,
    requestId: context.requestId,
  });
  return jsonWithCookies(
    { deleted: true, otherSessionsRevoked: true },
    authCookieHeaders(context.config, context.surface, session),
  );
}

function asyncSurface(context: AsyncPasskeyContext): "owner" | "web" {
  return context.surface === "owner" ? "owner" : "web";
}

async function asyncCurrentClaims(context: AsyncPasskeyContext, headers: Headers) {
  return context.surface === "owner"
    ? context.asyncTenancy.requireCookieOwner(headers)
    : context.asyncTenancy.requireCookieUser(headers);
}

async function consumePasskeySensitiveManagementAsync(context: AsyncPasskeyContext, headers: Headers, userId: string): Promise<void> {
  const subjects = passwordChangeRateLimitSubjects(context.config, headers, userId);
  const decision = await context.asyncRepo.consumeAbuseRateLimits({
    rules: [
      { id: "user", bucket: "passkey.sensitive.user", subjectHashes: [subjects.user], limit: 5, windowSeconds: 900 },
      { id: "client_ip", bucket: "passkey.sensitive.client_ip", subjectHashes: [subjects.clientIp], limit: 20, windowSeconds: 900 },
    ],
  });
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
}

async function consumePasskeyManagementReadAsync(context: AsyncPasskeyContext, headers: Headers, userId: string): Promise<void> {
  const subject = passwordChangeRateLimitSubjects(context.config, headers, userId).user;
  const decision = await context.asyncRepo.consumeAbuseRateLimit({
    bucket: "passkey.management.user",
    subjectHashes: [subject],
    limit: 120,
    windowSeconds: 900,
  });
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
}

function jsonWithCookies(data: unknown, cookies: string[] = []): Response {
  const response = Response.json(data, { headers: { "cache-control": "no-store" } });
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw invalidBody();
  return value;
}

function requiredPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > 256) throw invalidBody();
  return value;
}

function requiredPasskeyId(value: string): string {
  if (!/^passkey_[0-9a-f]{24}$/u.test(value)) throw new RelayError("passkey_not_found", "Passkey not found", 404);
  return value;
}

function protocolSurfaceFor(surface: PasskeyHttpSurface): "web" | "admin" {
  return surface === "owner" ? "admin" : "web";
}

function abuseSourceFor(surface: PasskeyHttpSurface): "web" | "admin" {
  return surface === "owner" ? "admin" : "web";
}

function invalidBody(): RelayError {
  return new RelayError("invalid_request_body", "Request body is invalid", 400);
}

function invalidCredentials(): RelayError {
  return new RelayError("invalid_credentials", "Invalid credentials", 401);
}

function rateLimited(retryAfterSeconds: number): RelayError {
  const error = new RelayError("rate_limited", "Too many requests", 429) as RelayError & { retryAfterSeconds: number };
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}
