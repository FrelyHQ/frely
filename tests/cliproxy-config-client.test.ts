import { afterEach, describe, expect, test, vi } from "vitest";
import { CliProxyClient, safeCliProxyRequestHeaders } from "../packages/providers/src/cliproxy/client.js";
import {
  CLIPROXY_REDACTED,
  loadCliProxyConfig,
  safeCliProxyConfig,
  validateCliProxyBaseUrl,
  type CliProxyConfig
} from "../packages/providers/src/cliproxy/config.js";
import { assertProviderPrefix, filterCliProxyCatalogForProvider } from "../packages/providers/src/cliproxy/catalog.js";
import { assertCliProxyKindAuthMethod, CLI_PROXY_KIND_DEFINITIONS } from "../packages/providers/src/cliproxy/provider-kinds.js";
import { validateProviderId } from "../packages/providers/src/cliproxy/provider-id.js";

const INFERENCE_SECRET = "inference-secret-1234567890-abcdefgh";
const MANAGEMENT_SECRET = "management-secret-123456789-abcdefgh";

const config: CliProxyConfig = {
  baseUrl: "http://cli-proxy-api:8317",
  apiKey: INFERENCE_SECRET,
  managementApiKey: MANAGEMENT_SECRET,
  timeoutMs: 1_000
};

afterEach(() => vi.restoreAllMocks());

describe("CLIProxyAPI configuration", () => {
  test("supports Gemini API key only and rejects manual Gemini OAuth submissions", () => {
    expect(CLI_PROXY_KIND_DEFINITIONS.gemini).toMatchObject({
      authMethods: ["api-key"],
      apiKeyManagementPath: "gemini-api-key"
    });
    expect(CLI_PROXY_KIND_DEFINITIONS.gemini).not.toHaveProperty("oauthManagementPath");
    expect(() => assertCliProxyKindAuthMethod("gemini", "oauth")).toThrow(expect.objectContaining({
      code: "cliproxy_auth_method_unsupported"
    }));
  });

  test("validates environment, production host allowlist, and redacts URL and secrets", () => {
    const loaded = loadCliProxyConfig({
      NODE_ENV: "production",
      CLIPROXY_BASE_URL: "http://cli-proxy-api:8317",
      CLIPROXY_API_KEY: INFERENCE_SECRET,
      CLIPROXY_MANAGEMENT_API_KEY: MANAGEMENT_SECRET
    });
    expect(safeCliProxyConfig(loaded)).toEqual({
      baseUrl: CLIPROXY_REDACTED,
      apiKey: CLIPROXY_REDACTED,
      managementApiKey: CLIPROXY_REDACTED,
      timeoutMs: 10 * 60_000
    });
    expect(() => validateCliProxyBaseUrl("http://localhost:8317", { production: true })).toThrow(expect.objectContaining({ code: "cliproxy_configuration_error" }));
    expect(() => validateCliProxyBaseUrl("http://user:secret@cli-proxy-api:8317?q=1#x")).toThrow(expect.objectContaining({ code: "cliproxy_configuration_error" }));
    expect(() => loadCliProxyConfig({ CLIPROXY_API_KEY: "same", CLIPROXY_MANAGEMENT_API_KEY: "same" }))
      .toThrow(expect.objectContaining({ code: "cliproxy_configuration_error" }));
    expect(() => loadCliProxyConfig({ NODE_ENV: "production", CLIPROXY_API_KEY: "short-secret" }))
      .toThrow(expect.objectContaining({ code: "cliproxy_configuration_error" }));
    expect(() => loadCliProxyConfig({ NODE_ENV: "production", CLIPROXY_API_KEY: "<deployment-secret-placeholder-value>" }))
      .toThrow(expect.objectContaining({ code: "cliproxy_configuration_error" }));
  });
});

