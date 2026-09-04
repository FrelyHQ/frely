import { describe, expect, test } from "vitest";
import jwt from "jsonwebtoken";
import { RelayError } from "@frely/core";
import { testConfig } from "@frely/testkit";
import {
  assertPasswordChangeRequestOrigin,
  passwordChangeRateLimitSubjects,
  readPasswordChangeRequestBody
} from "./password-change-request.js";
import { validatePasswordPolicy } from "./password-policy.js";
import { accessTokenFromCookie, signAccessToken, verifyAccessToken } from "./index.js";

describe("password policy and authentication version", () => {
  test("counts Unicode code points, caps UTF-8 bytes, and preserves input without trimming or normalization", () => {
    expect(validatePasswordPolicy("abcdefghijkl")).toEqual(expect.objectContaining({ valid: true, codePointLength: 12, utf8ByteLength: 12 }));
    expect(validatePasswordPolicy("😀".repeat(12))).toEqual(expect.objectContaining({ valid: true, codePointLength: 12, utf8ByteLength: 48 }));
    expect(validatePasswordPolicy("a".repeat(11))).toEqual(expect.objectContaining({ valid: false, failure: "too_short" }));
    expect(validatePasswordPolicy("a".repeat(256))).toEqual(expect.objectContaining({ valid: true, utf8ByteLength: 256 }));
    expect(validatePasswordPolicy("a".repeat(257))).toEqual(expect.objectContaining({ valid: false, failure: "too_long", utf8ByteLength: 257 }));
    expect(validatePasswordPolicy("😀".repeat(64))).toEqual(expect.objectContaining({ valid: true, utf8ByteLength: 256 }));
    expect(validatePasswordPolicy("😀".repeat(65))).toEqual(expect.objectContaining({ valid: false, failure: "too_long", utf8ByteLength: 260 }));
    expect(validatePasswordPolicy(" ".repeat(12))).toEqual(expect.objectContaining({ valid: true }));
    expect(validatePasswordPolicy("é".repeat(12)).utf8ByteLength).not.toBe(validatePasswordPolicy("e\u0301".repeat(12)).utf8ByteLength);
  });

  test("signs every new access token with authVersion and treats a legacy missing claim as version 1", () => {
    const config = testConfig();
    const current = signAccessToken(config, {
      sub: "user_current",
      email: "current@example.test",
      authVersion: 7,
      platformRoles: [],
      teamRoles: []
    });
    expect(verifyAccessToken(config, current).authVersion).toBe(7);

    const legacy = jwt.sign({
      sub: "user_legacy",
      email: "legacy@example.test",
      platformRoles: [],
      teamRoles: [],
      type: "access"
    }, config.auth.jwtSecret, {
      expiresIn: config.auth.accessTokenTtlSeconds,
      issuer: config.app.name
    });
    expect(verifyAccessToken(config, legacy).authVersion).toBe(1);

    for (const invalidVersion of [null, 0, 1.5, "1"]) {
      const invalid = jwt.sign({
        sub: "user_invalid",
        email: "invalid@example.test",
        authVersion: invalidVersion,
        platformRoles: [],
        teamRoles: [],
        type: "access"
      }, config.auth.jwtSecret, {
        expiresIn: config.auth.accessTokenTtlSeconds,
        issuer: config.app.name
      });
      expect(() => verifyAccessToken(config, invalid)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    }
  });

  test("treats a malformed encoded session cookie as unauthorized", () => {
    expect(() => accessTokenFromCookie(new Headers({
      cookie: "friday_web_access_token=%"
    }), "web")).toThrow(expect.objectContaining({ code: "unauthorized", status: 401 }));
  });
});

describe("password-change request guard", () => {
  test("requires the exact trusted production protocol, host, and Origin", () => {
    const base = testConfig();
    const config = { ...base, app: { ...base.app, environment: "production" as const } };
    const valid = request("http://relay.example.test/api/user/security/password", {
      host: "relay.example.test",
      origin: "https://relay.example.test",
      "x-forwarded-proto": "https"
    });
    expect(() => assertPasswordChangeRequestOrigin(valid, config)).not.toThrow();
    for (const headers of [
      { host: "relay.example.test", origin: "https://evil.example.test", "x-forwarded-proto": "https" },
      { host: "relay.example.test", origin: "https://relay.example.test/path", "x-forwarded-proto": "https" },
      { host: "relay.example.test", origin: "https://relay.example.test/", "x-forwarded-proto": "https" },
      { host: "relay.example.test", origin: "https://relay.example.test?", "x-forwarded-proto": "https" },
      { host: "relay.example.test", origin: "https://relay.example.test#", "x-forwarded-proto": "https" },
      { host: "relay.example.test?", origin: "https://relay.example.test", "x-forwarded-proto": "https" },
      { host: "relay.example.test", origin: "https://relay.example.test", "x-forwarded-proto": "https,http" },
      { host: "relay.example.test", origin: "https://relay.example.test" }
    ]) {
      expect(() => assertPasswordChangeRequestOrigin(request(valid.url, headers), config)).toThrow(expect.objectContaining({
        code: "request_origin_forbidden",
        status: 403
      }));
    }
  });

  test("accepts only the strict JSON object and enforces the streaming 4096-byte limit", async () => {
    await expect(readPasswordChangeRequestBody(jsonBody({ currentPassword: "old", newPassword: "new" }, "application/json; charset=UTF-8"))).resolves.toEqual({
      currentPassword: "old",
      newPassword: "new"
    });
    for (const value of [
      [],
      { currentPassword: "old" },
      { currentPassword: "old", newPassword: 12 },
      { currentPassword: "old", newPassword: "new", userId: "other" }
    ]) {
      await expect(readPasswordChangeRequestBody(jsonBody(value))).rejects.toMatchObject({ code: "invalid_request_body", status: 400 });
    }
    await expect(readPasswordChangeRequestBody(jsonBody({ currentPassword: "old", newPassword: "new" }, "text/plain"))).rejects.toMatchObject({
      code: "unsupported_media_type",
      status: 415
    });
    for (const malformedQuotedCharset of [
      "application/json; charset=\"utf-8",
      "application/json; charset=utf-8\""
    ]) {
      await expect(readPasswordChangeRequestBody(jsonBody({ currentPassword: "old", newPassword: "new" }, malformedQuotedCharset))).rejects.toMatchObject({
        code: "unsupported_media_type",
        status: 415
      });
    }
    const oversized = new Request("http://relay.example.test/api/user/security/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4097));
          controller.close();
        }
      }),
      duplex: "half"
    } as RequestInit);
    await expect(readPasswordChangeRequestBody(oversized)).rejects.toMatchObject({ code: "request_body_too_large", status: 413 });

    const oversizedWithFailedCancel = new Request("http://relay.example.test/api/user/security/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(4097));
        },
        cancel() {
          throw new Error("cancel failed");
        }
      }),
      duplex: "half"
    } as RequestInit);
    await expect(readPasswordChangeRequestBody(oversizedWithFailedCancel)).rejects.toMatchObject({ code: "request_body_too_large", status: 413 });
  });

  test("creates domain-separated HMAC subjects without exposing the user id or IP", () => {
    const config = testConfig();
    const subjects = passwordChangeRateLimitSubjects(config, new Headers({ "x-real-ip": "192.0.2.10" }), "user_secret");
    expect(subjects.user).toMatch(/^user_id:[0-9a-f]{64}$/u);
    expect(subjects.clientIp).toMatch(/^client_ip:[0-9a-f]{64}$/u);
    expect(JSON.stringify(subjects)).not.toContain("user_secret");
    expect(JSON.stringify(subjects)).not.toContain("192.0.2.10");
    expect(passwordChangeRateLimitSubjects(config, new Headers({ "x-real-ip": "2001:0DB8:0:0:0:0:0:1" }), "user_secret").clientIp)
      .toBe(passwordChangeRateLimitSubjects(config, new Headers({ "x-real-ip": "2001:db8::1" }), "user_secret").clientIp);
    expect(passwordChangeRateLimitSubjects(config, new Headers({ "x-real-ip": "forwarded,chain" }), "user_secret").clientIp)
      .toBe(passwordChangeRateLimitSubjects(config, new Headers(), "user_secret").clientIp);
  });
});

function request(url: string, headers: HeadersInit): Request {
  return new Request(url, { headers });
}

function jsonBody(value: unknown, contentType = "application/json"): Request {
  return new Request("http://relay.example.test/api/user/security/password", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(value)
  });
}
