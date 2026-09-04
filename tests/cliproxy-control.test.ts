import { createServer } from "node:http";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CpaManagementClient } from "../apps/cliproxy-control/src/cpa.js";
import { CliProxyControlService } from "../apps/cliproxy-control/src/service.js";
import { CredentialStore } from "../apps/cliproxy-control/src/store.js";
import { CLIPROXY_CONTROL_PAYLOAD_MAX_BYTES, CliProxyControlClient } from "../packages/providers/src/cliproxy/control-client.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("cliproxy-control CPA-only credential ownership", () => {
  test("captures only the sanitized runtime identity from an authenticated Management response", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-cpa-version", "v7.2.145");
      response.setHeader("x-cpa-commit", "D9CEA89");
      response.setHeader("x-cpa-build-date", "2026-08-28T09:30:55Z");
      response.setHeader("x-friday-cpa-evidence-contract", "cpa-basic@1");
      response.setHeader("x-friday-cpa-adaptation", "friday-evidence-v1");
      response.setHeader("authorization", "must-not-be-forwarded");
      response.end(JSON.stringify({ "force-model-prefix": true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server unavailable");
      const cpa = new CpaManagementClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        managementKey: "m".repeat(32),
        inferenceKey: "i".repeat(32)
      });
      await cpa.assertForceModelPrefix();
      expect(cpa.runtimeIdentity()).toEqual({
        version: "v7.2.145",
        commit: "d9cea89",
        buildDate: "2026-08-28T09:30:55.000Z",
        evidenceContract: "cpa-basic@1",
        adaptation: "friday-evidence-v1"
      });
      expect(cpa.runtimeIdentity()).not.toHaveProperty("authorization");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("binds semantic probes to the exact auth identity without exposing the pin to ordinary callers", async () => {
    const observed: Array<{ authorization: string | undefined; authId: string | undefined; probeKey: string | undefined; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v0/management/auth-files") {
        response.end(JSON.stringify({ files: [{
          id: "oauth-exact.json", auth_index: "auth-exact-one", name: "oauth-exact.json", prefix: "codex-a",
          provider: "codex", status: "active", disabled: false, unavailable: false,
        }] }));
        return;
      }
      if (request.url === "/v1/chat/completions") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
        observed.push({
          authorization: request.headers.authorization,
          authId: request.headers["x-friday-cpa-probe-auth-id"] as string | undefined,
          probeKey: request.headers["x-friday-cpa-probe-key"] as string | undefined,
          body,
        });
        response.end(JSON.stringify(body.model === "codex-a/invalid"
          ? { choices: [{}] }
          : { choices: [{ message: { role: "assistant", content: "OK" } }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server unavailable");
      const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
      directories.push(directory);
      const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 31));
      await store.load();
      const credential = await store.upsert({
        ref: "auth-exact-one", providerId: "codex-a", kind: "codex", authMethod: "oauth", authFileName: "oauth-exact.json",
        config: { models: [{ name: "gpt-5.4-upstream", alias: "gpt-5.4" }] },
      });
      const cpa = new CpaManagementClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        managementKey: "m".repeat(32),
        inferenceKey: "i".repeat(32),
      });
      await expect(cpa.semanticProbe(credential, "gpt-5.4")).resolves.toMatchObject({
        credentialRef: "auth-exact-one", model: "gpt-5.4", semanticStatus: "ready",
      });
      await expect(cpa.semanticProbe(credential, "invalid")).rejects.toThrow("cliproxy_credential_probe_invalid_response");
      expect(observed).toEqual([
        {
          authorization: `Bearer ${"i".repeat(32)}`,
          authId: "auth-exact-one",
          probeKey: "m".repeat(32),
          body: expect.objectContaining({ model: "codex-a/gpt-5.4", stream: false, store: false }),
        },
        {
          authorization: `Bearer ${"i".repeat(32)}`,
          authId: "auth-exact-one",
          probeKey: "m".repeat(32),
          body: expect.objectContaining({ model: "codex-a/invalid", stream: false, store: false }),
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("retries an idempotent credential PUT with a fresh dispatcher after Control restart", async () => {
    vi.useFakeTimers();
    const fetchControl = vi.fn()
      .mockRejectedValueOnce(new TypeError("stale control connection"))
      .mockRejectedValueOnce(new TypeError("control connection is restarting"));
    fetchControl.mockResolvedValueOnce(new Response(JSON.stringify({
      credentialRef: "credential-restart-window",
      providerId: "provider-restart-window",
      kind: "codex",
      authMethod: "api-key",
      preview: "configured",
      status: "ready",
      failureReason: null,
      errorCode: null,
      updatedAt: "2026-08-29T00:00:00.000Z",
      models: ["model-restart-window"],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchControl);

    const client = new CliProxyControlClient({
      baseUrl: "http://cliproxy-control.test",
      apiKey: "c".repeat(32),
    });
    const result = client.putApiKey({
      providerId: "provider-restart-window",
      kind: "codex",
      apiKey: "provider-restart-window-key",
      models: [{ name: "model-restart-window", alias: "model-restart-window" }],
    });

    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({
      providerId: "provider-restart-window",
      status: "ready",
    });
    expect(fetchControl).toHaveBeenCalledTimes(3);
    expect(fetchControl.mock.calls.every(([, init]) => init.method === "PUT")).toBe(true);
    expect(new Set(fetchControl.mock.calls.map(([, init]) => init.dispatcher)).size).toBe(3);
  });

  test("rejects mismatched credential reason and public error DTO fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      credentialRef: "credential-health-mismatch",
      providerId: "provider-health-mismatch",
      kind: "codex",
      authMethod: "api-key",
      preview: "configured",
      status: "unready",
      failureReason: "auth_unavailable",
      errorCode: "cliproxy_provider_credentials_unauthorized",
      updatedAt: "2026-08-29T00:00:00.000Z",
      models: ["model-a"],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const client = new CliProxyControlClient({ baseUrl: "http://cliproxy-control.test", apiKey: "c".repeat(32) });

    await expect(client.getCredential("provider-health-mismatch"))
      .rejects.toMatchObject({ code: "cliproxy_control_invalid_response" });
  });

  test("uses one control payload contract for catalogs beyond the retired outer reader limit", async () => {
    const models = Array.from({ length: 12_000 }, (_, index) => `model-${String(index).padStart(5, "0")}-${"x".repeat(80)}`);
    const encoded = JSON.stringify({ models });
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(encoded)).toBeLessThan(CLIPROXY_CONTROL_PAYLOAD_MAX_BYTES);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(encoded);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server unavailable");
      const client = new CliProxyControlClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "c".repeat(32)
      });
      await expect(client.catalog("large-catalog")).resolves.toEqual(models);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("allows only the configured exact Tailscale Provider origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 15));
    const service = new CliProxyControlService(store, oauthCpa({
      catalog: async () => ["tailnet-model"]
    }), { privateProviderOrigin: "http://100.64.0.10:43003" });
    await service.initialize();

    await expect(service.putCredential("tailscale-canary", {
      kind: "openai-compatible",
      apiKey: "tailnet-provider-key",
      baseUrl: "http://100.64.0.10:43003/v1",
      models: [{ name: "tailnet-model", alias: "tailnet-model" }]
    })).resolves.toMatchObject({ providerId: "tailscale-canary", status: "ready" });

    await expect(service.putCredential("other-private", {
      kind: "openai-compatible",
      apiKey: "other-private-key",
      baseUrl: "http://100.64.0.11:43003/v1",
      models: [{ name: "tailnet-model", alias: "tailnet-model" }]
    })).rejects.toThrow("cliproxy_base_url_not_allowed");

    const previous = store.get("tailscale-canary");
    const reconcile = vi.fn(async () => undefined);
    const guardedService = new CliProxyControlService(store, oauthCpa({ reconcile }), { privateProviderOrigin: "http://100.64.0.10:43003" });
    await expect(guardedService.putCredential("tailscale-canary", {
      kind: "openai-compatible",
      apiKey: "replacement-key",
      baseUrl: "http://100.64.0.11:43003/v1",
      models: [{ name: "tailnet-model", alias: "tailnet-model" }]
    })).rejects.toThrow("cliproxy_base_url_not_allowed");
    expect(store.get("tailscale-canary")).toEqual(previous);
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("persists a stable opaque ref in an encrypted store without returning or storing plaintext in Friday", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const path = join(directory, "credentials.v1.enc");
    const key = Buffer.alloc(32, 7);
    const store = new CredentialStore(path, key);
    await store.load();
    const first = await store.upsert({
      providerId: "codex-a",
      kind: "codex",
      authMethod: "api-key",
      apiKey: "upstream-secret-value",
      config: { models: [{ name: "gpt-5", alias: "gpt-5" }] }
    });
    const second = await store.upsert({
      providerId: "codex-a",
      kind: "codex",
      authMethod: "api-key",
      apiKey: "replacement-secret-value",
      config: { models: [{ name: "gpt-5", alias: "gpt-5" }] }
    });
    expect(second.ref).toBe(first.ref);
    const encoded = await readFile(path, "utf8");
    expect(encoded).not.toContain("upstream-secret-value");
    expect(encoded).not.toContain("replacement-secret-value");
    const backupPath = join(directory, "credentials.v1.backup.enc");
    await copyFile(path, backupPath);
    await rm(path);
    await copyFile(backupPath, path);
    const restored = new CredentialStore(path, key);
    await restored.load();
    expect(restored.get("codex-a")).toMatchObject({ ref: first.ref, apiKey: "replacement-secret-value" });
  });

  test("normalizes only the current Provider prefix from CPA OAuth auth-file models", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    let models = [{ id: "prv_oauth/gpt-5.4" }, { id: "prv_oauth/gpt-5.3-codex" }];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "", path: request.url ?? "", body: text ? JSON.parse(text) : null });
      response.setHeader("content-type", "application/json");
      if (request.url === "/v0/management/auth-files/models?name=oauth-one") response.end(JSON.stringify({ models }));
      else response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server unavailable");
      const cpa = new CpaManagementClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        managementKey: "m".repeat(32),
        inferenceKey: "i".repeat(32)
      });
      const candidate = { id: "oauth-one", name: "oauth-one.json", ref: "ref-oauth-one", provider: "codex", status: "ready", disabled: false, updatedAt: "2026-07-14T00:00:00.000Z" };
      await expect(cpa.bindOAuthCredential("prv_oauth", "codex", candidate)).resolves.toEqual([
        { name: "gpt-5.3-codex", alias: "gpt-5.3-codex" },
        { name: "gpt-5.4", alias: "gpt-5.4" }
      ]);
      expect(requests[0]).toEqual({ method: "PATCH", path: "/v0/management/auth-files/fields", body: { name: "oauth-one", prefix: "prv_oauth" } });
      models = [{ id: "another-provider/gpt-5.4" }];
      await expect(cpa.bindOAuthCredential("prv_oauth", "codex", candidate)).rejects.toThrow("cliproxy_oauth_catalog_prefix_mismatch");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("imports a Vertex service account only through the pinned multipart Management endpoint", async () => {
    const requests: Array<{ method: string; path: string; contentType: string; body: string }> = [];
    let imported = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "", path: request.url ?? "", contentType: String(request.headers["content-type"] ?? ""), body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/v0/management/auth-files") {
        response.end(JSON.stringify({ files: imported ? [{ id: "vertex-project-a.json", name: "vertex-project-a.json", auth_index: "ref-vertex-a", provider: "vertex", status: "ready", disabled: false, updated_at: "2026-08-05T00:00:00.000Z" }] : [] }));
      } else if (request.url === "/v0/management/vertex/import" && request.method === "POST") {
        imported = true;
        response.end(JSON.stringify({ status: "ok", "auth-file": "/private/auth/vertex-project-a.json", project_id: "project-a", email: "secret@example.com", location: "us-central1" }));
      } else if (request.url === "/v0/management/auth-files/fields" && request.method === "PATCH") {
        response.end(JSON.stringify({ status: "ok" }));
      } else if (request.url === "/v0/management/auth-files/models?name=vertex-project-a.json") {
        response.end(JSON.stringify({ models: [{ id: "vertex-a/gemini-2.5-pro" }] }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server unavailable");
      const cpa = new CpaManagementClient({ baseUrl: `http://127.0.0.1:${address.port}`, managementKey: "m".repeat(32), inferenceKey: "i".repeat(32) });
      const secret = "private-key-sentinel";
      const result = await cpa.importVertexCredential("vertex-a", JSON.stringify({ project_id: "project-a", client_email: "secret@example.com", private_key: secret }), "us-central1");
      const upload = requests.find((entry) => entry.path === "/v0/management/vertex/import");
      expect(upload).toMatchObject({ method: "POST" });
      expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(upload?.body).toContain(secret);
      expect(upload?.body).toContain('name="location"');
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("secret@example.com");
      expect(result).toEqual({
        candidate: expect.objectContaining({ name: "vertex-project-a.json", ref: "ref-vertex-a", provider: "vertex" }),
        models: [{ name: "gemini-2.5-pro", alias: "gemini-2.5-pro" }]
      });
      expect(requests.map((entry) => `${entry.method} ${entry.path}`)).toContain("PATCH /v0/management/auth-files/fields");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("stores only the Vertex auth-file reference after credential import", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const storePath = join(directory, "credentials.v1.enc");
    const store = new CredentialStore(storePath, Buffer.alloc(32, 23));
    const importVertexCredential = vi.fn(async () => ({
      candidate: { id: "vertex-project-a.json", name: "vertex-project-a.json", ref: "ref-vertex-a", provider: "vertex", status: "ready", disabled: false, updatedAt: "2026-08-05T00:00:00.000Z" },
      models: [{ name: "gemini-2.5-pro", alias: "gemini-2.5-pro" }]
    }));
    const service = new CliProxyControlService(store, oauthCpa({ importVertexCredential }));
    await service.initialize();
    const secret = "private-key-sentinel";
    const result = await service.importCredential("vertex-a", { serviceAccountJson: JSON.stringify({ project_id: "project-a", private_key: secret }), location: "us-central1" });
    expect(result).toMatchObject({ providerId: "vertex-a", kind: "vertex", authMethod: "credential-import", preview: "Vertex service account", models: ["gemini-2.5-pro"] });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(store.get("vertex-a")).toMatchObject({ ref: "ref-vertex-a", authFileName: "vertex-project-a.json", authMethod: "credential-import" });
    expect(await readFile(storePath, "utf8")).not.toContain(secret);
    await expect(service.importCredential("vertex-a", { serviceAccountJson: "{}", location: "us-central1" })).rejects.toThrow("cliproxy_vertex_credential_conflict");
  });

  test("repairs legacy prefixed OAuth model mappings before startup reconciliation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const path = join(directory, "credentials.v1.enc");
    const key = Buffer.alloc(32, 12);
    const original = new CredentialStore(path, key);
    await original.load();
    await original.upsert({
      ref: "ref-oauth-one",
      providerId: "codex",
      kind: "codex",
      authMethod: "oauth",
      authFileName: "oauth-one.json",
      config: { models: [{ name: "codex/gpt-5.4", alias: "codex/gpt-5.4" }, { name: "codex/gpt-5.3-codex", alias: "codex/gpt-5.3-codex" }] }
    });

    const restored = new CredentialStore(path, key);
    const reconcile = vi.fn(async () => undefined);
    const service = new CliProxyControlService(restored, oauthCpa({ reconcile }));
    await service.initialize();

    const expectedModels = [{ name: "gpt-5.4", alias: "gpt-5.4" }, { name: "gpt-5.3-codex", alias: "gpt-5.3-codex" }];
    expect(restored.get("codex")?.config.models).toEqual(expectedModels);
    expect(reconcile).toHaveBeenCalledWith([expect.objectContaining({ providerId: "codex", authMethod: "oauth", config: { models: expectedModels } })]);
    const reloaded = new CredentialStore(path, key);
    await reloaded.load();
    expect(reloaded.get("codex")?.config.models).toEqual(expectedModels);
  });

  test("rebinds one unambiguous newer active OAuth file after CPA rotates its identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const path = join(directory, "credentials.v1.enc");
    const key = Buffer.alloc(32, 29);
    const original = new CredentialStore(path, key);
    await original.load();
    await original.upsert({
      ref: "ref-old",
      providerId: "codex-a",
      kind: "codex",
      authMethod: "oauth",
      authFileName: "oauth-old.json",
      config: { models: [{ name: "gpt-5.6-luna", alias: "gpt-5.6-luna" }] },
    });
    const candidate = { ...oauthAuthFile("oauth-rotated"), provider: "codex", updatedAt: "2099-01-01T00:00:00.000Z" };
    const bindOAuthCredential = vi.fn(async () => [{ name: "ignored-live-model", alias: "ignored-live-model" }]);
    const reconcile = vi.fn(async () => undefined);
    const restored = new CredentialStore(path, key);
    const service = new CliProxyControlService(restored, oauthCpa({
      listAuthFiles: async () => [candidate],
      bindOAuthCredential,
      reconcile,
    }));

    await service.initialize();

    expect(bindOAuthCredential).toHaveBeenCalledWith("codex-a", "codex", candidate);
    expect(restored.get("codex-a")).toMatchObject({
      ref: candidate.ref,
      authFileName: candidate.name,
      config: { models: [{ name: "gpt-5.6-luna", alias: "gpt-5.6-luna" }] },
    });
    expect(reconcile).toHaveBeenCalledWith([expect.objectContaining({ ref: candidate.ref, authFileName: candidate.name })]);
  });

  test("does not rebind OAuth identity when more than one active rotated file is possible", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const path = join(directory, "credentials.v1.enc");
    const key = Buffer.alloc(32, 30);
    const store = new CredentialStore(path, key);
    await store.load();
    await store.upsert({
      ref: "ref-old",
      providerId: "codex-a",
      kind: "codex",
      authMethod: "oauth",
      authFileName: "oauth-old.json",
      config: { models: [{ name: "gpt-5.6-luna", alias: "gpt-5.6-luna" }] },
    });
    const bindOAuthCredential = vi.fn();
    const candidates = ["oauth-new-a", "oauth-new-b"].map((id) => ({
      ...oauthAuthFile(id),
      provider: "codex",
      updatedAt: "2099-01-01T00:00:00.000Z",
    }));
    const service = new CliProxyControlService(store, oauthCpa({
      listAuthFiles: async () => candidates,
      bindOAuthCredential,
    }));

    await service.initialize();

    expect(bindOAuthCredential).not.toHaveBeenCalled();
    expect(store.get("codex-a")).toMatchObject({ ref: "ref-old", authFileName: "oauth-old.json" });
  });

  test("materializes API keys through the kind-aware CPA endpoint and exposes only a redacted summary", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    let catalogReads = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "", path: request.url ?? "", body: text ? JSON.parse(text) : null });
      response.setHeader("content-type", "application/json");
      if (request.url === "/v0/management/force-model-prefix") response.end(JSON.stringify({ "force-model-prefix": true }));
      else if (request.url === "/v0/management/auth-files") response.end(JSON.stringify({ files: [{ id: "codex-a", auth_index: "auth-codex-a", name: "codex-a.json", prefix: "codex-a", provider: "codex", status: "active", disabled: false, unavailable: false }] }));
      else if (request.url?.startsWith("/v0/management/") && request.method === "GET") {
        const key = request.url.slice("/v0/management/".length);
        response.end(JSON.stringify({ [key]: [] }));
      } else if (request.url === "/v1/models") {
        catalogReads += 1;
        response.end(JSON.stringify({ data: catalogReads < 3 ? [] : [
          { id: "codex-a/gpt-image-1.5" },
          { id: "codex-a/gpt-image-2" }
        ] }));
      }
      else response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server unavailable");
      const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
      directories.push(directory);
      const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 9));
      const cpa = new CpaManagementClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        managementKey: "m".repeat(32),
        inferenceKey: "i".repeat(32),
        readinessProbeTimeoutMs: 100,
        readinessProbeIntervalMs: 1
      });
      const service = new CliProxyControlService(store, cpa);
      await service.initialize();
      const summary = await service.putCredential("codex-a", {
        kind: "codex",
        apiKey: "top-secret-api-key",
        models: [{ name: "gpt-5", alias: "gpt-5" }, { name: "gpt-5-mini-upstream", alias: "gpt-5-mini" }]
      });
      expect(summary).toMatchObject({ providerId: "codex-a", kind: "codex", authMethod: "api-key", status: "ready", models: ["gpt-5", "gpt-5-mini"] });
      expect(JSON.stringify(summary)).not.toContain("top-secret-api-key");
      expect(catalogReads).toBe(3);
      await expect(service.catalog("codex-a")).resolves.toEqual(["gpt-5", "gpt-5-mini"]);
      const codexWrite = requests.findLast((entry) => entry.method === "PUT" && entry.path === "/v0/management/codex-api-key");
      expect(codexWrite?.body).toEqual([{ "api-key": "top-secret-api-key", prefix: "codex-a", models: [{ name: "gpt-5", alias: "gpt-5" }, { name: "gpt-5-mini-upstream", alias: "gpt-5-mini" }] }]);
      expect(requests.filter((entry) => entry.method === "PUT" && entry.path !== "/v0/management/codex-api-key").every((entry) => JSON.stringify(entry.body) === "[]")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("requires exact restored credential readiness while allowing a partial configured catalog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 8));
    await store.load();
    await store.upsert({
      providerId: "codex-a",
      kind: "codex",
      authMethod: "api-key",
      apiKey: "restored-secret-api-key",
      config: {
        models: [
          { name: "gpt-5.4", alias: "gpt-5.4" },
          { name: "gpt-5.3-codex", alias: "gpt-5.3-codex" }
        ]
      }
    });
    const reconcile = vi.fn(async () => undefined);
    const assertCredentialReady = vi.fn(async () => undefined);
    const assertInferenceCatalogReady = vi.fn(async () => undefined);
    const catalog = vi.fn(async () => ["gpt-5.4"]);
    const service = new CliProxyControlService(store, oauthCpa({ reconcile, assertCredentialReady, assertInferenceCatalogReady, catalog }), {
      now: () => Date.parse("2026-07-19T00:01:00.000Z")
    });

    await service.initialize();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(assertInferenceCatalogReady).toHaveBeenCalledTimes(1);
    expect(assertCredentialReady).not.toHaveBeenCalled();
    expect(service.isReady()).toBe(true);
    const observation = await service.reconcileProvider("codex-a");
    expect(observation).toEqual({
      providerId: "codex-a",
      credentialRef: expect.any(String),
      credentialStatus: "ready",
      credentialFailureReason: null,
      credentialErrorCode: null,
      configuredModels: ["gpt-5.4", "gpt-5.3-codex"],
      catalogStatus: "partial",
      catalogPresentModels: ["gpt-5.4"],
      catalogMissingModels: ["gpt-5.3-codex"],
      catalogAttemptedAt: "2026-07-19T00:01:00.000Z",
      catalogCheckedAt: "2026-07-19T00:01:00.000Z",
      lastSuccessfulCatalogCheckedAt: "2026-07-19T00:01:00.000Z",
      catalogErrorCode: null,
      stale: false
    });
    expect(JSON.stringify(observation)).not.toMatch(/preview|restored-secret-api-key/);
    expect(service.isReady()).toBe(true);
  });

  test("reconciles one visible Provider batch with one CPA mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 28));
    await store.load();
    for (const providerId of ["codex-a", "codex-b"]) await store.upsert({
      providerId, kind: "codex", authMethod: "api-key", apiKey: `${providerId}-secret-key`,
      config: { models: [{ name: "gpt-5.4", alias: "gpt-5.4" }] },
    });
    const reconcile = vi.fn(async () => undefined);
    const catalog = vi.fn(async () => ["gpt-5.4"]);
    const service = new CliProxyControlService(store, oauthCpa({ reconcile, catalog }), { now: () => Date.parse("2026-07-19T00:01:00.000Z") });
    await service.initialize();
    reconcile.mockClear();
    await expect(service.reconcileProviders(["codex-a", "codex-b", "codex-missing"])).resolves.toMatchObject([
      { providerId: "codex-a", catalogStatus: "full" },
      { providerId: "codex-b", catalogStatus: "full" },
      { providerId: "codex-missing", credentialStatus: "unready", catalogStatus: "unknown", catalogErrorCode: "cliproxy_provider_credentials_not_found" },
    ]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(service.isReady()).toBe(false);
  });

  test("returns a durable missing-credential observation for single Provider reconciliation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const reconcile = vi.fn(async () => undefined);
    const service = new CliProxyControlService(new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 27)), oauthCpa({ reconcile }), { now: () => Date.parse("2026-07-19T00:01:00.000Z") });
    await service.initialize();
    reconcile.mockClear();

    await expect(service.reconcileProvider("missing-provider")).resolves.toEqual({
      providerId: "missing-provider",
      credentialRef: null,
      credentialStatus: "unready",
      credentialFailureReason: "auth_not_found",
      credentialErrorCode: "cliproxy_provider_credentials_not_found",
      configuredModels: [],
      catalogStatus: "unknown",
      catalogPresentModels: [],
      catalogMissingModels: [],
      catalogAttemptedAt: "2026-07-19T00:01:00.000Z",
      catalogCheckedAt: null,
      lastSuccessfulCatalogCheckedAt: null,
      catalogErrorCode: "cliproxy_provider_credentials_not_found",
      stale: false,
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(service.isReady()).toBe(false);
  });

  test("reports an unknown catalog attempt without reusing the previous model arrays", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 18));
    await store.load();
    await store.upsert({
      providerId: "codex-a",
      kind: "codex",
      authMethod: "api-key",
      apiKey: "stored-secret-api-key",
      config: { models: [{ name: "gpt-5.4", alias: "gpt-5.4" }] }
    });
    let now = Date.parse("2026-07-19T00:01:00.000Z");
    const catalog = vi.fn()
      .mockResolvedValueOnce(["gpt-5.4"])
      .mockRejectedValueOnce(new Error("cliproxy_inference_unavailable"));
    const service = new CliProxyControlService(store, oauthCpa({ catalog }), { now: () => now });

    await service.initialize();
    await expect(service.reconcileProvider("codex-a")).resolves.toMatchObject({
      catalogStatus: "full",
      catalogPresentModels: ["gpt-5.4"],
      catalogCheckedAt: "2026-07-19T00:01:00.000Z"
    });
    now = Date.parse("2026-07-19T00:02:00.000Z");
    await expect(service.reconcileProvider("codex-a")).resolves.toMatchObject({
      catalogStatus: "unknown",
      catalogPresentModels: [],
      catalogMissingModels: [],
      catalogAttemptedAt: "2026-07-19T00:02:00.000Z",
      catalogCheckedAt: null,
      lastSuccessfulCatalogCheckedAt: "2026-07-19T00:01:00.000Z",
      catalogErrorCode: "cliproxy_inference_unavailable",
      stale: true
    });
    expect(service.isReady()).toBe(false);
  });

  test("reduces an unauthorized credential to unready for single and batch reconciliation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 20));
    await store.load();
    await store.upsert({
      ref: "ref-oauth-one",
      providerId: "codex-a",
      kind: "codex",
      authMethod: "oauth",
      authFileName: "oauth-one.json",
      config: { models: [{ name: "gpt-5.4", alias: "gpt-5.4" }] }
    });
    const credentialHealth = vi.fn(async () => ({
      credentialRef: "ref-oauth-one",
      status: "unready" as const,
      failureReason: "auth_unauthorized" as const,
      errorCode: "cliproxy_provider_credentials_unauthorized" as const,
    }));
    const service = new CliProxyControlService(store, oauthCpa({ credentialHealth }));

    await service.initialize();
    expect(service.isReady()).toBe(false);
    await expect(service.reconcileProvider("codex-a")).resolves.toMatchObject({
      providerId: "codex-a", credentialStatus: "unready", credentialFailureReason: "auth_unauthorized",
      catalogStatus: "unknown", catalogErrorCode: "cliproxy_provider_credentials_unauthorized",
    });
    await expect(service.reconcileProviders(["codex-a"])).resolves.toMatchObject([
      { providerId: "codex-a", credentialStatus: "unready", credentialFailureReason: "auth_unauthorized", catalogErrorCode: "cliproxy_provider_credentials_unauthorized" },
    ]);
    expect(service.isReady()).toBe(false);
  });

  test("runs semantic readiness against the exact CPA credential identity and configured model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 21));
    await store.load();
    const credential = await store.upsert({
      ref: "auth-exact-one",
      providerId: "codex-a",
      kind: "codex",
      authMethod: "oauth",
      authFileName: "oauth-one.json",
      config: { models: [{ name: "gpt-5.4-upstream", alias: "gpt-5.4" }] },
    });
    const semanticProbe = vi.fn(async () => ({
      credentialRef: credential.ref,
      model: "gpt-5.4",
      status: "ready" as const,
      semanticStatus: "ready" as const,
      failureReason: null,
      errorCode: null,
    }));
    const service = new CliProxyControlService(store, oauthCpa({ semanticProbe }), {
      cpaInstanceId: "cpa_llm_sg",
      now: () => Date.parse("2026-08-31T00:00:00.000Z"),
    });

    await expect(service.semanticReadiness()).resolves.toEqual({
      schema: "friday-relay.cpa-credential-semantic-readiness.v1",
      cpaInstanceId: "cpa_llm_sg",
      status: "ready",
      probes: [{
        providerId: "codex-a",
        model: "gpt-5.4",
        status: "ready",
        failureReason: null,
        errorCode: null,
        probedAt: "2026-08-31T00:00:00.000Z",
      }],
    });
    expect(semanticProbe).toHaveBeenCalledWith(expect.objectContaining({ ref: "auth-exact-one", providerId: "codex-a" }), "gpt-5.4");
    expect(JSON.stringify(await service.semanticReadiness())).not.toContain("auth-exact-one");
  });

  test("fails semantic readiness when no credential target can be probed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 22));
    await store.load();
    const service = new CliProxyControlService(store, oauthCpa());

    await expect(service.semanticReadiness()).rejects.toThrow("cliproxy_credential_probe_target_missing");
  });

  test("returns only the Provider binding model allowlist from the prefixed CPA catalog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 6));
    await store.load();
    await store.upsert({
      providerId: "codex-a",
      kind: "codex",
      authMethod: "api-key",
      apiKey: "stored-secret-api-key",
      config: {
        models: [
          { name: "gpt-5.4", alias: "gpt-5.4" },
          { name: "gpt-5.3-codex", alias: "gpt-5.3-codex" }
        ]
      }
    });
    const catalog = vi.fn(async () => ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"]);
    const service = new CliProxyControlService(store, oauthCpa({ catalog }));
    await service.initialize();

    await expect(service.catalog("codex-a")).resolves.toEqual(["gpt-5.4", "gpt-5.3-codex"]);
    expect(catalog).toHaveBeenCalledWith("codex-a");
  });

  test("accepts 304 Provider mappings and rejects more than 8192", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 5));
    await store.load();
    const models = Array.from({ length: 304 }, (_, index) => ({ name: `upstream-${index}`, alias: `model-${index}` }));
    const service = new CliProxyControlService(store, oauthCpa());

    await expect(service.putCredential("large-catalog", {
      kind: "codex",
      apiKey: "stored-secret-api-key",
      models
    })).resolves.toMatchObject({ models: models.map((model) => model.alias) });
    expect(store.get("large-catalog")?.config.models).toHaveLength(304);
    await expect(service.putCredential("too-large-catalog", {
      kind: "codex",
      apiKey: "stored-secret-api-key",
      models: Array.from({ length: 8193 }, (_, index) => ({ name: `upstream-${index}`, alias: `model-${index}` }))
    })).rejects.toThrow("cliproxy_models_invalid");
  });

  test("uses the pinned CPA endpoint and payload allowlist for every API-key kind", async () => {
    const paths = {
      codex: "codex-api-key",
      gemini: "gemini-api-key",
      claude: "claude-api-key",
      "openai-compatible": "openai-compatibility",
      vertex: "vertex-api-key"
    } as const;
    const collections = new Map<string, Array<Record<string, unknown>>>(Object.values(paths).map((path) => [path, []]));
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      if (request.url === "/v0/management/force-model-prefix") return response.end(JSON.stringify({ "force-model-prefix": true }));
      if (request.url === "/v0/management/auth-files" && request.method === "GET") {
        const files = [...collections.entries()].flatMap(([path, entries]) => entries.map((entry) => ({
          id: String(entry.prefix ?? entry.name ?? ""), auth_index: `auth-${String(entry.prefix ?? entry.name ?? "")}`,
          name: `${String(entry.prefix ?? entry.name ?? "")}.json`, prefix: String(entry.prefix ?? entry.name ?? ""),
          provider: path, status: "active", disabled: false, unavailable: false,
        })));
        return response.end(JSON.stringify({ files }));
      }
      if (request.url?.startsWith("/v0/management/")) {
        const path = request.url.slice("/v0/management/".length);
        if (request.method === "GET") return response.end(JSON.stringify({ [path]: collections.get(path) ?? [] }));
        if (request.method === "PUT") collections.set(path, JSON.parse(text) as Array<Record<string, unknown>>);
        return response.end(JSON.stringify({ status: "ok" }));
      }
      if (request.url === "/v1/models") {
        const data = [...collections.values()].flatMap((entries) => entries.flatMap((entry) => {
          const prefix = String(entry.prefix ?? entry.name ?? "");
          const models = Array.isArray(entry.models) ? entry.models as Array<Record<string, unknown>> : [];
          return models.map((model) => ({ id: `${prefix}/${String(model.alias ?? "")}` }));
        }));
        return response.end(JSON.stringify({ data }));
      }
      response.statusCode = 404;
      return response.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server unavailable");
      const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
      directories.push(directory);
      const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 10));
      const service = new CliProxyControlService(store, new CpaManagementClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        managementKey: "m".repeat(32), inferenceKey: "i".repeat(32),
        readinessProbeTimeoutMs: 100, readinessProbeIntervalMs: 1
      }));
      await service.initialize();
      for (const [kind, path] of Object.entries(paths)) {
        const providerId = `${kind.replace(/[^a-z]/g, "-")}-a`;
        const apiKey = `${kind}-secret-api-key`;
        const baseUrl = kind === "openai-compatible" ? "https://1.1.1.1/v1" : undefined;
        await service.putCredential(providerId, {
          kind, apiKey, ...(baseUrl ? { baseUrl } : {}), models: [{ name: `${kind}-model`, alias: `${kind}-model` }]
        });
        const entry = collections.get(path)?.find((item) => item.prefix === providerId);
        expect(entry && Object.keys(entry).sort()).toEqual(kind === "openai-compatible"
          ? ["api-key-entries", "base-url", "disabled", "models", "name", "prefix"]
          : ["api-key", "models", "prefix"]);
        expect(JSON.stringify(entry)).toContain(apiKey);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("unloads the old prefixed client before activating a replacement API key", async () => {
    const codexWrites: unknown[] = [];
    let configured: Array<Record<string, unknown>> = [];
    let active: Array<Record<string, unknown>> = [];
    let unloadReadsRemaining = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) as unknown : undefined;
      response.setHeader("content-type", "application/json");
      if (request.url === "/v0/management/force-model-prefix") {
        response.end(JSON.stringify({ "force-model-prefix": true }));
        return;
      }
      if (request.url === "/v0/management/codex-api-key" && request.method === "GET") {
        response.end(JSON.stringify({ "codex-api-key": configured }));
        return;
      }
      if (request.url === "/v0/management/codex-api-key" && request.method === "PUT") {
        configured = body as Array<Record<string, unknown>>;
        codexWrites.push(body);
        if (configured.length === 0 && active.length > 0) unloadReadsRemaining = 1;
        else if (active.length === 0) active = configured;
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/v0/management/auth-files" && request.method === "GET") {
        response.end(JSON.stringify({ files: active.map((entry) => ({
          id: String(entry.prefix ?? ""), auth_index: `auth-${String(entry.prefix ?? "")}`, name: `${String(entry.prefix ?? "")}.json`,
          prefix: String(entry.prefix ?? ""), provider: "codex", status: "active", disabled: false, unavailable: false,
        })) }));
        return;
      }
      if (request.url?.startsWith("/v0/management/") && request.method === "GET") {
        const key = request.url.slice("/v0/management/".length);
        response.end(JSON.stringify({ [key]: [] }));
        return;
      }
      if (request.url?.startsWith("/v0/management/") && request.method === "PUT") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/v1/models") {
        if (unloadReadsRemaining > 0) unloadReadsRemaining -= 1;
        else active = configured;
        response.end(JSON.stringify({
          data: active.length > 0 ? [{ id: "codex-a/gpt-5" }] : []
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server unavailable");
      const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
      directories.push(directory);
      const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 11));
      const cpa = new CpaManagementClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        managementKey: "m".repeat(32),
        inferenceKey: "i".repeat(32),
        readinessProbeTimeoutMs: 100,
        readinessProbeIntervalMs: 1
      });
      const service = new CliProxyControlService(store, cpa);
      await service.initialize();
      await service.putCredential("codex-a", {
        kind: "codex",
        apiKey: "first-secret-api-key",
        models: [{ name: "gpt-5", alias: "gpt-5" }]
      });
      await service.putCredential("codex-a", {
        kind: "codex",
        apiKey: "replacement-api-key",
        models: [{ name: "gpt-5", alias: "gpt-5" }]
      });

      expect(codexWrites.slice(-2)).toEqual([
        [],
        [{ "api-key": "replacement-api-key", prefix: "codex-a", models: [{ name: "gpt-5", alias: "gpt-5" }] }]
      ]);
      expect(store.get("codex-a")?.apiKey).toBe("replacement-api-key");
      await expect(service.deleteCredential("codex-a")).resolves.toBe(true);
      expect(codexWrites.at(-1)).toEqual([]);
      expect(store.get("codex-a")).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("binds OAuth sessions to actor/provider/state, sanitizes callbacks, and consumes them once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 13));
    await store.load();
    const postOAuthCallback = vi.fn(async () => undefined);
    const cpa = oauthCpa({ postOAuthCallback });
    const service = new CliProxyControlService(store, cpa);

    const started = await service.startOAuth("claude-a", { actorId: "admin-a", kind: "claude" });
    await expect(service.submitOAuthCallback("claude-a", {
      actorId: "admin-a",
      sessionId: started.sessionId,
      callbackUrl: "http://localhost/callback?provider=claude&state=wrong&code=private-code"
    })).rejects.toThrow("cliproxy_oauth_state_mismatch");
    await expect(service.submitOAuthCallback("claude-a", {
      actorId: "admin-a",
      sessionId: started.sessionId,
      callbackUrl: "http://localhost/callback?provider=claude&state=cpa-state&code=private-code"
    })).resolves.toEqual({ status: "accepted" });
    expect(postOAuthCallback).toHaveBeenCalledWith({
      kind: "claude",
      state: "cpa-state",
      callbackUrl: "http://localhost/callback?provider=claude&state=cpa-state&code=private-code"
    });
    await expect(service.submitOAuthCallback("claude-a", {
      actorId: "admin-a",
      sessionId: started.sessionId,
      callbackUrl: "http://localhost/callback?provider=claude&state=cpa-state&code=private-code"
    })).rejects.toThrow("cliproxy_oauth_session_consumed");

    const result = await service.oauthStatus("claude-a", started.sessionId, "admin-a");
    expect(result).toMatchObject({ status: "ready", credential: { providerId: "claude-a", kind: "claude", authMethod: "oauth", models: ["claude-sonnet-4"] } });
    expect(JSON.stringify(result)).not.toContain("private-code");
    await expect(service.oauthStatus("claude-a", started.sessionId, "another-admin")).rejects.toThrow("cliproxy_oauth_session_not_found");
  });

  test("drops additional callback fields and rejects mismatched OAuth providers without forwarding them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 15));
    await store.load();
    const postOAuthCallback = vi.fn(async () => undefined);
    const service = new CliProxyControlService(store, oauthCpa({ postOAuthCallback }));
    const started = await service.startOAuth("codex-a", { actorId: "admin-a", kind: "codex" });
    const mismatched = await service.startOAuth("claude-a", { actorId: "admin-a", kind: "claude" });

    await expect(service.submitOAuthCallback("claude-a", {
      actorId: "admin-a", sessionId: mismatched.sessionId,
      callbackUrl: "http://localhost/callback?provider=gemini&state=cpa-state&code=code"
    })).rejects.toThrow("cliproxy_oauth_provider_mismatch");
    expect(postOAuthCallback).not.toHaveBeenCalled();

    await expect(service.submitOAuthCallback("codex-a", {
      actorId: "admin-a", sessionId: started.sessionId,
      callbackUrl: "http://localhost:1455/auth/callback?code=private-code&scope=openid+profile+email+offline_access&state=cpa-state"
    })).resolves.toEqual({ status: "accepted" });
    expect(postOAuthCallback).toHaveBeenCalledWith({
      kind: "codex",
      state: "cpa-state",
      callbackUrl: "http://localhost:1455/auth/callback?state=cpa-state&code=private-code"
    });
  });

  test("serializes OAuth for one Provider, permits different Providers, and releases expired sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 17));
    await store.load();
    let now = Date.parse("2026-07-14T00:00:00.000Z");
    const gates = new Map<string, () => void>();
    const startOAuth = vi.fn((kind: string) => new Promise<{ authorizationUrl: string; state: string; before: [] }>((resolve) => {
      gates.set(kind, () => resolve({ authorizationUrl: `https://auth.example/${kind}`, state: `${kind}-state`, before: [] }));
    }));
    const service = new CliProxyControlService(store, oauthCpa({ startOAuth }), { oauthSessionTtlMs: 60_000, now: () => now });

    const first = service.startOAuth("claude-a", { actorId: "admin-a", kind: "claude" });
    const duplicate = service.startOAuth("claude-a", { actorId: "admin-a", kind: "claude" });
    await expect(service.startOAuth("gemini-a", { actorId: "admin-a", kind: "gemini" }))
      .rejects.toMatchObject({ code: "cliproxy_auth_method_unsupported" });
    const parallel = service.startOAuth("xai-a", { actorId: "admin-a", kind: "xai" });
    await vi.waitFor(() => expect(startOAuth).toHaveBeenCalledTimes(2));
    gates.get("claude")?.();
    gates.get("xai")?.();
    await expect(first).resolves.toMatchObject({ authorizationUrl: "https://auth.example/claude" });
    await expect(parallel).resolves.toMatchObject({ authorizationUrl: "https://auth.example/xai" });
    await expect(duplicate).rejects.toThrow("cliproxy_oauth_in_progress");

    now += 60_001;
    const replacement = service.startOAuth("claude-a", { actorId: "admin-a", kind: "claude" });
    await vi.waitFor(() => expect(startOAuth).toHaveBeenCalledTimes(3));
    gates.get("claude")?.();
    await expect(replacement).resolves.toBeDefined();
  });

  test("fails closed when OAuth credential discovery is ambiguous and makes the terminal error stable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cliproxy-control-"));
    directories.push(directory);
    const store = new CredentialStore(join(directory, "credentials.v1.enc"), Buffer.alloc(32, 19));
    await store.load();
    const service = new CliProxyControlService(store, oauthCpa({
      listAuthFiles: async () => [oauthAuthFile("one"), oauthAuthFile("two")]
    }));
    const started = await service.startOAuth("claude-a", { actorId: "admin-a", kind: "claude" });
    await expect(service.oauthStatus("claude-a", started.sessionId, "admin-a")).rejects.toThrow("cliproxy_oauth_credential_ambiguous");
    await expect(service.oauthStatus("claude-a", started.sessionId, "admin-a")).rejects.toThrow("cliproxy_oauth_credential_ambiguous");
  });
});

