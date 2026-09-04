import { describe, expect, test } from "vitest";
import { testConfig } from "@frely/testkit";
import { parseConfig } from "./index.js";

describe("User Passkey configuration", () => {
  test("is disabled by default", () => {
    const config = testConfig();
    const { passkey: _passkey, ...auth } = config.auth;
    expect(parseConfig({ ...config, auth }).auth.passkey).toEqual({ enabled: false });
  });

  test("rejects the superseded Admin-owned Passkey configuration key", () => {
    const config = testConfig();
    expect(() => parseConfig({
      ...config,
      admin: { ...config.admin, passkey: { enabled: true } }
    })).toThrow();
  });

  test("rejects explicit shared and isolated RP profiles because Passkey is retired", () => {
    const shared = productionConfig({
      web: { origin: "https://relay.example.com", rpId: "example.com" },
      admin: { origin: "https://owner.example.com", rpId: "example.com" }
    });
    expect(() => parseConfig(shared)).toThrow(/Passkey authentication is retired/u);

    const isolated = productionConfig({
      web: { origin: "https://relay.example.com", rpId: "relay.example.com" },
      admin: { origin: "https://owner.example.com", rpId: "owner.example.com" }
    });
    expect(() => parseConfig(isolated)).toThrow(/Passkey authentication is retired/u);
  });

  test("rejects Web-only and local Passkey profiles", () => {
    const webOnly = productionConfig({ web: { origin: "https://relay.example.com", rpId: "relay.example.com" } });
    expect(() => parseConfig(webOnly)).toThrow(/Passkey authentication is retired/u);

    const local = testConfig({
      auth: {
        ...testConfig().auth,
        passkey: {
          enabled: true,
          surfaces: {
            web: { origin: "http://localhost:43001", rpId: "localhost" },
            admin: { origin: "http://localhost:43002", rpId: "localhost" }
          }
        }
      }
    });
    expect(() => parseConfig(local)).toThrow(/Passkey authentication is retired/u);
  });

  test("rejects noncanonical, mismatched, insecure, and public/private suffix profiles", () => {
    const base = productionConfig({ web: { origin: "https://relay.example.com", rpId: "relay.example.com" } });
    for (const web of [
      { origin: "https://relay.example.com/", rpId: "relay.example.com" },
      { origin: "https://relay.example.com/path", rpId: "relay.example.com" },
      { origin: "https://relay.example.com", rpId: "other.example.com" },
      { origin: "https://relay.example.com", rpId: "EXAMPLE.com" },
      { origin: "https://relay.example.com", rpId: "com" },
      { origin: "https://relay.example.co.uk", rpId: "co.uk" },
      { origin: "https://relay.github.io", rpId: "github.io" },
      { origin: "http://localhost:43001", rpId: "localhost" }
    ]) {
      expect(() => parseConfig(withSurfaces(base, { web }))).toThrow();
    }
    expect(() => parseConfig({ ...base, auth: { ...base.auth, cookieSecure: false } })).toThrow();
  });

  test("requires Web canonical origin and a distinct reserved production Admin origin", () => {
    const base = productionConfig({
      web: { origin: "https://relay.example.com", rpId: "example.com" },
      admin: { origin: "https://owner.example.com", rpId: "example.com" }
    });
    expect(() => parseConfig({ ...base, app: { ...base.app, publicBaseUrl: "https://other.example.com" } })).toThrow();
    expect(() => parseConfig({ ...base, app: { ...base.app, reservedHostnames: [] } })).toThrow();
    expect(() => parseConfig(withSurfaces(base, {
      web: { origin: "https://relay.example.com", rpId: "example.com" },
      admin: { origin: "https://relay.example.com", rpId: "example.com" }
    }))).toThrow();
  });

  test("rejects IP localhost aliases even outside production", () => {
    const local = testConfig();
    for (const web of [
      { origin: "http://127.0.0.1:43001", rpId: "127.0.0.1" },
      { origin: "http://0.0.0.0:43001", rpId: "0.0.0.0" }
    ]) {
      expect(() => parseConfig({
        ...local,
        auth: { ...local.auth, passkey: { enabled: true, surfaces: { web } } }
      })).toThrow();
    }
  });
});

function productionConfig(surfaces: {
  web: { origin: string; rpId: string };
  admin?: { origin: string; rpId: string };
}) {
  const base = testConfig();
  return testConfig({
    app: {
      name: "Frely",
      environment: "production",
      publicBaseUrl: "https://relay.example.com",
      reservedHostnames: ["owner.example.com"]
    },
    auth: {
      ...base.auth,
      cookieSecure: true,
      passkey: { enabled: true, surfaces }
    }
  });
}

function withSurfaces<T extends ReturnType<typeof productionConfig>>(
  config: T,
  surfaces: Extract<T["auth"]["passkey"], { enabled: true }>["surfaces"]
): T {
  return { ...config, auth: { ...config.auth, passkey: { enabled: true, surfaces } } };
}
