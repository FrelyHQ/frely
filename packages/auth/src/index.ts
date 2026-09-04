import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import { createId, RelayError, type PlatformRole, type TeamRole } from "@frely/core";
import type { AppConfig } from "@frely/config";

export * from "./auth-mutation-request.js";
export * from "./oidc.js";
export * from "./passkeys.js";
export * from "./password-change-request.js";
export * from "./password-policy.js";

const scrypt = promisify(scryptCallback);

export interface AccessTokenClaims {
  sub: string;
  email: string;
  authVersion: number;
  platformRoles: PlatformRole[];
  teamRoles: TeamRole[];
  type: "access";
  iat: number;
  exp: number;
}

export type AuthSurface = "owner" | "web";

export interface LandingEntryStateClaims {
  type: "landing_entry";
  purpose: "registration";
  canonicalOrigin: string;
  domainBindingId: string;
  hostname: string;
  iat: number;
  exp: number;
}

export interface AuthSessionTokens {
  accessToken: string;
  refreshToken: string;
}

const AUTH_COOKIE_NAMES = {
  owner: { access: "friday_owner_access_token", refresh: "friday_owner_refresh_token" },
  web: { access: "friday_web_access_token", refresh: "friday_web_refresh_token" }
} as const satisfies Record<AuthSurface, { access: string; refresh: string }>;

const LANDING_ENTRY_STATE_TTL_SECONDS = 600;
const LANDING_ENTRY_STATE_AUDIENCE = "friday-relay:landing-entry";
const LANDING_ENTRY_COOKIE = "friday_registration_entry";
const LANDING_ENTRY_HOST_COOKIE = "__Host-friday_registration_entry";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Hash a Better Auth session bearer value before it crosses the persistence
 * boundary. The cookie still carries the opaque Better Auth value, while the
 * database only receives this deterministic, project-scoped HMAC.
 */
export function betterAuthSessionTokenHash(rawToken: string, secret: string): string {
  return createHmac("sha256", secret)
    .update("friday-relay:better-auth:session-token:v1\0", "utf8")
    .update(rawToken, "utf8")
    .digest("hex");
}

export function signLandingEntryState(
  config: AppConfig,
  input: {
    canonicalOrigin: string;
    domainBindingId: string;
    hostname: string;
    issuedAtEpochSeconds?: number;
  }
): string {
  const canonicalOrigin = new URL(input.canonicalOrigin).origin;
  if (!input.domainBindingId || !input.hostname || /[/:@?#]/u.test(input.hostname)) {
    throw new RelayError("landing_entry_invalid", "Landing entry state is invalid", 400);
  }
  const issuedAt = input.issuedAtEpochSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new RelayError("landing_entry_invalid", "Landing entry state is invalid", 400);
  const claims: LandingEntryStateClaims = {
    type: "landing_entry",
    purpose: "registration",
    canonicalOrigin,
    domainBindingId: input.domainBindingId,
    hostname: input.hostname.toLowerCase(),
    iat: issuedAt,
    exp: issuedAt + LANDING_ENTRY_STATE_TTL_SECONDS
  };
  return jwt.sign(claims, config.auth.jwtSecret, {
    issuer: config.app.name,
    audience: LANDING_ENTRY_STATE_AUDIENCE
  });
}

export function verifyLandingEntryState(
  config: AppConfig,
  token: string,
  options: { canonicalOrigin?: string; nowEpochSeconds?: number } = {}
): LandingEntryStateClaims {
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret, {
      issuer: config.app.name,
      audience: LANDING_ENTRY_STATE_AUDIENCE
    }) as Partial<LandingEntryStateClaims>;
    if (
      decoded.type !== "landing_entry"
      || decoded.purpose !== "registration"
      || typeof decoded.canonicalOrigin !== "string"
      || typeof decoded.domainBindingId !== "string"
      || !decoded.domainBindingId
      || typeof decoded.hostname !== "string"
      || !decoded.hostname
      || typeof decoded.iat !== "number"
      || !Number.isSafeInteger(decoded.iat)
      || typeof decoded.exp !== "number"
      || !Number.isSafeInteger(decoded.exp)
    ) throw new Error("invalid landing entry claims");
    const issuedAt = decoded.iat;
    const expiresAt = decoded.exp;
    if (expiresAt <= issuedAt || expiresAt - issuedAt > LANDING_ENTRY_STATE_TTL_SECONDS) throw new Error("invalid landing entry lifetime");
    const canonicalOrigin = new URL(decoded.canonicalOrigin).origin;
    if (canonicalOrigin !== decoded.canonicalOrigin) throw new Error("non-canonical landing origin");
    if (options.canonicalOrigin !== undefined && canonicalOrigin !== new URL(options.canonicalOrigin).origin) throw new Error("wrong landing origin");
    if (/[/:@?#]/u.test(decoded.hostname)) throw new Error("invalid landing hostname");
    const now = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(now) || issuedAt > now + 60 || expiresAt <= now) throw new Error("expired landing entry");
    return {
      type: "landing_entry",
      purpose: "registration",
      canonicalOrigin,
      domainBindingId: decoded.domainBindingId,
      hostname: decoded.hostname.toLowerCase(),
      iat: issuedAt,
      exp: expiresAt
    };
  } catch {
    throw new RelayError("landing_entry_invalid", "Landing entry state is invalid", 400);
  }
}

export function landingRegistrationEntryCookieName(config: AppConfig): string {
  return config.app.environment === "production" && config.auth.cookieSecure ? LANDING_ENTRY_HOST_COOKIE : LANDING_ENTRY_COOKIE;
}

