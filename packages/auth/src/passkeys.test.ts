import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { AppConfig } from "@frely/config";
import {
  assertPasskeyRequest,
  clearPasskeyCeremonyCookie,
  constantTimeUserHandleEqual,
  createPasskeyCeremonyCookie,
  createWebAuthnUserHandle,
  hashPasskeySecret,
  isValidWebAuthnUserHandle,
  passkeyAuthenticationIdentity,
  passkeyAvailableForHeaders,
  passkeyCeremonyCookie,
  passkeyChallengeMatches,
  verifyPasskeyAuthentication
} from "./passkeys.js";

describe("user Passkey protocol boundary", () => {
  test("hashes ceremony secrets and compares challenges without accepting malformed hashes", () => {
    const secret = "raw-ceremony-secret-that-must-not-be-persisted";
    const hash = hashPasskeySecret(secret);

    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).not.toContain(secret);
    expect(passkeyChallengeMatches(secret, hash)).toBe(true);
    expect(passkeyChallengeMatches(`${secret}-replay`, hash)).toBe(false);
    expect(passkeyChallengeMatches(secret, "not-a-sha256-hash")).toBe(false);
    expect(passkeyChallengeMatches(secret, hash.toUpperCase())).toBe(false);
  });

  test("keeps ceremony cookies isolated by surface and purpose", () => {
    const config = passkeyConfig();
    const webRegistration = createPasskeyCeremonyCookie(config, "web", "registration");
    const adminAuthentication = createPasskeyCeremonyCookie(config, "admin", "authentication");
    const headers = new Headers({
      cookie: `${cookiePair(webRegistration.setCookie)}; ${cookiePair(adminAuthentication.setCookie)}`
    });

    expect(webRegistration.raw).not.toBe(webRegistration.hash);
    expect(webRegistration.hash).toBe(hashPasskeySecret(webRegistration.raw));
    expect(webRegistration.setCookie).toContain("friday_web_passkey_registration=");
    expect(webRegistration.setCookie).toContain("Path=/api/account/security/passkeys/registration");
    expect(webRegistration.setCookie).toContain("HttpOnly; SameSite=Strict; Secure");
    expect(adminAuthentication.setCookie).toContain("friday_admin_passkey_authentication=");
    expect(adminAuthentication.setCookie).toContain("Path=/api/auth/passkey");
    expect(passkeyCeremonyCookie(headers, "web", "registration")).toBe(webRegistration.raw);
    expect(passkeyCeremonyCookie(headers, "admin", "authentication")).toBe(adminAuthentication.raw);
    expect(passkeyCeremonyCookie(headers, "web", "authentication")).toBeNull();
    expect(passkeyCeremonyCookie(headers, "admin", "registration")).toBeNull();
    expect(clearPasskeyCeremonyCookie(config, "web", "registration"))
      .toContain("friday_web_passkey_registration=; Max-Age=0");
  });

  test("selects the configured RP only for the exact request surface origin", () => {
    const config = passkeyConfig();
    const webRequest = requestFor("https://web.example.test", "web.example.test");

    expect(assertPasskeyRequest(webRequest, config, "web")).toEqual({
      origin: "https://web.example.test",
      rpId: "web.example.test"
    });
    expect(() => assertPasskeyRequest(webRequest, config, "admin"))
      .toThrow(expect.objectContaining({ code: "passkey_origin_unavailable", status: 403 }));
    expect(() => assertPasskeyRequest(
      requestFor("https://web.example.test", "web.example.test", "https://admin.example.test"),
      config,
      "web"
    )).toThrow(expect.objectContaining({ code: "passkey_origin_unavailable", status: 403 }));
  });

  test("accepts production HTTPS proven by either the request URL or the trusted forwarded protocol", () => {
    const config = passkeyConfig();
    const directHttps = new Request("https://web.example.test/api/auth/passkey/options", {
      headers: { host: "web.example.test", origin: "https://web.example.test" }
    });
    const forwardedHttps = new Request("http://web.example.test/api/auth/passkey/options", {
      headers: { host: "web.example.test", origin: "https://web.example.test", "x-forwarded-proto": "https" }
    });

    const expected = { origin: "https://web.example.test", rpId: "web.example.test" };
    expect(assertPasskeyRequest(directHttps, config, "web")).toEqual(expected);
    expect(assertPasskeyRequest(forwardedHttps, config, "web")).toEqual(expected);
    expect(passkeyAvailableForHeaders(directHttps.headers, config, "web")).toBe(true);
    expect(passkeyAvailableForHeaders(new Headers({ host: "web.example.test", "x-forwarded-proto": "http" }), config, "web")).toBe(false);
  });

  test("uses opaque stable user handles rather than user roles or email", () => {
    const first = createWebAuthnUserHandle();
    const second = createWebAuthnUserHandle();

    expect(isValidWebAuthnUserHandle(first)).toBe(true);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(constantTimeUserHandleEqual(first, first)).toBe(true);
    expect(constantTimeUserHandleEqual(first, second)).toBe(false);
    expect(isValidWebAuthnUserHandle("owner@example.test")).toBe(false);
  });

  test("verifies a real ES256 assertion and rejects challenge, RP, and cross-origin substitution", async () => {
    const vector = authenticationVector();

    await expect(verifyPasskeyAuthentication({
      response: vector.response,
      challengeHash: hashPasskeySecret(vector.challenge),
      origin: vector.origin,
      rpId: vector.rpId,
      credential: vector.credential
    })).resolves.toEqual({
      credentialId: vector.credential.credentialId,
      newSignCount: 1,
      deviceType: "singleDevice",
      backedUp: false
    });

    await expect(verifyPasskeyAuthentication({
      response: vector.response,
      challengeHash: hashPasskeySecret("another-challenge"),
      origin: vector.origin,
      rpId: vector.rpId,
      credential: vector.credential
    })).rejects.toBeDefined();

    await expect(verifyPasskeyAuthentication({
      response: vector.response,
      challengeHash: hashPasskeySecret(vector.challenge),
      origin: vector.origin,
      rpId: "other.example.test",
      credential: vector.credential
    })).rejects.toBeDefined();

    const crossOriginResponse = structuredClone(vector.response);
    crossOriginResponse.response.clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.get",
      challenge: vector.challenge,
      origin: vector.origin,
      crossOrigin: true
    })).toString("base64url");
    await expect(verifyPasskeyAuthentication({
      response: crossOriginResponse,
      challengeHash: hashPasskeySecret(vector.challenge),
      origin: vector.origin,
      rpId: vector.rpId,
      credential: vector.credential
    })).rejects.toEqual(expect.objectContaining({ code: "passkey_protocol_invalid", status: 400 }));
  });

  test("verifies a real RS256 assertion", async () => {
    const vector = rsaAuthenticationVector();

    await expect(verifyPasskeyAuthentication({
      response: vector.response,
      challengeHash: hashPasskeySecret(vector.challenge),
      origin: vector.origin,
      rpId: vector.rpId,
      credential: vector.credential
    })).resolves.toEqual({
      credentialId: vector.credential.credentialId,
      newSignCount: 1,
      deviceType: "singleDevice",
      backedUp: false
    });
  });

  test("requires an assertion to carry the canonical credential id and discoverable user handle", () => {
    const credentialId = Buffer.from("credential-id").toString("base64url");
    const userHandle = createWebAuthnUserHandle();
    expect(passkeyAuthenticationIdentity({
      id: credentialId,
      rawId: credentialId,
      response: { userHandle }
    })).toEqual({ credentialId, userHandle });
    expect(() => passkeyAuthenticationIdentity({
      id: credentialId,
      rawId: Buffer.from("different").toString("base64url"),
      response: { userHandle }
    })).toThrow(expect.objectContaining({ code: "passkey_protocol_invalid" }));
    expect(() => passkeyAuthenticationIdentity({
      id: credentialId,
      rawId: credentialId,
      response: { userHandle: null }
    })).toThrow(expect.objectContaining({ code: "passkey_protocol_invalid" }));
  });
});

