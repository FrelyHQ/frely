import { errorStatus, RelayError } from "@frely/core";
import { testConfig } from "@frely/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const mocks = vi.hoisted(() => ({ services: vi.fn() }));

vi.mock("../apps/web/lib/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apps/web/lib/server")>()),
  handle: async (_request: Request, action: () => Promise<Response> | Response) => {
    try {
      return await action();
    } catch (error) {
      const code = error instanceof RelayError ? error.code : "internal_error";
      return Response.json({ error: { code } }, { status: errorStatus(error) });
    }
  },
  services: mocks.services,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mocks.services.mockReset();
});

describe("Web User Chat Gateway route", () => {
  it("uses the PostgreSQL runtime user's key, keeps the payload narrow, and returns assistant text only", async () => {
    const fixture = routeFixture();
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(String(input)).toBe("http://gateway-srv:43000/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${fixture.rawKey}`);
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "public-chat-model",
        max_completion_tokens: 512,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${onePixelPng}` } },
          ],
        }],
        stream: false,
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "It is a test image." } }], usage: { total_tokens: 2 } }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req_user_chat" },
      });
    });
    vi.stubGlobal("fetch", fetchImplementation);

    const route = await import("../apps/web/pages/api/user/[[...path]]/route");
    const response = await route.POST(chatRequest({
      model: "public-chat-model",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${onePixelPng}` } },
        ],
      }],
    }), { params: Promise.resolve({ path: ["chat"] }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 200, requestId: "req_user_chat", message: "It is a test image." });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fixture.pageUserAvailableModels).toHaveBeenCalledWith(fixture.userId, { query: "public-chat-model", page: 1, pageSize: 20 });
    expect(fixture.getFirstEnabledApiKeyForUser).toHaveBeenCalledWith(fixture.userId);
    const audit = fixture.audit.mock.calls.find(([entry]) => entry.action === "chat.run")?.[0];
    expect(audit).toEqual(expect.objectContaining({
      actor: { actorType: "user", actorId: fixture.userId },
      source: "web",
      result: "success",
    }));
    expect(JSON.stringify(audit)).not.toContain(fixture.rawKey);
    expect(JSON.stringify(audit)).not.toContain(onePixelPng);
  });

  it("rejects a model outside the PostgreSQL user-visible AccessPoint set", async () => {
    const fixture = routeFixture({ visible: false });
    const fetchImplementation = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImplementation);
    const route = await import("../apps/web/pages/api/user/[[...path]]/route");

    const response = await route.POST(chatRequest({
      model: "not-visible",
      messages: [{ role: "user", content: "hello" }],
    }), { params: Promise.resolve({ path: ["chat"] }) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: "chat_model_not_available" }) }));
    expect(fixture.pageUserAvailableModels).toHaveBeenCalledWith(fixture.userId, { query: "not-visible", page: 1, pageSize: 20 });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

function routeFixture(input: { visible?: boolean } = {}) {
  const config = testConfig();
  const userId = "user_user_chat";
  const rawKey = "fr_user_chat_secret_not_logged";
  const pageUserAvailableModels = vi.fn(async () => ({
    items: input.visible === false ? [] : [{ exposedModel: "public-chat-model" }],
    page: 1,
    pageSize: 20,
    total: input.visible === false ? 0 : 1,
    totalPages: 1,
  }));
  const getFirstEnabledApiKeyForUser = vi.fn(async () => ({ id: "key_user_chat", userId, keyValue: rawKey }));
  const getUser = vi.fn(async () => ({ id: userId }));
  const audit = vi.fn(async () => undefined);
  const postgres = {
    pageUserAvailableModels,
    getFirstEnabledApiKeyForUser,
    getUser,
    audit,
    deleteExpiredAbuseRateLimits: vi.fn(async () => 0),
    consumeAbuseRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    inspectAbuseRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  };
  mocks.services.mockResolvedValue({
    config,
    application: { commands: postgres, queries: postgres, audit: { record: audit } },
    client: undefined,
    tenancy: undefined,
    asyncTenancy: {
      requireUser: vi.fn(async () => ({ sub: userId, email: "user-chat@example.local", platformRoles: [], teamRoles: [] })),
      identity: { findFirstEnabledApiKeyForUser: getFirstEnabledApiKeyForUser, getUser },
    },
  });
  return { audit, getFirstEnabledApiKeyForUser, pageUserAvailableModels, rawKey, userId };
}

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/api/user/chat", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", "x-request-id": "req_web_user_chat" },
    body: JSON.stringify(body),
  });
}