export function landingRegistrationEntryCookieHeaders(config: AppConfig, state: string): string[] {
  return [serializeCookie(landingRegistrationEntryCookieName(config), state, LANDING_ENTRY_STATE_TTL_SECONDS, config.auth.cookieSecure)];
}

export function clearLandingRegistrationEntryCookieHeaders(config: AppConfig): string[] {
  return [serializeCookie(landingRegistrationEntryCookieName(config), "", 0, config.auth.cookieSecure)];
}

export function landingRegistrationEntryFromHeaders(config: AppConfig, headers: Headers): LandingEntryStateClaims | null {
  const token = cookieValue(headers, landingRegistrationEntryCookieName(config));
  if (!token) return null;
  try {
    return verifyLandingEntryState(config, token, { canonicalOrigin: config.app.publicBaseUrl });
  } catch {
    return null;
  }
}

export async function createPasswordHash(password: string): Promise<string> {
  if (!password) throw new RelayError("invalid_password", "Password is required", 400);
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [scheme, salt, expectedHex] = hash.split(":");
  if (scheme !== "scrypt" || !salt || !expectedHex) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function signAccessToken(
  config: AppConfig,
  claims: Omit<AccessTokenClaims, "type" | "iat" | "exp" | "authVersion"> & { authVersion?: number }
): string {
  const authVersion = claims.authVersion ?? 1;
  if (!Number.isSafeInteger(authVersion) || authVersion < 1) throw new Error("Invalid authentication version");
  return jwt.sign({ ...claims, authVersion, type: "access" }, config.auth.jwtSecret, {
    expiresIn: config.auth.accessTokenTtlSeconds,
    issuer: config.app.name
  });
}

export function verifyAccessToken(config: AppConfig, token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret, { issuer: config.app.name }) as AccessTokenClaims & { authVersion?: number };
    if (decoded.type !== "access") throw new Error("wrong token type");
    if (!Number.isSafeInteger(decoded.iat) || decoded.iat <= 0) throw new Error("invalid issued-at claim");
    if (!Number.isSafeInteger(decoded.exp) || decoded.exp <= 0) throw new Error("invalid expiration claim");
    const authVersion = decoded.authVersion === undefined ? 1 : decoded.authVersion;
    if (!Number.isSafeInteger(authVersion) || authVersion < 1) throw new Error("invalid authentication version claim");
    if (!Array.isArray(decoded.platformRoles) || !decoded.platformRoles.every((role) => role === "owner")) throw new Error("invalid platform role claim");
    if (!Array.isArray(decoded.teamRoles) || !decoded.teamRoles.every((role) => typeof role === "string" && role.startsWith("owner:") && role.length > "owner:".length)) throw new Error("invalid team role claim");
    return { ...decoded, authVersion };
  } catch {
    throw new RelayError("unauthorized", "Invalid or expired access token", 401);
  }
}

export function createRefreshToken(): { raw: string; hash: string } {
  const raw = `${createId("refresh")}.${randomBytes(24).toString("base64url")}`;
  return { raw, hash: sha256(raw) };
}

export function refreshTokenExpiresAt(config: AppConfig, now = new Date()): string {
  return new Date(now.getTime() + config.auth.refreshTokenTtlSeconds * 1000).toISOString();
}

export function createApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `sk-${randomBytes(32).toString("base64url")}`;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 10) };
}

export function bearerToken(headers: Headers): string {
  const header = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) throw new RelayError("unauthorized", "Bearer token is required", 401);
  return match[1].trim();
}

export function accessTokenFromHeaders(headers: Headers, surface: AuthSurface): string {
  const header = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match?.[1]) return match[1].trim();
  const token = cookieValue(headers, AUTH_COOKIE_NAMES[surface].access);
  if (token) return token;
  throw new RelayError("unauthorized", "Bearer token or session cookie is required", 401);
}

export function accessTokenFromCookie(headers: Headers, surface: AuthSurface): string {
  const token = cookieValue(headers, AUTH_COOKIE_NAMES[surface].access);
  if (token) return token;
  throw new RelayError("unauthorized", "Session cookie is required", 401);
}

export function refreshTokenFromHeaders(headers: Headers, surface: AuthSurface): string | null {
  return cookieValue(headers, AUTH_COOKIE_NAMES[surface].refresh);
}

export function authCookieHeaders(config: AppConfig, surface: AuthSurface, tokens: AuthSessionTokens): string[] {
  return [
    serializeCookie(AUTH_COOKIE_NAMES[surface].access, tokens.accessToken, config.auth.accessTokenTtlSeconds, config.auth.cookieSecure),
    serializeCookie(AUTH_COOKIE_NAMES[surface].refresh, tokens.refreshToken, config.auth.refreshTokenTtlSeconds, config.auth.cookieSecure)
  ];
}

export function clearAuthCookieHeaders(config: AppConfig, surface: AuthSurface): string[] {
  return [
    serializeCookie(AUTH_COOKIE_NAMES[surface].access, "", 0, config.auth.cookieSecure),
    serializeCookie(AUTH_COOKIE_NAMES[surface].refresh, "", 0, config.auth.cookieSecure)
  ];
}

function cookieValue(headers: Headers, name: string): string | null {
  const cookie = headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName === name) {
      try {
        return decodeURIComponent(rawValueParts.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const encoded = encodeURIComponent(value);
  return `${name}=${encoded}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