function passkeyConfig(): AppConfig {
  return {
    app: { environment: "production" },
    auth: {
      cookieSecure: true,
      passkey: {
        enabled: true,
        surfaces: {
          web: { origin: "https://web.example.test", rpId: "web.example.test" },
          admin: { origin: "https://admin.example.test", rpId: "admin.example.test" }
        }
      }
    }
  } as AppConfig;
}

function requestFor(origin: string, host: string, headerOrigin = origin): Request {
  return new Request(`${origin}/api/auth/passkey/options`, {
    headers: { host, origin: headerOrigin, "x-forwarded-proto": "https" }
  });
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

function authenticationVector() {
  const rpId = "login.example.test";
  const origin = `https://${rpId}`;
  const challenge = Buffer.from("a deterministic test challenge").toString("base64url");
  const credentialId = Buffer.from("real-es256-test-credential").toString("base64url");
  const userHandle = Buffer.alloc(32, 7).toString("base64url");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("Generated P-256 key is missing coordinates");
  const cosePublicKey = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y, "base64url")
  ]);
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin,
    crossOrigin: false
  }));
  const authenticatorData = Buffer.alloc(37);
  createHash("sha256").update(rpId).digest().copy(authenticatorData, 0);
  authenticatorData[32] = 0x05; // User present and user verified.
  authenticatorData.writeUInt32BE(1, 33);
  const signedData = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest()
  ]);
  const signature = sign("sha256", signedData, privateKey);
  const response = {
    id: credentialId,
    rawId: credentialId,
    type: "public-key" as const,
    clientExtensionResults: {},
    authenticatorAttachment: "platform" as const,
    response: {
      clientDataJSON: clientDataJSON.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url"),
      userHandle
    }
  };
  return {
    challenge,
    origin,
    rpId,
    response,
    credential: { credentialId, publicKey: cosePublicKey.toString("base64url"), signCount: 0, transports: ["internal"] }
  };
}

