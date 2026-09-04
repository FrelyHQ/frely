import { describe, expect, test } from "vitest";
import { testConfig } from "@frely/testkit";
import { parseConfig } from "./index.js";

describe("OIDC configuration", () => {
  test("keeps OIDC disabled when the optional block is absent", () => {
    expect(parseConfig(testConfig()).oidc).toBeUndefined();
  });

  test("rejects the retired production OIDC profile", () => {
    const config = testConfig({
      app: { name: "Frely", environment: "production", publicBaseUrl: "https://relay.example.test", reservedHostnames: [] },
      oidc: {
        enabled: true,
        issuer: "https://relay.example.test",
        clients: [{
          clientId: "llm-web",
          displayName: "Friday LLM",
          clientSecretFile: "./secrets/oidc-client",
          redirectUris: ["https://llm.example.test/callback"]
        }],
        interactionSecretFile: "./secrets/oidc-interaction",
        codeTtlSeconds: 60,
        accessTokenTtlSeconds: 300,
        idTokenTtlSeconds: 300,
        activeSigningKeyId: "active",
        canonicalClientIpHeader: "x-real-ip",
        signingKeys: [
          { kid: "active", privateKeyFile: "./secrets/oidc-active.pem" },
          { kid: "previous", publicKeyFile: "./secrets/oidc-previous.pem" }
        ]
      }
    });

    expect(() => parseConfig(config)).toThrow(/OIDC authentication is retired/u);
  });

  test("rejects the retired OIDC compatibility alias", () => {
    const base = testConfig({
      app: { name: "Frely", environment: "production", publicBaseUrl: "https://relay.example.test", reservedHostnames: [] },
      security: { abuseRateLimit: { canonicalClientIpHeader: "cf-connecting-ip" } }
    });
    const config = {
      ...base,
      oidc: {
        enabled: true,
        issuer: "https://relay.example.test",
        clients: [{
          clientId: "llm-web",
          displayName: "Friday LLM",
          clientSecretFile: "./secrets/oidc-client",
          redirectUris: ["https://llm.example.test/callback"]
        }],
        interactionSecretFile: "./secrets/oidc-interaction",
        codeTtlSeconds: 60,
        accessTokenTtlSeconds: 300,
        idTokenTtlSeconds: 300,
        activeSigningKeyId: "active",
        signingKeys: [{ kid: "active", privateKeyFile: "./secrets/oidc-active.pem" }]
      }
    };

    expect(() => parseConfig(config)).toThrow(/OIDC authentication is retired/u);
  });

  test("rejects insecure production origins, redirect mismatch shapes, unbounded TTLs, and missing active private keys", () => {
    const base = testConfig({
      app: { name: "Frely", environment: "production", publicBaseUrl: "https://relay.example.test", reservedHostnames: [] }
    });
    const enabled = {
      enabled: true as const,
      issuer: "https://relay.example.test",
      clients: [{
        clientId: "llm-web",
        displayName: "Friday LLM",
        clientSecretFile: "./client-secret",
        redirectUris: ["https://llm.example.test/callback"]
      }],
      interactionSecretFile: "./interaction-secret",
      codeTtlSeconds: 60,
      accessTokenTtlSeconds: 300,
      idTokenTtlSeconds: 300,
      activeSigningKeyId: "active",
      canonicalClientIpHeader: "x-real-ip" as const,
      signingKeys: [{ kid: "active", privateKeyFile: "./active.pem" }]
    };

    expect(() => parseConfig({ ...base, oidc: { ...enabled, canonicalClientIpHeader: undefined } })).toThrow();
    expect(() => parseConfig({ ...base, oidc: { ...enabled, issuer: "http://relay.example.test" } })).toThrow();
    expect(() => parseConfig({
      ...base,
      oidc: { ...enabled, clients: [{ ...enabled.clients[0]!, redirectUris: ["https://llm.example.test/callback#fragment"] }] }
    })).toThrow();
    expect(() => parseConfig({ ...base, oidc: { ...enabled, accessTokenTtlSeconds: 3600 } })).toThrow();
    expect(() => parseConfig({ ...base, oidc: { ...enabled, codeTtlSeconds: 1 } })).toThrow();
    expect(() => parseConfig({
      ...base,
      oidc: { ...enabled, interactionSecretFile: enabled.clients[0]!.clientSecretFile }
    })).toThrow();
    expect(() => parseConfig({
      ...base,
      oidc: { ...enabled, signingKeys: [{ kid: "active", publicKeyFile: "./active.pub.pem" }] }
    })).toThrow();
  });

  test("rejects OIDC even for test-only profiles", () => {
    const config = testConfig({
      app: { name: "Frely", environment: "test", publicBaseUrl: "http://127.0.0.1:43001", reservedHostnames: [] },
      oidc: {
        enabled: true,
        issuer: "http://127.0.0.1:43001",
        clients: [{
          clientId: "llm-web",
          displayName: "Friday LLM",
          clientSecretFile: "./client-secret",
          redirectUris: ["http://127.0.0.1:44001/callback"]
        }],
        interactionSecretFile: "./interaction-secret",
        codeTtlSeconds: 1,
        accessTokenTtlSeconds: 2,
        idTokenTtlSeconds: 2,
        activeSigningKeyId: "active",
        canonicalClientIpHeader: "x-real-ip",
        signingKeys: [{ kid: "active", privateKeyFile: "./active.pem" }]
      }
    });

    expect(() => parseConfig(config)).toThrow(/OIDC authentication is retired/u);
  });
});
