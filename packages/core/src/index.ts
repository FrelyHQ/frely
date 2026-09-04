import { lookup } from "node:dns/promises";
import { BlockList, isIP, SocketAddress } from "node:net";

export * from "./access-point-selectors.js";
export * from "./access-point-request-overrides.js";

export type RuntimeEnvironment = "development" | "production" | "test";
export type Status = "enabled" | "disabled" | "revoked";
export type PlatformRole = "owner";
export type UserRoleBindingRole = PlatformRole;
export type UserRoleBindingStatus = "enabled" | "disabled";
export type TeamRole = `owner:${string}`;
export type AuthorityRoleDomain = "platform";
export type AuthorityRoleCode = "owner" | "creator";
export type AuthorityCapabilityCode = "platform.owner.manage" | "platform.team.manage:any" | "team.create";
export type AuthorityProductEffectCode = "team_create_unit" | "team_custom_provider_access" | "user_custom_provider_access";
export type AuthorityProductLifecycle = "draft" | "listed" | "closed";
export type AuthorityRefundMode = "none" | "unused_by_owner";
export type AuthorityGrantSourceKind = "product_purchase" | "system_bootstrap" | "control_snapshot";
export type AuthorityGrantLifecycle = "active" | "canceled";

export const AUTHORITY_CAPABILITY_CATALOG = {
  "platform.owner.manage": { applicableDomains: ["platform"], allowedRoles: ["owner"], sensitive: true, quotaKind: null },
  "platform.team.manage:any": { applicableDomains: ["platform", "team"], allowedRoles: ["owner"], sensitive: true, quotaKind: null },
  "team.create": { applicableDomains: ["platform", "team"], allowedRoles: ["creator"], sensitive: false, quotaKind: "units" }
} as const satisfies Record<AuthorityCapabilityCode, {
  applicableDomains: readonly ("platform" | "team")[];
  allowedRoles: readonly AuthorityRoleCode[];
  sensitive: boolean;
  quotaKind: "units" | null;
}>;

export const AUTHORITY_PRODUCT_LIMITS = {
  maxPurchaseAmountUnits: Number.MAX_SAFE_INTEGER,
  maxGrantUnits: 1_000,
  maxGrantDurationSeconds: 315_360_000,
  maxSettlementHoldSeconds: 31_536_000,
  maxPurchaseOrUnconsumedLimit: 1_000_000,
  maxTeamLimit: 1_000
} as const;

export const AUTHORITY_CANCEL_REASON_CODES = ["security_response", "fraud", "product_correction", "operator_error", "refund"] as const;
export type AuthorityCancelReasonCode = (typeof AUTHORITY_CANCEL_REASON_CODES)[number];
export const AUTHORITY_REFUND_REASON_CODES = ["customer_request", "duplicate_purchase", "product_correction", "operator_error"] as const;
export type AuthorityRefundReasonCode = (typeof AUTHORITY_REFUND_REASON_CODES)[number];

export function authorityRoleAllows(role: AuthorityRoleCode, capability: AuthorityCapabilityCode): boolean {
  return (AUTHORITY_CAPABILITY_CATALOG[capability].allowedRoles as readonly AuthorityRoleCode[]).includes(role);
}
export type ScopeType = "global" | "team" | "user" | "api_key";
export type ScopeRef = "global:" | `team:${string}` | `user:${string}` | `key:${string}`;
export type AccessPointTargetType = "provider-model" | "access-point";

const EXTERNAL_EVIDENCE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/u;
const SECRET_SHAPED_EVIDENCE_REF_PATTERNS = [
  /^(?:bearer|basic)[_.:/-]/iu,
  /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}$/u,
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}$/u,
  /^(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza|AKIA|ASIA|whsec_)[A-Za-z0-9_-]{8,}$/u,
  /^(?:ya29\.|1\/\/)[A-Za-z0-9_.-]{8,}$/u,
  /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u,
  /^(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|credential|authorization)[:=_-][A-Za-z0-9_.:/-]{8,}$/iu,
  /^(?:begin[_-])?(?:rsa[_-]|ec[_-])?private[_-]key[:=_-]/iu,
] as const;

