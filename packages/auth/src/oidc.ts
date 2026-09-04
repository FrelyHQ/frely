import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  type JsonWebKey,
  type KeyObject
} from "node:crypto";
import jwt, { type Secret, type SignOptions } from "jsonwebtoken";

const PKCE_VALUE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface OidcIdTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  nonce: string;
  email?: string;
}

export interface OidcPublicJwk extends JsonWebKey {
  kid: string;
  use: "sig";
  alg: "RS256";
}

export function createPkceS256Challenge(verifier: string): string {
  if (!isValidPkceVerifier(verifier)) throw new Error("Invalid PKCE verifier");
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function isValidPkceVerifier(value: string): boolean {
  return PKCE_VALUE_PATTERN.test(value);
}

export function isValidPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function isHighEntropyOidcValue(value: string): boolean {
  return PKCE_VALUE_PATTERN.test(value);
}

export function createOidcOpaqueCredential(prefix: "code" | "access" | "refresh"): { raw: string; hash: string } {
  const raw = `${prefix}.${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashOidcCredential(raw) };
}

export function hashOidcCredential(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function verifyOidcClientSecret(presented: string, expected: string): boolean {
  const presentedHash = createHash("sha256").update(presented).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}

export function parseClientSecretBasic(header: string | null): { clientId: string; clientSecret: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header ?? "");
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 1) return null;
  try {
    return {
      clientId: decodeFormComponent(decoded.slice(0, separator)),
      clientSecret: decodeFormComponent(decoded.slice(separator + 1))
    };
  } catch {
    return null;
  }
}

export function oidcPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  assertRsaKey(key);
  return key;
}

export function oidcPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  assertRsaKey(key);
  return key;
}

export function oidcPublicJwk(key: KeyObject, kid: string): OidcPublicJwk {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  assertRsaKey(publicKey);
  return { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
}

export function signOidcIdToken(
  input: {
    issuer: string;
    subject: string;
    audience: string;
    nonce: string;
    expiresInSeconds: number;
    email?: string;
  },
  key: KeyObject,
  kid: string,
  nowEpochSeconds = Math.floor(Date.now() / 1000)
): string {
  assertRsaKey(key);
  const options: SignOptions = {
    algorithm: "RS256",
    issuer: input.issuer,
    subject: input.subject,
    audience: input.audience,
    expiresIn: input.expiresInSeconds,
    mutatePayload: false,
    header: { alg: "RS256", typ: "JWT", kid }
  };
  return jwt.sign(
    {
      iat: nowEpochSeconds,
      nonce: input.nonce,
      ...(input.email ? { email: input.email } : {})
    },
    key as Secret,
    options
  );
}

export function verifyOidcIdToken(
  token: string,
  key: KeyObject | string,
  input: { issuer: string; audience: string }
): OidcIdTokenClaims {
  return jwt.verify(token, key, {
    algorithms: ["RS256"],
    issuer: input.issuer,
    audience: input.audience
  }) as OidcIdTokenClaims;
}

function decodeFormComponent(value: string): string {
  return decodeURIComponent(value.replaceAll("+", " "));
}

function assertRsaKey(key: KeyObject): void {
  if (key.asymmetricKeyType !== "rsa") throw new Error("OIDC signing keys must be RSA keys");
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (typeof modulusLength === "number" && modulusLength < 2048) throw new Error("OIDC RSA signing keys must be at least 2048 bits");
}
