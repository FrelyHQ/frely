import { describe, expect, test } from "vitest";
import {
  errorPayload,
  assertProviderBaseUrl,
  parseConfiguredPrivateProviderOrigin,
  matchesImageContentType,
  readBoundedRequestBody,
  readBoundedRequestFormData,
  RelayError,
  requestIdFromHeaders,
  resolveExternalOriginFromHeaders,
  resolveExternalRequestOrigin
} from "./index.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("shared HTTP metadata boundary", () => {
  test("keeps safe caller request ids and replaces unsafe values", () => {
    expect(requestIdFromHeaders(new Headers({ "x-request-id": "req_client.trace-1" }))).toBe("req_client.trace-1");

    for (const requestId of ["../capture", "req/child", "x".repeat(193), ""]) {
      expect(requestIdFromHeaders(new Headers({ "x-request-id": requestId }))).toMatch(/^req_[0-9a-f]{24}$/);
    }
  });

  test("returns allowlisted Relay errors without exposing unexpected exception text", () => {
    expect(errorPayload(
      new RelayError("budget_denied", "Budget denied", 429, { metric: "tokens" }),
      "req_relay_error"
    )).toEqual({
      error: {
        code: "budget_denied",
        message: "Budget denied",
        metric: "tokens",
        requestId: "req_relay_error"
      }
    });
    expect(errorPayload(
      new Error("credential=secret-value path=/private/database.dat"),
      "req_internal_error"
    )).toEqual({
      error: {
        code: "internal_error",
        message: "Unexpected error",
        requestId: "req_internal_error"
      }
    });
  });

  test("bounds streamed bodies before parsing even without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      }
    });
    const request = new Request("https://relay.example.test/api", {
      method: "POST",
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedRequestBody(request, 5)).rejects.toMatchObject({
      code: "request_body_too_large",
      status: 413
    });
  });

  test("rejects oversized declared bodies before reading the stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      }
    });
    const request = new Request("https://relay.example.test/api", {
      method: "POST",
      headers: { "content-length": "6" },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedRequestBody(request, 5)).rejects.toMatchObject({
      code: "request_body_too_large",
      status: 413
    });
  });

  test("parses bounded multipart data and validates image signatures", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "proof.png", { type: "image/png" }));
    const request = new Request("https://relay.example.test/upload", { method: "POST", body: form });
    const parsed = await readBoundedRequestFormData(request, 1_024);

    expect(parsed.get("file")).toBeInstanceOf(File);
    expect(matchesImageContentType(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).toBe(true);
    expect(matchesImageContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png")).toBe(true);
    expect(matchesImageContentType(new TextEncoder().encode("RIFF0000WEBP"), "image/webp")).toBe(true);
    expect(matchesImageContentType(new TextEncoder().encode("<html>"), "image/png")).toBe(false);
  });
});

describe("external request origin boundary", () => {
  test("uses the preserved Host and exact forwarded protocol instead of the internal request URL", () => {
    const request = new Request("http://127.0.0.1:43001/api/auth/login", {
      headers: {
        host: "PUBLIC.Example.test:443",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "attacker.example.test"
      }
    });
    expect(resolveExternalRequestOrigin(request)).toBe("https://public.example.test");
  });

  test("supports direct HTTP/HTTPS and canonicalizes default ports, case, and IPv6", () => {
    expect(resolveExternalRequestOrigin(new Request("http://LOCALHOST:80/api"))).toBe("http://localhost");
    expect(resolveExternalRequestOrigin(new Request("https://Example.test:443/api"))).toBe("https://example.test");
    expect(resolveExternalRequestOrigin(new Request("http://[2001:DB8::1]:80/api"))).toBe("http://[2001:db8::1]");
    expect(resolveExternalOriginFromHeaders(new Headers({ host: "Example.test:443", "x-forwarded-proto": "https" }))).toBe("https://example.test");
  });

  test("fails closed for ambiguous protocols, malformed hosts, and unsupported direct URLs", () => {
    for (const headers of [
      { host: "example.test", "x-forwarded-proto": "https,http" },
      { host: "example.test", "x-forwarded-proto": "https http" },
      { host: "example.test", "x-forwarded-proto": "ftp" },
      { host: "example.test", "x-forwarded-proto": "" },
      { host: "example.test/path", "x-forwarded-proto": "https" },
      { host: "user@example.test", "x-forwarded-proto": "https" },
      { host: "example.test?query", "x-forwarded-proto": "https" },
      { host: "example.test\\\\path", "x-forwarded-proto": "https" }
    ]) {
      expect(resolveExternalRequestOrigin(new Request("http://127.0.0.1/api", { headers }))).toBeNull();
    }
    expect(resolveExternalRequestOrigin(new Request("http://127.0.0.1/api", {
      headers: { host: "example.test", "x-forwarded-proto": "https", "x-forwarded-host": "a,b" }
    }))).toBe("https://example.test");
    expect(resolveExternalRequestOrigin(new Request("file:///tmp/request"))).toBeNull();
    expect(resolveExternalOriginFromHeaders(new Headers({ host: "example.test" }))).toBeNull();
  });
});

describe("Provider Base URL policy", () => {
  test("accepts public HTTPS and the explicitly configured private origin only", async () => {
    await expect(assertProviderBaseUrl("https://provider.example/v1", { resolve: publicLookup })).resolves.toBeUndefined();
    await expect(assertProviderBaseUrl("http://100.100.10.20:43003/v1", { privateOrigin: "http://100.100.10.20:43003", resolve: publicLookup })).resolves.toBeUndefined();
    await expect(assertProviderBaseUrl("http://100.100.10.20:43003/v2", { privateOrigin: "http://100.100.10.20:43003", resolve: publicLookup })).rejects.toMatchObject({ code: "provider_url_not_allowed" });
    await expect(assertProviderBaseUrl("http://100.100.10.21:43003/v1", { privateOrigin: "http://100.100.10.20:43003", resolve: publicLookup })).rejects.toMatchObject({ code: "provider_url_not_allowed" });
  });

  test("rejects invalid, non-HTTPS, and internal public URLs", async () => {
    await expect(assertProviderBaseUrl("not a URL", { resolve: publicLookup })).rejects.toMatchObject({ code: "invalid_provider_url" });
    await expect(assertProviderBaseUrl("http://provider.example", { resolve: publicLookup })).rejects.toMatchObject({ code: "provider_url_not_allowed" });
    await expect(assertProviderBaseUrl("https://127.0.0.1/v1", { resolve: publicLookup })).rejects.toMatchObject({ code: "provider_url_not_allowed" });
    await expect(assertProviderBaseUrl("https://provider.example/v1", { resolve: async () => [{ address: "10.0.0.8", family: 4 }] })).rejects.toMatchObject({ code: "provider_url_not_allowed" });
  });

  test("requires the private origin to be an explicit HTTP CGNAT IPv4 origin", () => {
    expect(parseConfiguredPrivateProviderOrigin("http://100.127.1.2:43003")).toEqual({ origin: "http://100.127.1.2:43003", hostname: "100.127.1.2", port: 43003 });
    for (const value of ["https://100.127.1.2:43003", "http://10.0.0.1:43003", "http://100.127.1.2", "http://100.127.1.2:43003/path"]) {
      expect(() => parseConfiguredPrivateProviderOrigin(value)).toThrowError(new RelayError("provider_private_origin_invalid", "Configured private Provider origin is invalid", 400));
    }
  });
});
