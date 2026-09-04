import { resolveExternalRequestOrigin, RelayError } from "@frely/core";

const validatedAuthMutationBrand = Symbol("friday.validated-auth-mutation");
const APPROVED_HEADER_NAMES = [
  "cookie",
  "user-agent",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
] as const;

/**
 * An authentication mutation request after a Web/Admin façade has completed
 * Host, protocol, browser-origin, and Fetch Metadata validation. The original
 * Request, Host, Origin, Referer, and proxy headers are intentionally not
 * exposed to Identity.
 */
export class ValidatedAuthMutationRequest {
  readonly [validatedAuthMutationBrand] = true as const;

  constructor(private readonly approvedHeaders: Headers, token: symbol) {
    if (token !== validatedAuthMutationBrand) throw new TypeError("Authentication mutation request was not created by a façade");
  }

  headers(): Headers {
    return new Headers(this.approvedHeaders);
  }
}

/**
 * Validate the external request boundary and create the only value accepted by
 * Better Auth mutation APIs. When expectedOrigin is omitted (Admin), the
 * expected origin is the one proven by the standard Host and transport headers;
 * Admin's private ingress admission remains a separate boundary.
 */
export function createValidatedAuthMutationRequest(
  request: Request,
  expectedOrigin?: string,
): ValidatedAuthMutationRequest {
  const externalOrigin = resolveExternalRequestOrigin(request);
  const normalizedExpectedOrigin = expectedOrigin === undefined
    ? externalOrigin
    : canonicalOrigin(expectedOrigin);
  if (!externalOrigin || !normalizedExpectedOrigin || externalOrigin !== normalizedExpectedOrigin) {
    throw requestOriginForbidden();
  }

  const origin = request.headers.get("origin");
  if (origin !== null && (!isSerializedOrigin(origin) || origin !== normalizedExpectedOrigin)) {
    throw requestOriginForbidden();
  }
  const referer = request.headers.get("referer");
  if (referer !== null && refererOrigin(referer) !== normalizedExpectedOrigin) {
    throw requestOriginForbidden();
  }
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") throw requestOriginForbidden();

  const approvedHeaders = new Headers();
  for (const name of APPROVED_HEADER_NAMES) {
    const value = request.headers.get(name);
    if (value !== null) approvedHeaders.set(name, value);
  }
  return new ValidatedAuthMutationRequest(approvedHeaders, validatedAuthMutationBrand);
}

/** Return a defensive copy of headers approved by the façade. */
export function authMutationHeaders(request: ValidatedAuthMutationRequest): Headers {
  if (!(request instanceof ValidatedAuthMutationRequest) || request[validatedAuthMutationBrand] !== true) {
    throw new TypeError("Authentication mutation request was not created by a façade");
  }
  return request.headers();
}

function canonicalOrigin(value: string): string | null {
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

function isSerializedOrigin(value: string): boolean {
  return canonicalOrigin(value) === value;
}

function refererOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.origin === "null") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function requestOriginForbidden(): RelayError {
  return new RelayError("request_origin_forbidden", "Request origin is not allowed", 403);
}
