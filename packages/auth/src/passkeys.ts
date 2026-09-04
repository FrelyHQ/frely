import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import type { AppConfig } from "@frely/config";
import { RelayError, resolveExternalOriginFromHeaders, resolveExternalRequestOrigin } from "@frely/core";

export const USER_PASSKEY_RP_NAME = "Frely";
export const USER_PASSKEY_CEREMONY_TTL_SECONDS = 300;
export const USER_PASSKEY_MAX_CREDENTIALS_PER_RP = 10;
export const USER_PASSKEY_CREDENTIAL_TIMEOUT_MS = 120_000;

export type PasskeySurface = "web" | "admin";
export type PasskeyCeremonyPurpose = "registration" | "authentication";
export type PasskeyDeviceType = "singleDevice" | "multiDevice";
export type PasskeySurfaceConfig = { origin: string; rpId: string };

export interface StoredPasskeyProtocolCredential {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[];
}

export interface VerifiedPasskeyRegistration {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[];
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
}

export interface VerifiedPasskeyAuthentication {
  credentialId: string;
  newSignCount: number;
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
}

const CEREMONY_COOKIE_NAMES = {
  web: {
    registration: "friday_web_passkey_registration",
    authentication: "friday_web_passkey_authentication"
  },
  admin: {
    registration: "friday_admin_passkey_registration",
    authentication: "friday_admin_passkey_authentication"
  }
} as const satisfies Record<PasskeySurface, Record<PasskeyCeremonyPurpose, string>>;

const CEREMONY_COOKIE_PATHS = {
  registration: "/api/account/security/passkeys/registration",
  authentication: "/api/auth/passkey"
} as const satisfies Record<PasskeyCeremonyPurpose, string>;

const TRANSPORT_ORDER = ["internal", "hybrid", "usb", "nfc", "ble", "smart-card", "cable"] as const;
const TRANSPORTS = new Set<string>(TRANSPORT_ORDER);

export function passkeySurfaceConfig(config: AppConfig, surface: PasskeySurface): PasskeySurfaceConfig | null {
  if (!config.auth.passkey.enabled) return null;
  return config.auth.passkey.surfaces[surface] ?? null;
}

export function assertPasskeyRequest(
  request: Request,
  config: AppConfig,
  surface: PasskeySurface,
  options: { requireOrigin?: boolean } = {}
): PasskeySurfaceConfig {
  const surfaceConfig = passkeySurfaceConfig(config, surface);
  if (!surfaceConfig) throw new RelayError("not_found", "Not found", 404);
  const expected = new URL(surfaceConfig.origin);
  const host = request.headers.get("host");
  const externalOrigin = resolveExternalRequestOrigin(request);
  if (!host || host.includes(",") || host !== expected.host || externalOrigin !== expected.origin) {
    throw new RelayError("passkey_origin_unavailable", "Passkey is unavailable on this origin", 403);
  }
  if (options.requireOrigin !== false) {
    const origin = request.headers.get("origin");
    if (!origin || origin.includes(",") || origin !== expected.origin) {
      throw new RelayError("passkey_origin_unavailable", "Passkey is unavailable on this origin", 403);
    }
  }
  return surfaceConfig;
}

export function passkeyAvailableForHeaders(headers: Headers, config: AppConfig, surface: PasskeySurface): boolean {
  const surfaceConfig = passkeySurfaceConfig(config, surface);
  if (!surfaceConfig) return false;
  const expected = new URL(surfaceConfig.origin);
  if (headers.get("host") !== expected.host) return false;
  const forwardedProto = headers.get("x-forwarded-proto");
  if (forwardedProto === null) return true;
  return resolveExternalOriginFromHeaders(headers) === expected.origin;
}

export function createPasskeyCeremonyCookie(
  config: AppConfig,
  surface: PasskeySurface,
  purpose: PasskeyCeremonyPurpose
): { raw: string; hash: string; setCookie: string } {
  const raw = randomBytes(32).toString("base64url");
  return {
    raw,
    hash: hashPasskeySecret(raw),
    setCookie: serializeCeremonyCookie(config, surface, purpose, raw, USER_PASSKEY_CEREMONY_TTL_SECONDS)
  };
}

