import { describe, expect, test } from "vitest";
import {
  authMutationHeaders,
  createValidatedAuthMutationRequest,
} from "./auth-mutation-request.js";

describe("validated authentication mutation boundary", () => {
  test("accepts canonical, Public Host, DomainBinding, and private Admin origins after façade admission", () => {
    for (const origin of [
      "https://relay.example.test",
      "https://public.example.test",
      "https://bound.customer.example.test",
    ]) {
      const request = new Request("http://service-internal:43001/api/auth/login", {
        method: "POST",
        headers: { host: new URL(origin).host, "x-forwarded-proto": "https", origin },
      });
      expect(() => createValidatedAuthMutationRequest(request, origin)).not.toThrow();
    }
    const adminRequest = new Request("http://admin-internal:43002/api/auth/login", {
      method: "POST",
      headers: { host: "admin.private.example.test", "x-forwarded-proto": "https", origin: "https://admin.private.example.test" },
    });
    expect(() => createValidatedAuthMutationRequest(adminRequest)).not.toThrow();
  });

  test("accepts canonical, forwarded external origin and only exposes approved metadata", () => {
    const request = new Request("http://identity-internal:43001/api/auth/login", {
      method: "POST",
      headers: {
        host: "login.example.test",
        "x-forwarded-proto": "https",
        origin: "https://login.example.test",
        referer: "https://login.example.test/login?next=%2Fuser",
        cookie: "friday_session_token=opaque",
        "user-agent": "focused-test",
        "sec-fetch-site": "same-origin",
        "x-forwarded-host": "attacker.example.test",
        authorization: "Bearer must-not-cross-boundary",
      },
      body: "{\"email\":\"user@example.test\",\"password\":\"secret\"}",
    });

    const context = createValidatedAuthMutationRequest(request, "https://login.example.test");
    const headers = authMutationHeaders(context);
    expect(headers.get("cookie")).toBe("friday_session_token=opaque");
    expect(headers.get("user-agent")).toBe("focused-test");
    expect(headers.get("sec-fetch-site")).toBe("same-origin");
    expect(headers.get("origin")).toBeNull();
    expect(headers.get("referer")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(headers.get("x-forwarded-host")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  test("supports trusted server-side calls without Origin or Referer", () => {
    const request = new Request("http://127.0.0.1:43001/api/auth/login", {
      method: "POST",
      headers: { host: "127.0.0.1:43001" },
    });
    expect(() => createValidatedAuthMutationRequest(request, "http://127.0.0.1:43001")).not.toThrow();
  });

  test("rejects origin, referer, fetch metadata, and proxy ambiguity before body consumption", async () => {
    const cases = [
      { origin: "https://evil.example.test" },
      { origin: "null" },
      { origin: "https://login.example.test/path" },
      { origin: "https://login.example.test, https://evil.example.test" },
      { referer: "https://evil.example.test/page" },
      { origin: "https://login.example.test", referer: "https://evil.example.test/page" },
      { origin: "https://login.example.test", "sec-fetch-site": "cross-site" },
      { origin: "https://login.example.test", "x-forwarded-proto": "https,http" },
    ];

    for (const extraHeaders of cases) {
      let consumed = false;
      const request = new Request("http://identity-internal:43001/api/auth/login", {
        method: "POST",
        headers: {
          host: "login.example.test",
          "x-forwarded-proto": "https",
          ...extraHeaders,
        },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            consumed = true;
            controller.enqueue(new TextEncoder().encode("secret-body"));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      expect(() => createValidatedAuthMutationRequest(request, "https://login.example.test")).toThrow(
        expect.objectContaining({ code: "request_origin_forbidden", status: 403 }),
      );
      expect(consumed).toBe(false);
    }

  });

  test("requires the façade's expected Host scope and fails closed for missing or malformed transport", () => {
    for (const request of [
      new Request("http://identity-internal:43001/api/auth/login", { headers: { host: "other.example.test", "x-forwarded-proto": "https", origin: "https://other.example.test" } }),
      new Request("http://identity-internal:43001/api/auth/login", { headers: { host: "login.example.test", "x-forwarded-proto": "ftp", origin: "https://login.example.test" } }),
      new Request("http://identity-internal:43001/api/auth/login", { headers: { host: "login.example.test/path", "x-forwarded-proto": "https", origin: "https://login.example.test" } }),
    ]) {
      expect(() => createValidatedAuthMutationRequest(request, "https://login.example.test")).toThrow(
        expect.objectContaining({ code: "request_origin_forbidden", status: 403 }),
      );
    }
  });
});
