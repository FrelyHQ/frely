import { describe, expect, test } from "vitest";
import { createBrowserTelemetryHandler } from "./server.js";

describe("same-origin browser telemetry handler", () => {
  const POST = createBrowserTelemetryHandler({
    dialogNames: ["team-create"],
    release: "release-test",
    routeNames: ["/owner/teams"],
    service: "admin",
  });

  test("accepts an allowlisted Surface without exposing an ingestion endpoint", async () => {
    const response = await POST(request({
      kind: "ui_surface",
      durationMs: 420,
      result: "success",
      surfaceName: "/owner/teams",
      surfaceType: "page",
    }));
    expect(response.status).toBe(202);
  });

  test("accepts the external same origin behind a trusted reverse proxy", async () => {
    const response = await POST(request({
      kind: "ui_surface",
      durationMs: 420,
      result: "success",
      surfaceName: "/owner/teams",
      surfaceType: "page",
    }, {
      host: "admin.example.test",
      origin: "https://admin.example.test",
      "x-forwarded-proto": "https",
    }, "https://0.0.0.0:43002/api/telemetry/browser"));
    expect(response.status).toBe(202);
  });

  test("fails closed for internal, cross-origin, and ambiguous proxy origins", async () => {
    const body = {
      kind: "ui_surface",
      durationMs: 420,
      result: "success",
      surfaceName: "/owner/teams",
      surfaceType: "page",
    };
    const internalUrl = "https://0.0.0.0:43002/api/telemetry/browser";
    const proxyHeaders = {
      host: "admin.example.test",
      origin: "https://admin.example.test",
      "x-forwarded-proto": "https",
    };

    expect((await POST(request(body, {
      ...proxyHeaders,
      origin: "https://0.0.0.0:43002",
    }, internalUrl))).status).toBe(403);
    expect((await POST(request(body, {
      ...proxyHeaders,
      origin: "https://attacker.invalid",
    }, internalUrl))).status).toBe(403);
    expect((await POST(request(body, {
      ...proxyHeaders,
      "x-forwarded-proto": "https, http",
    }, internalUrl))).status).toBe(403);
    expect((await POST(request(body, {
      ...proxyHeaders,
      host: "admin.example.test,attacker.invalid",
    }, internalUrl))).status).toBe(403);
  });

  test("rejects cross-origin, unknown, extra, and oversized payloads", async () => {
    expect((await POST(request({
      kind: "ui_surface",
      durationMs: 420,
      result: "success",
      surfaceName: "/owner/teams",
      surfaceType: "page",
    }, { origin: "https://attacker.invalid" }))).status).toBe(403);
    expect((await POST(new Request("https://admin.example.test/api/telemetry/browser", {
      method: "POST",
      body: JSON.stringify({
        kind: "ui_surface",
        durationMs: 420,
        result: "success",
        surfaceName: "/owner/teams",
        surfaceType: "page",
      }),
      headers: { "content-type": "application/json" },
    }))).status).toBe(403);
    expect((await POST(request({
      kind: "ui_surface",
      durationMs: 420,
      result: "success",
      surfaceName: "/owner/teams/team_123",
      surfaceType: "page",
    }))).status).toBe(400);
    expect((await POST(request({
      kind: "ui_surface",
      durationMs: 420,
      result: "success",
      surfaceName: "team-create",
      surfaceType: "dialog",
      userId: "user_secret",
    }))).status).toBe(400);
    const oversized = new Request("https://admin.example.test/api/telemetry/browser", {
      method: "POST",
      body: JSON.stringify({ padding: "x".repeat(2_100) }),
      headers: {
        "content-type": "application/json",
        origin: "https://admin.example.test",
        "sec-fetch-site": "same-origin",
      },
    });
    expect((await POST(oversized)).status).toBe(413);

    const streamedOversized = new Request("https://admin.example.test/api/telemetry/browser", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"padding":"${"x".repeat(2_100)}`));
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
      duplex: "half",
      headers: {
        "content-type": "application/json",
        origin: "https://admin.example.test",
        "sec-fetch-site": "same-origin",
      },
    } as RequestInit & { duplex: "half" });
    expect((await POST(streamedOversized)).status).toBe(413);
  });
});

function request(
  body: object,
  headers: Record<string, string> = {},
  url = "https://admin.example.test/api/telemetry/browser",
): Request {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: "https://admin.example.test",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
  });
}
