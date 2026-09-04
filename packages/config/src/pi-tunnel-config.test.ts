import { describe, expect, test } from "vitest";
import { parseConfig } from "./index.js";

function baseConfig(environment: "development" | "production" = "development") {
  return {
    app: { name: "Frely", environment, publicBaseUrl: environment === "production" ? "https://relay.example.test" : "http://localhost:43001", reservedHostnames: [] },
    database: { backend: "postgres" },
    archive: {
      directory: "./archives",
      ...(environment === "production" ? { coldDirectory: "/tmp/cold" } : {}),
      ...(environment === "development" ? { history: { enabled: false, autoPurge: false } } : {})
    },
    requestCapture: { hotDays: 90, archive: { enabled: false, autoPurge: false }, download: {} },
    security: { abuseRateLimit: {} },
    auth: { accessTokenTtlSeconds: 900, refreshTokenTtlSeconds: 3600, jwtSecret: "a-long-enough-test-secret", cookieSecure: environment === "production", passkey: { enabled: false } },
    oidc: { enabled: false },
    web: { host: "127.0.0.1", port: 43001 },
    admin: { host: "127.0.0.1", port: 43002 },
    gateway: { host: "127.0.0.1", port: 43000, maxRequestBodyBytes: 1024, ingressRouteAttestationMode: "observe" },
    providers: [],
    logging: { level: "info", redactKeys: [] },
    bootstrap: { enabled: false, ownerEmail: "owner@example.test" },
  };
}

describe("Pi Tunnel configuration", () => {
  test("is disabled by default", () => {
    expect(parseConfig(baseConfig()).piTunnel).toEqual({ enabled: false });
  });

  test("admits only the explicit single-instance local profile", () => {
    const config = parseConfig({
      ...baseConfig(),
      piTunnel: {
        enabled: true,
        mode: "single-instance",
        host: "127.0.0.1",
        port: 43008,
      },
    });
    expect(config.piTunnel).toMatchObject({ enabled: true, mode: "single-instance", maxConnections: 1_024, maxFrameBytes: 1_048_576, maxQueuedFrames: 4_096 });
  });

  test("rejects production enablement, non-loopback binding, and invalid backpressure bounds", () => {
    expect(() => parseConfig({
      ...baseConfig("production"),
      piTunnel: { enabled: true, mode: "single-instance", host: "127.0.0.1", port: 43008 },
    })).toThrow("Pi Tunnel phase 1 has no production topology");
    expect(() => parseConfig({
      ...baseConfig(),
      piTunnel: { enabled: true, mode: "single-instance", host: "0.0.0.0", port: 43008 },
    })).toThrow();
    expect(() => parseConfig({
      ...baseConfig(),
      piTunnel: {
        enabled: true,
        mode: "single-instance",
        host: "127.0.0.1",
        port: 43008,
        maxFrameBytes: 1_048_576,
        bufferedHighWaterBytes: 65_536,
      },
    })).toThrow("Pi Tunnel buffered high-water limit must cover one maximum frame");
  });
});
