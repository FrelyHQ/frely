import { describe, expect, test } from "vitest";
import { loadCliProxyControlRuntimeConfig } from "./runtime-config.js";

const valid = {
  PORT: "8319",
  CLIPROXY_BASE_URL: "http://cli-proxy-api:8317",
  CLIPROXY_API_KEY: "i".repeat(32),
  CLIPROXY_MANAGEMENT_API_KEY: "m".repeat(32),
  CLIPROXY_CONTROL_API_KEY: "c".repeat(32),
  CLIPROXY_CREDENTIAL_STORE_KEY: "ab".repeat(32),
  CLIPROXY_OAUTH_SESSION_TTL_MS: "600000"
};

describe("CLIProxy Control runtime config", () => {
  test("validates the complete runtime environment", () => {
    const config = loadCliProxyControlRuntimeConfig(valid);
    expect(config.port).toBe(8319);
    expect(config.storeKey.byteLength).toBe(32);
    expect(config.cpaInstanceId).toBe("cpa_default");
  });

  test("rejects an invalid credential store key before startup", () => {
    expect(() => loadCliProxyControlRuntimeConfig({ ...valid, CLIPROXY_CREDENTIAL_STORE_KEY: "short" }))
      .toThrow("cliproxy_control_store_key_invalid");
  });

  test("rejects shared inference and management keys", () => {
    expect(() => loadCliProxyControlRuntimeConfig({ ...valid, CLIPROXY_MANAGEMENT_API_KEY: valid.CLIPROXY_API_KEY }))
      .toThrow("cliproxy_control_keys_not_separated");
  });

  test("rejects an invalid CPA instance identity", () => {
    expect(() => loadCliProxyControlRuntimeConfig({ ...valid, CLIPROXY_CPA_INSTANCE_ID: "other" }))
      .toThrow("cliproxy_cpa_instance_id_invalid");
  });

  test("rejects a non-HTTP CPA URL", () => {
    expect(() => loadCliProxyControlRuntimeConfig({ ...valid, CLIPROXY_BASE_URL: "file:///tmp/config" }))
      .toThrow("cliproxy_base_url_invalid");
  });

  test("accepts one exact Tailscale Provider origin", () => {
    expect(loadCliProxyControlRuntimeConfig({
      ...valid,
      CLIPROXY_CONTROL_PRIVATE_PROVIDER_ORIGIN: "http://100.64.0.10:43003"
    }).privateProviderOrigin).toBe("http://100.64.0.10:43003");
  });

  test("rejects a broad or non-Tailscale private Provider origin", () => {
    expect(() => loadCliProxyControlRuntimeConfig({
      ...valid,
      CLIPROXY_CONTROL_PRIVATE_PROVIDER_ORIGIN: "http://10.0.0.1:43003"
    })).toThrow("cliproxy_private_provider_origin_invalid");
  });
});
