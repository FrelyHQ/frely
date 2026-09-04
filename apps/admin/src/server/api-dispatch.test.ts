import { describe, expect, test, vi } from "vitest";
import { dispatchApiRoutes, type AdminApiRouteDefinition, type AdminRouteModule } from "./api-dispatch";
import { adminApiRouteInventory } from "./api-dispatcher";
import { withAdminSecurityHeaders } from "./security-response";

describe("Admin Start API dispatch", () => {
  test("keeps the accepted 33-family and 42-method inventory", () => {
    expect(adminApiRouteInventory()).toEqual({ families: 33, methods: 42 });
  });

  test("passes the original request, raw body, abort signal, response stream, and cookies through unchanged", async () => {
    const controller = new AbortController();
    const request = new Request("http://admin.test/api/upload/item-1", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=raw-boundary" },
      body: "--raw-boundary\r\nraw-bytes\r\n--raw-boundary--",
      signal: controller.signal,
    });
    const stream = new ReadableStream<Uint8Array>();
    const headers = new Headers();
    headers.append("set-cookie", "access=a; Path=/; HttpOnly");
    headers.append("set-cookie", "refresh=b; Path=/; HttpOnly");
    const expectedResponse = new Response(stream, { status: 206, headers });
    const handler = vi.fn(async (received: Request, context: { params: Promise<Record<string, string | string[]>> }) => {
      expect(received).toBe(request);
      expect(received.signal).toBe(request.signal);
      expect(received.headers.get("content-type")).toBe("multipart/form-data; boundary=raw-boundary");
      expect(await context.params).toEqual({ id: "item-1" });
      return expectedResponse;
    });

    const response = await dispatchApiRoutes(request, [route(
      /^\/api\/upload\/([^/]+)\/?$/,
      [{ name: "id", catchall: false }],
      ["POST"],
      { POST: handler },
    )]);

    expect(response).toBe(expectedResponse);
    expect(response.body).toBe(stream);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("decodes catch-all params and supplies automatic HEAD and OPTIONS semantics", async () => {
    const releaseCaptureSlot = vi.fn();
    const get = vi.fn(async (_request: Request, context: { params: Promise<Record<string, string | string[]>> }) => {
      expect(await context.params).toEqual({ path: ["folder name", "asset.bin"] });
      const headers = new Headers({ "content-type": "application/octet-stream", "x-source": "get" });
      headers.append("set-cookie", "session=renewed; Path=/; HttpOnly");
      const body = new ReadableStream<Uint8Array>({ cancel: releaseCaptureSlot });
      return new Response(body, { status: 200, headers });
    });
    const routes = [route(
      /^\/api\/files(?:\/(.*))?\/?$/,
      [{ name: "path", catchall: true }],
      ["GET"],
      { GET: get },
    )];

    const headResponse = await dispatchApiRoutes(
      new Request("http://admin.test/api/files/folder%20name/asset.bin", { method: "HEAD" }),
      routes,
    );
    expect(headResponse.status).toBe(200);
    expect(headResponse.body).toBeNull();
    expect(headResponse.headers.get("content-type")).toBe("application/octet-stream");
    expect(headResponse.headers.get("set-cookie")).toContain("session=renewed");
    expect(releaseCaptureSlot).toHaveBeenCalledWith("automatic-head-response");

    const optionsResponse = await dispatchApiRoutes(
      new Request("http://admin.test/api/files/folder%20name/asset.bin", { method: "OPTIONS" }),
      routes,
    );
    expect(optionsResponse.status).toBe(204);
    expect(optionsResponse.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  test("rejects malformed path encoding without invoking a handler", async () => {
    const get = vi.fn(() => Response.json({ ok: true }));
    const routes = [route(
      /^\/api\/files(?:\/(.*))?\/?$/,
      [{ name: "path", catchall: true }],
      ["GET"],
      { GET: get },
    )];

    const response = await dispatchApiRoutes(
      new Request("http://admin.test/api/files/%E0%A4%A"),
      routes,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_path_encoding" });
    expect(get).not.toHaveBeenCalled();
  });

  test("preserves noncanonical empty catch-all segments for bounded handler rejection", async () => {
    const get = vi.fn(async (_request: Request, context: { params: Promise<Record<string, string | string[]>> }) => {
      expect(await context.params).toEqual({ path: ["folder", "", "asset.bin"] });
      return Response.json({ ok: true });
    });
    const response = await dispatchApiRoutes(
      new Request("http://admin.test/api/files/folder//asset.bin"),
      [route(/^\/api\/files(?:\/(.*))?\/?$/, [{ name: "path", catchall: true }], ["GET"], { GET: get })],
    );

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("adds security headers without collapsing cookies or breaking stream cancellation", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const headers = new Headers();
    headers.append("set-cookie", "access=a; Path=/; HttpOnly");
    headers.append("set-cookie", "refresh=b; Path=/; HttpOnly");

    const response = withAdminSecurityHeaders(new Response(stream, { headers }), true);
    const cookieHeaders = response.headers as Headers & { getSetCookie?: () => string[] };

    const cookies = cookieHeaders.getSetCookie?.()
      ?? response.headers.get("set-cookie")?.split(/,\s*(?=[^;,]+=)/)
      ?? [];
    expect(cookies).toHaveLength(2);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    await response.body?.cancel("client-disconnected");
    expect(cancel).toHaveBeenCalledWith("client-disconnected");
  });

  test("returns bounded 405 and 404 responses without invoking an unrelated handler", async () => {
    const get = vi.fn(() => Response.json({ ok: true }));
    const routes = [route(/^\/api\/health\/?$/, [], ["GET"], { GET: get })];

    const methodResponse = await dispatchApiRoutes(
      new Request("http://admin.test/api/health", { method: "DELETE" }),
      routes,
    );
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    await expect(methodResponse.json()).resolves.toEqual({ error: "method_not_allowed" });

    const missingResponse = await dispatchApiRoutes(
      new Request("http://admin.test/api/missing"),
      routes,
    );
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({ error: "not_found" });
    expect(get).not.toHaveBeenCalled();
  });
});

function route(
  pattern: RegExp,
  params: AdminApiRouteDefinition["params"],
  methods: readonly string[],
  module: AdminRouteModule,
): AdminApiRouteDefinition {
  return { pattern, params, methods, module };
}
