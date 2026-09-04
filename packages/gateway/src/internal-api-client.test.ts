import { describe, expect, it, vi } from "vitest";
import {
  InternalGatewayClient,
  loadInternalGatewayClientConfig,
  validateInternalGatewayBaseUrl
} from "./internal-api-client.js";

describe("InternalGatewayClient", () => {
  it("allows only the fixed Compose Gateway origin in production", () => {
    expect(loadInternalGatewayClientConfig({ NODE_ENV: "production" })).toEqual({ baseUrl: "http://gateway-srv:43000" });
    expect(() => validateInternalGatewayBaseUrl("https://relay.example", { production: true }))
      .toThrow(expect.objectContaining({ code: "internal_gateway_configuration_error" }));
    expect(() => validateInternalGatewayBaseUrl("http://gateway-srv:43000/path"))
      .toThrow(expect.objectContaining({ code: "internal_gateway_configuration_error" }));
    expect(() => validateInternalGatewayBaseUrl("http://user:secret@gateway-srv:43000"))
      .toThrow(expect.objectContaining({ code: "internal_gateway_configuration_error" }));
  });

  it("forwards the real API key, payload, and request id to an allowlisted Gateway path", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "chatcmpl_1" }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req_gateway" }
    }));
    const client = new InternalGatewayClient({ baseUrl: "http://gateway-srv:43000" }, fetchImplementation);

    const result = await client.invoke({
      path: "/v1/chat/completions",
      apiKey: "sk-real-secret",
      payload: { model: "public-model", messages: [{ role: "user", content: "hello" }] },
      requestId: "req_console",
      canonicalClientIp: { header: "x-real-ip", value: "203.0.113.7" }
    });

    expect(result).toEqual({ status: 200, body: { id: "chatcmpl_1" }, requestId: "req_gateway" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe("http://gateway-srv:43000/v1/chat/completions");
    expect(init).toEqual(expect.objectContaining({ method: "POST", body: JSON.stringify({ model: "public-model", messages: [{ role: "user", content: "hello" }] }) }));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-real-secret");
    expect(new Headers(init?.headers).get("x-request-id")).toBe("req_console");
    expect(new Headers(init?.headers).get("x-real-ip")).toBe("203.0.113.7");
  });

  it("keeps Gateway error bodies and maps network failures without leaking the key", async () => {
    const gatewayErrorClient = new InternalGatewayClient(
      { baseUrl: "http://gateway-srv:43000" },
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "insufficient_credit" } }), { status: 402 }))
    );
    await expect(gatewayErrorClient.invoke({
      path: "/v1/responses",
      apiKey: "sk-error-secret",
      payload: { model: "public-model", input: "hello" }
    })).resolves.toEqual({ status: 402, body: { error: { code: "insufficient_credit" } }, requestId: null });

    const unavailableClient = new InternalGatewayClient(
      { baseUrl: "http://gateway-srv:43000" },
      vi.fn<typeof fetch>().mockRejectedValue(new Error("connect ECONNREFUSED sk-network-secret"))
    );
    await expect(unavailableClient.invoke({
      path: "/v1/messages",
      apiKey: "sk-network-secret",
      payload: { model: "public-model", messages: [] }
    })).rejects.toMatchObject({ code: "gateway_unavailable", message: "Gateway API is unavailable", status: 503 });
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    const client = new InternalGatewayClient({ baseUrl: "http://gateway-srv:43000" }, fetchImplementation);

    await expect(client.invoke({
      path: "/v1/chat/completions",
      apiKey: "sk-abort-secret",
      payload: { model: "public-model" },
      signal: controller.signal
    })).rejects.toBe(reason);
  });
});
