import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProviderAdapterRequest } from "@frely/provider-runtime/adapter";
import { DefaultProviderAdapter, loadCpaConnectionRegistry } from "../packages/providers/src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("server-only CPA connection registry", () => {
  test("loads origins and separate secret files without accepting secret bodies", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-relay-cpa-registry-"));
    roots.push(root);
    const inference = join(root, "inference.key");
    const control = join(root, "control.key");
    writeFileSync(inference, "inference-secret-012345678901234567890123");
    writeFileSync(control, "control-secret-012345678901234567890123");
    chmodSync(inference, 0o600);
    chmodSync(control, 0o600);
    const registryPath = join(root, "registry.json");
    writeFileSync(registryPath, JSON.stringify({
      schemaVersion: 1,
      instances: {
        cpa_default: {
          inferenceOrigin: "http://cli-proxy-api:8317",
          controlOrigin: "http://cliproxy-control:8319",
          inferenceKeyFile: inference,
          controlKeyFile: control,
        },
        cpa_server_b: {
          inferenceOrigin: "https://cpa-b.example.ts.net",
          controlOrigin: "https://cpa-b-control.example.ts.net",
          inferenceKeyFile: inference,
          controlKeyFile: control,
        },
      },
    }));

    const registry = loadCpaConnectionRegistry({ NODE_ENV: "test", FRIDAY_RELAY_CPA_CONNECTION_REGISTRY_FILE: registryPath });
    expect(registry?.instances.cpa_server_b).toMatchObject({ inferenceOrigin: "https://cpa-b.example.ts.net" });
    expect(JSON.stringify(registry)).not.toContain("inference-secret");
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry?.instances.cpa_server_b)).toBe(true);
  });

  test("requires HTTPS for remote production CPA origins", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-relay-cpa-registry-"));
    roots.push(root);
    const key = join(root, "key");
    writeFileSync(key, "secret-012345678901234567890123456789");
    chmodSync(key, 0o600);
    const registryPath = join(root, "registry.json");
    writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, instances: {
      cpa_default: { inferenceOrigin: "http://cli-proxy-api:8317", controlOrigin: "http://cliproxy-control:8319", inferenceKeyFile: key, controlKeyFile: key },
      cpa_remote: { inferenceOrigin: "http://10.0.0.5:8317", controlOrigin: "https://cpa-remote-control.example", inferenceKeyFile: key, controlKeyFile: key },
    } }));
    expect(() => loadCpaConnectionRegistry({ NODE_ENV: "production", FRIDAY_RELAY_CPA_CONNECTION_REGISTRY_FILE: registryPath })).toThrow("Remote CPA connection origin must use HTTPS");
  });

  test("routes inference through the Provider-selected CPA without allowing request overrides", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-relay-cpa-registry-"));
    roots.push(root);
    const keyA = join(root, "a.key");
    const keyB = join(root, "b.key");
    writeFileSync(keyA, "inference-a-012345678901234567890123");
    writeFileSync(keyB, "inference-b-012345678901234567890123");
    chmodSync(keyA, 0o600);
    chmodSync(keyB, 0o600);
    const registryPath = join(root, "registry.json");
    writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, instances: {
      cpa_default: { inferenceOrigin: "http://cpa-default.test:8317", controlOrigin: "http://cpa-default-control.test:8319", inferenceKeyFile: keyA, controlKeyFile: keyA },
      cpa_server_b: { inferenceOrigin: "https://cpa-b.test", controlOrigin: "https://cpa-b-control.test", inferenceKeyFile: keyB, controlKeyFile: keyB },
    } }));
    const registry = loadCpaConnectionRegistry({ NODE_ENV: "test", FRIDAY_RELAY_CPA_CONNECTION_REGISTRY_FILE: registryPath });
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ id: "response", model: "prv_affinity/gpt-5", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    });
    const adapter = new DefaultProviderAdapter({
      cpaConnectionRegistry: registry,
      cliProxyClientOptions: { fetch: fetchMock as typeof fetch },
    });
    await adapter.invoke(request("cpa_default"));
    await adapter.invoke(request("cpa_server_b"));

    expect(requests.map((item) => item.url)).toEqual([
      "http://cpa-default.test:8317/v1/responses",
      "https://cpa-b.test/v1/responses",
    ]);
    expect(requests.map((item) => item.authorization)).toEqual([
      "Bearer inference-a-012345678901234567890123",
      "Bearer inference-b-012345678901234567890123",
    ]);
  });
});

function request(cpaInstanceId: string): ProviderAdapterRequest {
  return {
    kind: "responses",
    provider: {
      id: "prv_affinity",
      cpaInstanceId,
      bindingRevision: 1,
      authMethod: "oauth",
      credentialOwnership: "cpa-managed",
      credentialRefCount: 1,
    },
    sourceFormat: "openai-responses",
    tarModel: "gpt-5",
    stream: false,
    options: { input: [{ role: "user", content: "test" }] },
    metadata: { requestId: `req_${cpaInstanceId}`, providerAttemptId: `provider_attempt_${cpaInstanceId}`, teamId: null, userId: "usr_1", apiKeyId: "key_1" },
  };
}
