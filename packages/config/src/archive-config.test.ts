import { describe, expect, test } from "vitest";
import { parseConfig } from "./index.js";

function baseConfig() {
  return {
    app: { name: "Frely", environment: "development" as const, publicBaseUrl: "http://localhost:43001", reservedHostnames: [] },
    database: { backend: "postgres" as const },
    archive: { directory: "./archives", coldDirectory: "./archives-cold", requireColdMount: false },
    auth: { accessTokenTtlSeconds: 900, refreshTokenTtlSeconds: 3_600, jwtSecret: "a-long-enough-test-secret", cookieSecure: false },
    web: { host: "127.0.0.1", port: 43_001 },
    admin: { host: "127.0.0.1", port: 43_002 },
    gateway: { host: "127.0.0.1", port: 43_000, maxRequestBodyBytes: 1_024 },
    providers: [],
    logging: { level: "info" as const, redactKeys: [] },
    bootstrap: { enabled: false, ownerEmail: "owner@example.test" },
  };
}

describe("archive configuration defaults", () => {
  test("enables Capture and history archive pipelines independently by default", () => {
    const config = parseConfig(baseConfig());

    expect(config.requestCapture.archive).toMatchObject({ enabled: true, autoPurge: true });
    expect(config.archive.history).toMatchObject({ enabled: true, autoPurge: true, hotDays: 180 });
    expect(config).not.toHaveProperty("requestLogArchive");
  });

  test("allows both archive pipelines to be explicitly disabled", () => {
    const config = parseConfig({
      ...baseConfig(),
      requestCapture: { archive: { enabled: false, autoPurge: false } },
      archive: { ...baseConfig().archive, history: { enabled: false, autoPurge: false } },
    });

    expect(config.requestCapture.archive).toMatchObject({ enabled: false, autoPurge: false });
    expect(config.archive.history).toMatchObject({ enabled: false, autoPurge: false });
  });

  test("normalizes the retired requestLogArchive input without exposing it", () => {
    const config = parseConfig({
      ...baseConfig(),
      requestLogArchive: { enabled: false, autoPurge: false, hotDays: 180, purgeBatchSize: 77, reconciliation: { leaseTtlSeconds: 900 } },
    });
    expect(config.archive.history).toMatchObject({ enabled: false, autoPurge: false, hotDays: 180, purgeBatchSize: 77 });
    expect(config.requestExecution.leaseTtlSeconds).toBe(900);
    expect(config).not.toHaveProperty("requestLogArchive");
  });
});