function rsaAuthenticationVector() {
  const rpId = "rsa-login.example.test";
  const origin = `https://${rpId}`;
  const challenge = Buffer.from("a deterministic RSA test challenge").toString("base64url");
  const credentialId = Buffer.from("real-rs256-test-credential").toString("base64url");
  const userHandle = Buffer.alloc(32, 9).toString("base64url");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.n || !jwk.e) throw new Error("Generated RSA key is missing modulus or exponent");
  const modulus = Buffer.from(jwk.n, "base64url");
  const exponent = Buffer.from(jwk.e, "base64url");
  const cosePublicKey = Buffer.concat([
    Buffer.from([0xa4, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00, 0x20, 0x59]),
    Buffer.from([modulus.length >> 8, modulus.length & 0xff]),
    modulus,
    Buffer.from([0x21, 0x40 | exponent.length]),
    exponent
  ]);
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin,
    crossOrigin: false
  }));
  const authenticatorData = Buffer.alloc(37);
  createHash("sha256").update(rpId).digest().copy(authenticatorData, 0);
  authenticatorData[32] = 0x05;
  authenticatorData.writeUInt32BE(1, 33);
  const signature = sign("RSA-SHA256", Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest()
  ]), privateKey);
  const response = {
    id: credentialId,
    rawId: credentialId,
    type: "public-key" as const,
    clientExtensionResults: {},
    authenticatorAttachment: "cross-platform" as const,
    response: {
      clientDataJSON: clientDataJSON.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url"),
      userHandle
    }
  };
  return {
    challenge,
    origin,
    rpId,
    response,
    credential: { credentialId, publicKey: cosePublicKey.toString("base64url"), signCount: 0, transports: ["usb"] }
  };
}