function oauthAuthFile(id = "oauth-one") {
  return { id, name: `${id}.json`, ref: `ref-${id}`, prefix: "", provider: "anthropic", status: "active", disabled: false, unavailable: false, failureReason: null, updatedAt: "2026-07-14T00:00:00.000Z" };
}

function oauthCpa(overrides: Record<string, unknown> = {}) {
  return {
    reconcile: async () => undefined,
    assertCredentialReady: async () => undefined,
    credentialHealth: async (credential: { ref: string }) => ({ credentialRef: credential.ref, status: "ready" as const, failureReason: null, errorCode: null }),
    semanticProbe: async (credential: { ref: string }, model: string) => ({ credentialRef: credential.ref, model, status: "ready" as const, semanticStatus: "ready" as const, failureReason: null, errorCode: null }),
    assertOAuthCredentialIdentity: async () => undefined,
    assertInferenceCatalogReady: async () => undefined,
    deleteOAuthCredential: async () => undefined,
    catalog: async () => ["claude-sonnet-4"],
    startOAuth: async () => ({ authorizationUrl: "https://auth.example/start", state: "cpa-state", before: [] }),
    postOAuthCallback: async () => undefined,
    oauthStatus: async () => "ok" as const,
    listAuthFiles: async () => [oauthAuthFile()],
    bindOAuthCredential: async () => [{ name: "claude-sonnet-4", alias: "claude-sonnet-4" }],
    importVertexCredential: async () => ({ candidate: { id: "vertex-one", name: "vertex-one.json", ref: "ref-vertex-one", prefix: "", provider: "vertex", status: "active", disabled: false, unavailable: false, failureReason: null, updatedAt: "2026-08-05T00:00:00.000Z" }, models: [{ name: "gemini-2.5-pro", alias: "gemini-2.5-pro" }] }),
    runtimeIdentity: () => ({ version: "v7.2.145", commit: "d9cea89", buildDate: "2026-08-28T09:30:55.000Z", evidenceContract: "cpa-basic@1", adaptation: "friday-evidence-v1" }),
    ...overrides
  } as ConstructorParameters<typeof CliProxyControlService>[1];
}
