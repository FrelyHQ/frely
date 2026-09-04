import { describe, expect, test } from "vitest";
import {
  assertSafeProviderConfigInput,
  sanitizeProviderConfigJson,
} from "./provider-credentials.js";

const sensitiveKeys = [
  "clientSecret",
  "secret",
  "privateKey",
  "accessToken",
  "authorization",
  "passwordHash",
  "AWS_SECRET_ACCESS_KEY",
  "codeVerifier",
  "oauth_code",
  "oauth_state",
  "clientAssertion",
  "code",
  "state",
  "privateKeyPem",
  "private_key_file",
  "apiKeyValue",
  "api-key-file",
  "accessTokenValue",
  "accessTokenKey",
  "refresh_token_file",
  "signingKey",
  "keyPassphrase",
  "serviceAccountJson",
  "serviceAccount",
  "client_email",
  "clientEmail",
  "authFile",
  "authFileName",
  "authFilePath",
  "auth_file_path",
  "auth-path",
  "serviceAccountFile",
  "serviceAccountPath",
  "service_account_file_path",
];

const serviceAccountDocument = {
  type: "service_account",
  project_id: "must-not-cross-server-fn",
  private_key_id: "private-key-id",
  private_key: "private-key",
  client_email: "service-account@example.test",
  token_uri: "https://oauth2.example.test/token",
};

describe("Provider config safety", () => {
  test.each(sensitiveKeys)("rejects nested sensitive key %s", (key) => {
    expect(() => assertSafeProviderConfigInput({ nested: [{ [key]: "do-not-expose" }] }))
      .toThrowError("Provider credentials are not allowed in provider config");
  });

  test("recursively redacts legacy sensitive fields from public config", () => {
    const raw = JSON.stringify({
      apiFormat: "openai",
      maxTokens: 128,
      nested: Object.fromEntries(sensitiveKeys.map((key) => [key, "do-not-expose"])),
    });

    const sanitized = sanitizeProviderConfigJson(raw, "api-key:");

    expect(JSON.parse(sanitized)).toEqual({ apiFormat: "openai", maxTokens: 128, nested: {} });
    expect(sanitized).not.toContain("do-not-expose");
  });

  test("keeps non-credential file and path settings", () => {
    const config = {
      catalogFilePath: "/public/catalog.json",
      publicCertificatePath: "/public/ca.pem",
    };

    expect(assertSafeProviderConfigInput(config)).toEqual(config);
    expect(JSON.parse(sanitizeProviderConfigJson(JSON.stringify(config), "api-key:"))).toEqual(config);
  });

  test("rejects and removes complete legacy service-account documents", () => {
    expect(() => assertSafeProviderConfigInput(serviceAccountDocument))
      .toThrowError("Provider credentials are not allowed in provider config");

    const sanitized = sanitizeProviderConfigJson(JSON.stringify(serviceAccountDocument), "identity:");
    expect(JSON.parse(sanitized)).toEqual({});
    expect(sanitized).not.toMatch(/project_id|private_key|client_email|token_uri/u);
  });

  test("replaces an encrypted credential with its public summary", () => {
    const sanitized = sanitizeProviderConfigJson(JSON.stringify({
      apiFormat: "openai",
      credential: {
        preview: "sk-...safe",
        encryptedValue: {
          v: 1,
          alg: "aes-256-gcm",
          iv: "private-iv",
          ciphertext: "private-ciphertext",
          tag: "private-tag",
        },
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
    }), "api-key:");

    expect(JSON.parse(sanitized)).toEqual({
      apiFormat: "openai",
      credential: {
        type: "api-key",
        preview: "sk-...safe",
        updatedAt: "2026-08-31T00:00:00.000Z",
        status: "configured",
      },
    });
    expect(sanitized).not.toMatch(/encryptedValue|private-ciphertext/u);
  });
});