export function passkeyCeremonyCookie(headers: Headers, surface: PasskeySurface, purpose: PasskeyCeremonyPurpose): string | null {
  const cookie = headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== CEREMONY_COOKIE_NAMES[surface][purpose]) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export function clearPasskeyCeremonyCookie(config: AppConfig, surface: PasskeySurface, purpose: PasskeyCeremonyPurpose): string {
  return serializeCeremonyCookie(config, surface, purpose, "", 0);
}

export function passkeyCeremonyExpiresAt(now = new Date()): string {
  return new Date(now.getTime() + USER_PASSKEY_CEREMONY_TTL_SECONDS * 1000).toISOString();
}

export function hashPasskeySecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function passkeyChallengeMatches(challenge: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPasskeySecret(challenge), "hex");
  const expected = /^[0-9a-f]{64}$/u.test(expectedHash) ? Buffer.from(expectedHash, "hex") : Buffer.alloc(0);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function createWebAuthnUserHandle(): string {
  return randomBytes(32).toString("base64url");
}

export function isValidWebAuthnUserHandle(value: string): boolean {
  return canonicalBase64url(value, 32, 32) !== null;
}

export function constantTimeUserHandleEqual(actual: string, expected: string): boolean {
  const actualBytes = canonicalBase64url(actual, 32, 32) ?? Buffer.alloc(0);
  const expectedBytes = canonicalBase64url(expected, 32, 32) ?? Buffer.alloc(1);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function normalizePasskeyName(value: unknown): string {
  if (typeof value !== "string") throw invalidPasskeyBody();
  const name = value.trim();
  const codePoints = Array.from(name);
  if (codePoints.length < 1 || codePoints.length > 64 || Buffer.byteLength(name, "utf8") > 256 || /\p{Cc}|\p{Cf}/u.test(name)) {
    throw invalidPasskeyBody();
  }
  return name;
}

export function normalizePasskeyCredentialId(value: unknown): string {
  if (typeof value !== "string" || canonicalBase64url(value, 1, 1023) === null) throw invalidPasskeyProtocol();
  return value;
}

export function passkeyAuthenticationIdentity(response: unknown): { credentialId: string; userHandle: string } {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw invalidPasskeyProtocol();
  const record = response as Record<string, unknown>;
  const credentialId = normalizePasskeyCredentialId(record.id);
  if (record.rawId !== credentialId) throw invalidPasskeyProtocol();
  const assertion = record.response;
  if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) throw invalidPasskeyProtocol();
  const userHandle = (assertion as Record<string, unknown>).userHandle;
  if (typeof userHandle !== "string" || !userHandle) throw invalidPasskeyProtocol();
  return { credentialId, userHandle };
}

export async function passkeyRegistrationOptions(input: {
  rpId: string;
  userName: string;
  userHandle: string;
  excludeCredentials: Array<{ credentialId: string; transports: string[] }>;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  if (!isValidWebAuthnUserHandle(input.userHandle)) throw new Error("Invalid stored WebAuthn user handle");
  return generateRegistrationOptions({
    rpName: USER_PASSKEY_RP_NAME,
    rpID: input.rpId,
    userName: input.userName,
    userDisplayName: input.userName,
    userID: Buffer.from(input.userHandle, "base64url"),
    timeout: USER_PASSKEY_CREDENTIAL_TIMEOUT_MS,
    attestationType: "none",
    supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    excludeCredentials: input.excludeCredentials.map((credential) => ({
      id: normalizePasskeyCredentialId(credential.credentialId),
      transports: normalizePasskeyTransports(credential.transports) as AuthenticatorTransportFuture[]
    }))
  });
}

export async function passkeyAuthenticationOptions(rpId: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: [],
    userVerification: "required",
    timeout: USER_PASSKEY_CREDENTIAL_TIMEOUT_MS
  });
}

export async function verifyPasskeyRegistration(input: {
  response: unknown;
  challengeHash: string;
  origin: string;
  rpId: string;
}): Promise<VerifiedPasskeyRegistration> {
  assertClientDataOriginBoundary(input.response, input.origin);
  const response = input.response as RegistrationResponseJSON;
  normalizePasskeyCredentialId(response.id);
  if (response.rawId !== response.id) throw invalidPasskeyProtocol();
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: (challenge) => passkeyChallengeMatches(challenge, input.challengeHash),
    expectedOrigin: input.origin,
    expectedRPID: input.rpId,
    expectedType: "webauthn.create",
    requireUserPresence: true,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7, -257]
  });
  if (!result.verified) throw invalidPasskeyProtocol();
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  return {
    credentialId: normalizePasskeyCredentialId(credential.id),
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    signCount: credential.counter,
    transports: normalizePasskeyTransports(credential.transports ?? response.response.transports ?? []),
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp
  };
}