describe("CLIProxyAPI internal client", () => {
  test.each([
    ["responses", "/v1/responses"],
    ["chat", "/v1/chat/completions"]
  ])("uses the fixed %s endpoint, service authorization, and header allowlist", async (method, endpoint) => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    const client = new CliProxyClient(config, { fetch: fetchMock as typeof fetch });
    const payload = { model: "prv_a/gpt-5", input: "sentinel", stream: false };
    if (method === "responses") await client.responsesJson(payload, { requestId: "req_1", headers: { cookie: "private", authorization: "client-secret", "x-extra": "drop" } });
    if (method === "chat") await client.chatCompletionsJson(payload, { requestId: "req_1", headers: { cookie: "private", authorization: "client-secret", "x-extra": "drop" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://cli-proxy-api:8317${endpoint}`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${INFERENCE_SECRET}`);
    expect(headers.get("x-request-id")).toBe("req_1");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("x-extra")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual(payload);
  });

  test("uses Anthropic-compatible service headers for the fixed Messages endpoint", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    const client = new CliProxyClient(config, { fetch: fetchMock as typeof fetch });
    const payload = { model: "prv_a/claude-sonnet-4", max_tokens: 32, messages: [{ role: "user", content: "ping" }] };

    await client.messagesJson(payload, { requestId: "req_messages", headers: { authorization: "client-secret", "x-api-key": "client-secret" } });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toBe("http://cli-proxy-api:8317/v1/messages");
    expect(headers.get("x-api-key")).toBe(INFERENCE_SECRET);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("x-request-id")).toBe("req_messages");
  });

  test("maps upstream errors without exposing arbitrary body text", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>prompt and credential sentinel</html>", { status: 500 }));
    const client = new CliProxyClient(config, { fetch: fetchMock as typeof fetch });
    await expect(client.responses({ model: "prv/gpt", stream: false })).rejects.toMatchObject({
      code: "cliproxy_unavailable",
      status: 502,
      message: "CLIProxyAPI is temporarily unavailable"
    });
    try {
      await client.responses({ model: "prv/gpt", stream: false });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("sentinel");
    }
  });

  test("keeps a structured CPA 502 as a Provider error while opaque 502 remains unavailable", async () => {
    const structuredClient = new CliProxyClient(config, {
      fetch: vi.fn(async () => Response.json({
        error: { code: "future_upstream_stream_error", message: "arbitrary upstream detail" }
      }, { status: 502 })) as typeof fetch
    });
    await expect(structuredClient.responses({ model: "prv/gpt", stream: true })).rejects.toMatchObject({
      code: "cliproxy_provider_error",
      status: 502,
      retryable: false,
      details: {
        upstreamStatus: 502,
        upstreamCode: "future_upstream_stream_error"
      }
    });

    const opaqueClient = new CliProxyClient(config, {
      fetch: vi.fn(async () => new Response("bad gateway", { status: 502 })) as typeof fetch
    });
    await expect(opaqueClient.responses({ model: "prv/gpt", stream: true })).rejects.toMatchObject({
      code: "cliproxy_unavailable",
      status: 502,
      retryable: true
    });
  });

  test("keeps an explicit retryable upstream code retryable through CPA's structured 502 wrapper", async () => {
    const client = new CliProxyClient(config, {
      fetch: vi.fn(async () => Response.json({
        error: {
          type: "server_error",
          code: "upstream_unavailable",
          message: "arbitrary upstream detail"
        }
      }, { status: 502 })) as typeof fetch
    });

    await expect(client.responses({ model: "prv/gpt", stream: false })).rejects.toMatchObject({
      code: "cliproxy_unavailable",
      status: 502,
      retryable: true,
      details: {
        upstreamStatus: 502,
        upstreamCode: "upstream_unavailable",
        upstreamType: "server_error"
      }
    });
  });

  test.each([
    [400, 400],
    [502, 400]
  ])("maps a structured CPA invalid request from HTTP %i to HTTP %i", async (cpaStatus, expectedStatus) => {
    const client = new CliProxyClient(config, {
      fetch: vi.fn(async () => Response.json({
        error: {
          type: "invalid_request_error",
          code: "input_modality_unsupported",
          message: "prompt and credential sentinel"
        }
      }, { status: cpaStatus })) as typeof fetch
    });

    await expect(client.responses({ model: "prv/gpt", stream: true })).rejects.toMatchObject({
      code: "cliproxy_invalid_request",
      status: expectedStatus,
      retryable: false,
      message: "Provider rejected the request as invalid",
      details: {
        upstreamStatus: cpaStatus,
        upstreamCode: "input_modality_unsupported",
        upstreamType: "invalid_request_error"
      }
    });
    try {
      await client.responses({ model: "prv/gpt", stream: true });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("sentinel");
    }
  });

  test.each([
    [401, undefined, "cliproxy_authentication_failed", 502, false],
    [403, undefined, "cliproxy_access_denied", 502, false],
    [404, undefined, "cliproxy_not_found", 404, false],
    [409, undefined, "cliproxy_conflict", 409, false],
    [418, undefined, "cliproxy_provider_error", 418, false],
    [422, undefined, "cliproxy_unprocessable_request", 422, false],
    [429, undefined, "cliproxy_rate_limited", 429, true],
    [502, "authentication_error", "cliproxy_authentication_failed", 502, false],
    [502, "permission_error", "cliproxy_access_denied", 502, false],
    [502, "rate_limit_error", "cliproxy_rate_limited", 429, true]
  ])("classifies CPA HTTP %i type %s as %s / HTTP %i", async (cpaStatus, providerType, code, expectedStatus, retryable) => {
    const client = new CliProxyClient(config, {
      fetch: vi.fn(async () => Response.json({
        error: {
          ...(providerType ? { type: providerType } : {}),
          code: "safe_provider_code",
          message: "prompt and credential sentinel"
        }
      }, { status: cpaStatus })) as typeof fetch
    });

    await expect(client.responses({ model: "prv/gpt", stream: true })).rejects.toMatchObject({
      code,
      status: expectedStatus,
      retryable,
      details: {
        upstreamStatus: cpaStatus,
        upstreamCode: "safe_provider_code",
        ...(providerType ? { upstreamType: providerType } : {})
      }
    });
  });

  test("rejects successful non-stream responses with a non-JSON content type", async () => {
    const client = new CliProxyClient(config, { fetch: vi.fn(async () => new Response("{}", { headers: { "content-type": "text/plain" } })) as typeof fetch });
    await expect(client.responsesJson({ model: "prv/gpt", stream: false })).rejects.toMatchObject({
      code: "cliproxy_protocol_error"
    });
  });

  test("aborts a request when the caller signal is cancelled", async () => {
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const controller = new AbortController();
    const client = new CliProxyClient(config, { fetch: fetchMock as typeof fetch });
    const pending = client.responses({ model: "prv/gpt", stream: false }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cliproxy_request_aborted" });
  });

  test("uses the fixed models endpoint and enforces request timeout", async () => {
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = new CliProxyClient(config, { fetch: fetchMock as typeof fetch });
    await expect(client.models({ timeoutMs: 5 })).rejects.toMatchObject({ code: "cliproxy_timeout", status: 504 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://cli-proxy-api:8317/v1/models");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  test("keeps successful non-stream response bodies bounded after headers arrive", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      }
    });
    const client = new CliProxyClient(config, {
      fetch: vi.fn(async () => new Response(body, { headers: { "content-type": "application/json" } })) as typeof fetch,
      responseHeaderTimeoutMs: 200,
      nonStreamingBodyTimeoutMs: 40
    });

    await expect(client.responsesJson({ model: "prv/gpt", stream: false })).rejects.toMatchObject({
      code: "cliproxy_timeout",
      status: 504,
      message: "CLIProxyAPI response body timed out"
    });
  });

  test("incrementally parses successful non-stream JSON beyond the retired 16 MiB cap", async () => {
    const payload = "x".repeat(16 * 1024 * 1024 + 1);
    const encoded = new TextEncoder().encode(JSON.stringify({ payload }));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === encoded.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(encoded.byteLength, offset + 64 * 1024);
        controller.enqueue(encoded.subarray(offset, end));
        offset = end;
      }
    });
    const client = new CliProxyClient(config);

    const result = await client.readJson<{ payload: string }>(
      new Response(body, { headers: { "content-type": "application/json" } })
    );

    expect(result.body.payload).toHaveLength(payload.length);
    expect(result.body.payload.at(-1)).toBe("x");
  });

  test("keeps JSON.parse prototype semantics for successful non-stream bodies", async () => {
    const source = "{\"__proto__\":{\"polluted\":true},\"constructor\":{\"safe\":true}}";
    const client = new CliProxyClient(config);

    const result = await client.readJson<Record<string, unknown>>(
      new Response(source, { headers: { "content-type": "application/json" } })
    );

    expect(result.body).toEqual(JSON.parse(source));
    expect(Object.getPrototypeOf(result.body)).toBe(Object.prototype);
    expect(Object.hasOwn(result.body, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("filters arbitrary caller headers", () => {
    expect(Object.fromEntries(safeCliProxyRequestHeaders({ accept: "application/json", authorization: "secret", cookie: "private" })))
      .toEqual({ accept: "application/json" });
  });
});

describe("CLIProxyAPI catalog isolation", () => {
  test("keeps Provider kind definitions limited to auth and control-plane metadata", () => {
    for (const definition of Object.values(CLI_PROXY_KIND_DEFINITIONS)) {
      expect(definition).not.toHaveProperty("runtimeApis");
      expect(definition).not.toHaveProperty("capabilities");
    }
  });

  test.each(["bad/id", "bad\\id", "bad id", "bad%2fid", ".", "..", "-leading", "trailing-"])(
    "uses the same strict Provider ID grammar at catalog boundaries: %s",
    (providerId) => {
      expect(() => assertProviderPrefix(providerId)).toThrow();
      expect(() => validateProviderId(providerId)).toThrowError(expect.objectContaining({ code: "cliproxy_provider_id_invalid" }));
    }
  );

  test("keeps only the current Provider prefix, strips it, applies allowlist, and deduplicates", () => {
    const catalog = { data: [
      { id: "prv_a/gpt-5", owned_by: "a" },
      { id: "prv_b/gpt-5", owned_by: "b" },
      { id: "gpt-5", owned_by: "none" },
      { id: "prv_a/claude", owned_by: "a" },
      { id: "prv_a/gpt-5", owned_by: "duplicate" }
    ] };
    expect(filterCliProxyCatalogForProvider(catalog, "prv_a", ["gpt-5"])).toEqual([{ id: "gpt-5", owned_by: "a" }]);
  });
});