export function isSafeExternalEvidenceRef(value: unknown): value is string {
  return typeof value === "string"
    && EXTERNAL_EVIDENCE_REF_PATTERN.test(value)
    && !SECRET_SHAPED_EVIDENCE_REF_PATTERNS.some((pattern) => pattern.test(value));
}
export const RESOLVER_FUNCTION_NAMES = ["literal", "request", "principal", "exposed", "provider", "url", "cliproxyapi", "api-key", "oauth", "identity"] as const;
export type ResolverName = (typeof RESOLVER_FUNCTION_NAMES)[number];
export type ResolverContext = "baseUrl" | "credential" | "model" | "tarModel" | "models";

export const RESOLVER_FUNCTIONS_BY_CONTEXT = {
  baseUrl: ["literal"],
  credential: ["api-key", "oauth", "identity"],
  model: ["literal", "request", "principal"],
  tarModel: ["literal", "request", "principal"],
  models: ["literal", "provider", "url", "cliproxyapi"]
} as const satisfies Record<ResolverContext, readonly ResolverName[]>;

export const RESOLVER_REGISTRY = {
  literal: { contexts: ["baseUrl", "model", "tarModel", "models"] },
  request: { contexts: ["model", "tarModel"] },
  principal: { contexts: ["model", "tarModel"] },
  exposed: { contexts: [] },
  provider: { contexts: ["models"] },
  url: { contexts: ["models"] },
  cliproxyapi: { contexts: ["models"] },
  "api-key": { contexts: ["credential"] },
  oauth: { contexts: ["credential"] },
  identity: { contexts: ["credential"] }
} as const satisfies Record<ResolverName, { contexts: readonly ResolverContext[] }>;

export interface ErrorPayload {
  error: { code: string; message: string; requestId: string } & Record<string, unknown>;
}

export interface ProviderFetchDiagnosticV1 {
  version: 1;
  stage: "response_headers" | "stream_read";
  transport: "sse" | "websocket";
  continuationMode?: "delta" | "full-context" | "sse-fallback";
  causeCode?: string;
  retryable: boolean;
  eventsReceived: number;
}

export const PROVIDER_FETCH_DIAGNOSTIC_MAX_EVENTS = 1_000_000;

export function parseProviderFetchDiagnostic(value: unknown): ProviderFetchDiagnosticV1 | null {
  if (!isPlainDataRecord(value)) return null;
  const allowedKeys = new Set(["version", "stage", "transport", "continuationMode", "causeCode", "retryable", "eventsReceived"]);
  let keys: string[];
  try { keys = Object.keys(value); } catch { return null; }
  if (keys.some((key) => !allowedKeys.has(key))) return null;

  const version = ownDataProperty(value, "version");
  const stage = ownDataProperty(value, "stage");
  const transport = ownDataProperty(value, "transport");
  const continuationMode = ownDataProperty(value, "continuationMode");
  const causeCode = ownDataProperty(value, "causeCode");
  const retryable = ownDataProperty(value, "retryable");
  const eventsReceived = ownDataProperty(value, "eventsReceived");
  if (
    version !== 1
    || (stage !== "response_headers" && stage !== "stream_read")
    || (transport !== "sse" && transport !== "websocket")
    || (continuationMode !== undefined && continuationMode !== "delta" && continuationMode !== "full-context" && continuationMode !== "sse-fallback")
    || (causeCode !== undefined && !isProviderFetchCauseCode(causeCode))
    || typeof retryable !== "boolean"
    || !Number.isSafeInteger(eventsReceived)
    || (eventsReceived as number) < 0
    || (eventsReceived as number) > PROVIDER_FETCH_DIAGNOSTIC_MAX_EVENTS
    || (stage === "response_headers" && eventsReceived !== 0)
  ) return null;

  return {
    version: 1,
    stage,
    transport,
    ...(continuationMode === undefined ? {} : { continuationMode }),
    ...(causeCode === undefined ? {} : { causeCode }),
    retryable,
    eventsReceived: eventsReceived as number
  };
}