export async function verifyPasskeyAuthentication(input: {
  response: unknown;
  challengeHash: string;
  origin: string;
  rpId: string;
  credential: StoredPasskeyProtocolCredential;
}): Promise<VerifiedPasskeyAuthentication> {
  assertClientDataOriginBoundary(input.response, input.origin);
  const response = input.response as AuthenticationResponseJSON;
  const credentialId = normalizePasskeyCredentialId(response.id);
  if (response.rawId !== credentialId || credentialId !== input.credential.credentialId) throw invalidPasskeyProtocol();
  const publicKey = canonicalBase64url(input.credential.publicKey, 1, 4096);
  if (!publicKey || !Number.isSafeInteger(input.credential.signCount) || input.credential.signCount < 0) throw invalidPasskeyProtocol();
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: (challenge) => passkeyChallengeMatches(challenge, input.challengeHash),
    expectedOrigin: input.origin,
    expectedRPID: input.rpId,
    expectedType: "webauthn.get",
    requireUserVerification: true,
    credential: {
      id: credentialId,
      publicKey: Uint8Array.from(publicKey),
      counter: input.credential.signCount,
      transports: normalizePasskeyTransports(input.credential.transports) as AuthenticatorTransportFuture[]
    }
  });
  if (!result.verified) throw invalidPasskeyProtocol();
  return {
    credentialId,
    newSignCount: result.authenticationInfo.newCounter,
    deviceType: result.authenticationInfo.credentialDeviceType,
    backedUp: result.authenticationInfo.credentialBackedUp
  };
}

export async function readStrictPasskeyJson<T>(request: Request, limit: number, parse: (value: unknown) => T): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu.test(contentType)) throw invalidPasskeyBody();
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > limit)) throw invalidPasskeyBody();
  const bytes = await readLimitedBody(request, limit);
  try {
    return parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw invalidPasskeyBody();
  }
}

export function strictPasskeyObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidPasskeyBody();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw invalidPasskeyBody();
  return record;
}

export function normalizePasskeyTransports(value: readonly unknown[]): string[] {
  const present = new Set(value.filter((entry): entry is string => typeof entry === "string" && TRANSPORTS.has(entry)));
  return TRANSPORT_ORDER.filter((transport) => present.has(transport));
}

function assertClientDataOriginBoundary(response: unknown, expectedOrigin: string): void {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw invalidPasskeyProtocol();
  const responseBody = (response as Record<string, unknown>).response;
  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) throw invalidPasskeyProtocol();
  const encoded = (responseBody as Record<string, unknown>).clientDataJSON;
  if (typeof encoded !== "string") throw invalidPasskeyProtocol();
  const bytes = canonicalBase64url(encoded, 1, 4096);
  if (!bytes) throw invalidPasskeyProtocol();
  let clientData: unknown;
  try {
    clientData = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidPasskeyProtocol();
  }
  if (!clientData || typeof clientData !== "object" || Array.isArray(clientData)) throw invalidPasskeyProtocol();
  const record = clientData as Record<string, unknown>;
  if (record.crossOrigin === true || (record.topOrigin !== undefined && record.topOrigin !== expectedOrigin)) throw invalidPasskeyProtocol();
}

function canonicalBase64url(value: string, minimumBytes: number, maximumBytes: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < minimumBytes || bytes.length > maximumBytes || bytes.toString("base64url") !== value) return null;
  return bytes;
}

async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw invalidPasskeyBody();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function serializeCeremonyCookie(
  config: AppConfig,
  surface: PasskeySurface,
  purpose: PasskeyCeremonyPurpose,
  value: string,
  maxAge: number
): string {
  return `${CEREMONY_COOKIE_NAMES[surface][purpose]}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${CEREMONY_COOKIE_PATHS[purpose]}; HttpOnly; SameSite=Strict${config.auth.cookieSecure ? "; Secure" : ""}`;
}

function invalidPasskeyBody(): RelayError {
  return new RelayError("invalid_request_body", "Request body is invalid", 400);
}

function invalidPasskeyProtocol(): RelayError {
  return new RelayError("passkey_protocol_invalid", "Passkey response is invalid", 400);
}
