import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { validateGatewayRuntimeConfig } from "./runtime-config.js";

const valid = {
  NODE_ENV: "production",
  CLIPROXY_BASE_URL: "http://cli-proxy-api:8317",
  CLIPROXY_API_KEY: "i".repeat(32),
  CLIPROXY_CONTROL_BASE_URL: "http://cliproxy-control:8319",
  CLIPROXY_CONTROL_API_KEY: "c".repeat(32)
};

describe("Gateway/Admin runtime config", () => {
  test("accepts the complete production environment", () => {
    expect(() => validateGatewayRuntimeConfig(valid)).not.toThrow();
  });

  test("rejects a Gateway CPA host outside the production topology", () => {
    expect(() => validateGatewayRuntimeConfig({ ...valid, CLIPROXY_BASE_URL: "https://example.com" }))
      .toThrow("CLIProxyAPI production host is not allowed");
  });

  test("rejects an invalid Admin control credential", () => {
    expect(() => validateGatewayRuntimeConfig({ ...valid, CLIPROXY_CONTROL_API_KEY: "short" }))
      .toThrow("CLIProxyAPI control credential is not configured");
  });

  test("fails closed for the unadmitted Edge Relay startup mode", () => {
    expect(() => validateGatewayRuntimeConfig({ ...valid, FRIDAY_RELAY_GATEWAY_MODE: "edge_relay" }))
      .toThrow("gateway_edge_relay_mode_not_admitted");
  });

  test("accepts a production registry without global CPA key environment variables", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-relay-runtime-registry-"));
    try {
      const inferenceKey = join(root, "inference.key");
      const controlKey = join(root, "control.key");
      writeFileSync(inferenceKey, "i".repeat(32));
      writeFileSync(controlKey, "c".repeat(32));
      chmodSync(inferenceKey, 0o600);
      chmodSync(controlKey, 0o600);
      const registry = join(root, "registry.json");
      writeFileSync(registry, JSON.stringify({ schemaVersion: 1, instances: {
        cpa_default: {
          inferenceOrigin: "http://cli-proxy-api:8317",
          controlOrigin: "http://cliproxy-control:8319",
          inferenceKeyFile: inferenceKey,
          controlKeyFile: controlKey,
        },
      } }));
      expect(() => validateGatewayRuntimeConfig({
        NODE_ENV: "production",
        FRIDAY_RELAY_CPA_CONNECTION_REGISTRY_FILE: registry,
      })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