export function providerFetchCauseCode(error: unknown): string | undefined {
  if (!isObjectLike(error)) return undefined;
  const cause = ownDataProperty(error, "cause");
  const nested = isObjectLike(cause) ? ownDataProperty(cause, "code") : undefined;
  if (isProviderFetchCauseCode(nested)) return nested;
  const topLevel = ownDataProperty(error, "code");
  return isProviderFetchCauseCode(topLevel) ? topLevel : undefined;
}

function isProviderFetchCauseCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

function ownDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!isObjectLike(value) || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export class RelayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, status = 400, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${suffix}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function parseJsonText<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Resolve the externally visible origin for a request at the supported proxy
 * boundary. The standard Host header remains authoritative; forwarded Host is
 * deliberately ignored. A forwarded protocol is only accepted when it is one
 * unambiguous, exact value.
 */
export function resolveExternalRequestOrigin(request: Request): string | null {
  return resolveExternalOriginFromHeaders(request.headers, request.url);
}

/**
 * Header-only form used by consumers that already have a request URL fallback.
 * Without a fallback URL, a request with no forwarded protocol cannot prove a
 * direct transport origin and therefore returns null.
 */
export function resolveExternalOriginFromHeaders(headers: Headers, directUrl?: string): string | null {
  const forwardedProtocol = headers.get("x-forwarded-proto");
  if (forwardedProtocol !== null) {
    if (forwardedProtocol !== "http" && forwardedProtocol !== "https") return null;
    const host = headers.get("host");
    if (!host || /[,/?#\\@\s]/u.test(host)) return null;
    return serializedOrigin(`${forwardedProtocol}://${host}`);
  }
  if (directUrl === undefined) return null;
  return serializedOrigin(directUrl);
}

function serializedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || url.origin === "null"
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function requestIdFromHeaders(headers: Headers): string {
  const requestId = headers.get("x-request-id");
  return requestId !== null && isSafeRequestId(requestId) ? requestId : createId("req");
}

export function isSafeRequestId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/.test(value);
}

export function errorPayload(error: unknown, requestId: string): ErrorPayload {
  if (error instanceof RelayError) {
    return { error: { ...error.details, code: error.code, message: error.message, requestId } };
  }
  return { error: { code: "internal_error", message: "Unexpected error", requestId } };
}

export function errorStatus(error: unknown): number {
  return error instanceof RelayError ? error.status : 500;
}

export async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be a positive safe integer");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declaredLength)) {
      throw new RelayError("invalid_content_length", "Content-Length must be a non-negative decimal integer", 400);
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      throw new RelayError("invalid_content_length", "Content-Length exceeds the supported range", 400);
    }
    if (parsedLength > maxBytes) throw new RelayError("request_body_too_large", "Request body is too large", 413);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RelayError("request_body_too_large", "Request body is too large", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError("invalid_request_body", "Request body could not be read", 400);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedRequestBody(request, maxBytes));
}

export async function readBoundedRequestFormData(request: Request, maxBytes: number): Promise<FormData> {
  const bytes = await readBoundedRequestBody(request, maxBytes);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  try {
    return await new Request(request.url, { method: request.method, headers, body: bytes.buffer as ArrayBuffer }).formData();
  } catch {
    throw new RelayError("invalid_form_data", "Request body must contain valid multipart form data", 400);
  }
}

