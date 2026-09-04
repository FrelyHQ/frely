import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "@frely/config";
import type { BudgetPolicy, BudgetLimitScope, PlanBudgetLimitInput } from "@frely/application/runtime";

export function privatePlanBudgetLimit(policy: Pick<BudgetPolicy, "metric" | "limitValue" | "windowType" | "windowSeconds">, limitScope: BudgetLimitScope): PlanBudgetLimitInput {
  if (policy.metric !== "tokens" && policy.metric !== "amount") throw new Error("Test budget policy metric must be tokens or amount");
  if (policy.windowType !== "rolling" && policy.windowType !== "cumulative") throw new Error("Test budget policy windowType must be rolling or cumulative");
  return { limitScope, metric: policy.metric, limitValue: policy.limitValue, windowType: policy.windowType === "rolling" ? "fixed" : "cumulative", windowSeconds: policy.windowSeconds };
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "friday-relay-"));
  const base: AppConfig = {
    app: { name: "Frely", environment: "test", publicBaseUrl: "http://localhost:43001", reservedHostnames: [] },
    database: { backend: "postgres" },
    archive: {
      directory: join(dir, "archives"),
      requireColdMount: true,
      history: { enabled: false, autoPurge: false, hotDays: 180, purgeBatchSize: 200 }
    },
    requestCapture: {
      hotDays: 90,
      archive: { enabled: false, autoPurge: false, purgeBatchSize: 200, zstdLevel: 6, frameUncompressedBytes: 67_108_864 },
      download: { maxFiles: 10_000, maxCompressedBytes: 1_073_741_824 }
    },
    requestExecution: { leaseTtlSeconds: 1_800, staleAfterSeconds: 86_400 },
    security: { abuseRateLimit: {} },
    auth: { accessTokenTtlSeconds: 900, refreshTokenTtlSeconds: 2592000, jwtSecret: "test-secret-with-enough-length", cookieSecure: false, passkey: { enabled: false } },
    web: { host: "127.0.0.1", port: 43001 },
    admin: { host: "127.0.0.1", port: 43002 },
    gateway: {
      host: "127.0.0.1",
      port: 43000,
      maxRequestBodyBytes: 16_777_216,
      ingressRouteAttestationMode: "observe"
    },
    piTunnel: { enabled: false },
    providers: [{ id: "openai_main", kind: "openai", displayName: "OpenAI Main", baseUrl: "http://localhost:9/v1", enabled: true, config: {} }],
    logging: { level: "info", redactKeys: [] },
    bootstrap: { enabled: true, ownerEmail: "admin@example.local" }
  };
  return { ...base, ...overrides };
}