export function matchesImageContentType(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  if (contentType === "image/webp") {
    return bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  return false;
}

export interface PublicProviderUrlResolution {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type PublicProviderUrlLookup = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<readonly { address: string; family: number }[]>;

export interface ConfiguredPrivateProviderOrigin {
  origin: string;
  hostname: string;
  port: number;
}

export type ProviderBaseUrlClassification = "public_https" | "configured_private" | "rejected";

export interface ProviderBaseUrlValidationResult {
  classification: ProviderBaseUrlClassification;
  rejectionCode?: "invalid_provider_url" | "provider_url_not_allowed";
}

export interface ProviderBaseUrlValidationOptions {
  privateOrigin?: string | undefined;
  resolve?: PublicProviderUrlLookup | undefined;
}

export async function resolvePublicProviderUrl(
  value: string,
  resolve: PublicProviderUrlLookup = lookup
): Promise<PublicProviderUrlResolution> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayError("invalid_provider_url", "Provider URL is invalid", 400);
  }
  if (url.protocol !== "https:") {
    throw new RelayError("provider_url_not_allowed", "Provider URL must use HTTPS", 400);
  }
  if (url.username || url.password || url.hash) {
    throw new RelayError("provider_url_not_allowed", "Provider URL cannot contain credentials or a fragment", 400);
  }
  const hostname = normalizedUrlHostname(url);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new RelayError("provider_url_not_allowed", "Provider URL cannot target localhost", 400);
  }
  const directFamily = isIP(hostname);
  let addresses: readonly { address: string; family: number }[];
  if (directFamily) {
    addresses = [{ address: hostname, family: directFamily }];
  } else {
    try {
      addresses = await resolve(hostname, { all: true, verbatim: true });
    } catch {
      throw new RelayError("provider_url_not_allowed", "Provider URL could not be resolved", 400);
    }
  }
  if (
    addresses.length === 0
    || addresses.some(({ address, family }) => (
      (family !== 4 && family !== 6)
      || isIP(address) !== family
      || !isPublicProviderAddress(address)
    ))
  ) {
    throw new RelayError("provider_url_not_allowed", "Provider URL cannot resolve to an internal network address", 400);
  }
  const selected = addresses[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export async function assertPublicProviderUrl(value: string): Promise<void> {
  await resolvePublicProviderUrl(value);
}

export function parseConfiguredPrivateProviderOrigin(value: string): ConfiguredPrivateProviderOrigin {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayError("provider_private_origin_invalid", "Configured private Provider origin is invalid", 400);
  }
  const hostname = normalizedUrlHostname(url);
  const family = isIP(hostname);
  const port = Number(url.port);
  if (
    url.protocol !== "http:"
    || !family
    || family !== 4
    || !isConfiguredPrivateProviderAddress(hostname)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !url.port
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
  ) {
    throw new RelayError("provider_private_origin_invalid", "Configured private Provider origin is invalid", 400);
  }
  return { origin: url.origin, hostname, port };
}

export function isExactConfiguredPrivateProviderBaseUrl(value: string, privateOrigin?: string): boolean {
  if (!privateOrigin) return false;
  try {
    const configured = parseConfiguredPrivateProviderOrigin(privateOrigin);
    return value === configured.origin || value === `${configured.origin}/v1`;
  } catch {
    return false;
  }
}

export async function validateProviderBaseUrl(
  value: string,
  options: ProviderBaseUrlValidationOptions = {},
): Promise<ProviderBaseUrlValidationResult> {
  const result = await classifyProviderBaseUrl(value, options);
  if (result.classification === "rejected") {
    throw new RelayError(
      result.rejectionCode ?? "provider_url_not_allowed",
      result.rejectionCode === "invalid_provider_url" ? "Provider URL is invalid" : "Provider URL is not allowed",
      400,
    );
  }
  return result;
}

export async function classifyProviderBaseUrl(
  value: string,
  options: ProviderBaseUrlValidationOptions = {},
): Promise<ProviderBaseUrlValidationResult> {
  if (isExactConfiguredPrivateProviderBaseUrl(value, options.privateOrigin)) return { classification: "configured_private" };
  try {
    await resolvePublicProviderUrl(value, options.resolve);
    return { classification: "public_https" };
  } catch (error) {
    const rejectionCode = error instanceof RelayError && (error.code === "invalid_provider_url" || error.code === "provider_url_not_allowed")
      ? error.code
      : "provider_url_not_allowed";
    return { classification: "rejected", rejectionCode };
  }
}

export async function assertProviderBaseUrl(
  value: string,
  options: ProviderBaseUrlValidationOptions = {},
): Promise<void> {
  await validateProviderBaseUrl(value, options);
}

const blockedProviderAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  blockedProviderAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["100::", 64],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 23],
  ["2002::", 16],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
] as const) {
  blockedProviderAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicProviderAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 6 && new SocketAddress({ address, family: "ipv6" }).address.startsWith("::ffff:")) return false;
  return family !== 0 && !blockedProviderAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function isConfiguredPrivateProviderAddress(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 100
    && parts[1]! >= 64
    && parts[1]! <= 127;
}

function normalizedUrlHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

export function assertEnabled(status: string, label: string): void {
  if (status !== "enabled") throw new RelayError(`${label}_disabled`, `${label} is disabled`, 403);
}

export function teamScopeRef(teamId: string): ScopeRef {
  return `team:${teamId}`;
}

export function teamOwnerRole(teamId: string): TeamRole {
  return `owner:${teamId}`;
}

export function userScopeRef(userId: string): ScopeRef {
  return `user:${userId}`;
}

export function keyScopeRef(keyId: string): ScopeRef {
  return `key:${keyId}`;
}

export function parseScopeRef(scopeRef: ScopeRef): { scopeType: "global"; scopeId: "global" } | { scopeType: "team" | "user" | "key"; scopeId: string } {
  if (scopeRef === "global:") return { scopeType: "global", scopeId: "global" };
  const [scopeType, scopeId] = scopeRef.split(":", 2);
  if ((scopeType === "team" || scopeType === "user" || scopeType === "key") && scopeId) return { scopeType, scopeId };
  throw new RelayError("invalid_scope_ref", `Invalid scope_ref: ${scopeRef}`, 400);
}

export function isRuntimeScopeRef(scopeRef: string): scopeRef is ScopeRef {
  if (scopeRef === "global:") return true;
  const separator = scopeRef.indexOf(":");
  if (separator <= 0 || separator === scopeRef.length - 1) return false;
  const scopeType = scopeRef.slice(0, separator);
  return scopeType === "team" || scopeType === "user" || scopeType === "key";
}

export function resolverParts(resolver: string): { fnName: ResolverName; fnArg: string } {
  const separator = resolver.indexOf(":");
  if (separator <= 0) throw new RelayError("invalid_resolver", `Invalid resolver: ${resolver}`, 400);
  const fnName = resolver.slice(0, separator) as ResolverName;
  const fnArg = resolver.slice(separator + 1);
  if (!isResolverName(fnName)) {
    throw new RelayError("invalid_resolver", `Unsupported resolver function: ${fnName}`, 400);
  }
  return { fnName, fnArg };
}

export function isResolverName(value: string): value is ResolverName {
  return (RESOLVER_FUNCTION_NAMES as readonly string[]).includes(value);
}

export function resolverFunctionNamesForContext(context: ResolverContext): readonly ResolverName[] {
  return RESOLVER_FUNCTIONS_BY_CONTEXT[context];
}

export function isResolverAllowedInContext(fnName: ResolverName, context: ResolverContext): boolean {
  return (RESOLVER_REGISTRY[fnName].contexts as readonly ResolverContext[]).includes(context);
}

export function isValidResolverForContext(resolver: string, context: ResolverContext, options: { allowEmptyArg?: boolean } = {}): boolean {
  const separator = resolver.indexOf(":");
  if (separator <= 0) return false;
  const fnName = resolver.slice(0, separator);
  if (context === "credential") return separator === resolver.length - 1 && isResolverName(fnName) && isResolverAllowedInContext(fnName, context);
  if (!options.allowEmptyArg && separator === resolver.length - 1) return false;
  return isResolverName(fnName) && isResolverAllowedInContext(fnName, context);
}

export function assertValidResolverForContext(resolver: string, context: ResolverContext, options: { allowEmptyArg?: boolean } = {}): void {
  if (isValidResolverForContext(resolver, context, options)) return;
  if (context === "credential") throw new RelayError("invalid_credential_resolver", `Unsupported credential resolver: ${resolver}`, 400);
  throw new RelayError("invalid_resolver", `Unsupported ${context} resolver: ${resolver}`, 400);
}

export function assertValidBaseUrlResolverInput(resolver: string): void {
  assertValidResolverForContext(resolver, "baseUrl", { allowEmptyArg: true });
  const { fnName, fnArg } = resolverParts(resolver);
  if (fnName === "literal" && /\s/.test(fnArg)) {
    throw new RelayError("invalid_provider_url", "Base URL Resolver literal URL cannot contain whitespace", 400);
  }
}
