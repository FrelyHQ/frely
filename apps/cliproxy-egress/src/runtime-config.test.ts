import { describe, expect, test } from "vitest";
import { loadCliProxyEgressRuntimeConfig } from "./runtime-config.js";

describe("CLIProxy egress runtime config", () => {
  test("validates the listening and allowed ports", () => {
    const config = loadCliProxyEgressRuntimeConfig({ PORT: "8318", CLIPROXY_EGRESS_ALLOWED_PORTS: "80,443" });
    expect(config.port).toBe(8318);
    expect([...config.allowedPorts]).toEqual([80, 443]);
  });

  test("rejects invalid allowed ports", () => {
    expect(() => loadCliProxyEgressRuntimeConfig({ CLIPROXY_EGRESS_ALLOWED_PORTS: "443,0" })).toThrow("CLIPROXY_EGRESS_ALLOWED_PORTS is invalid");
  });

  test("accepts one exact Tailscale IPv4 HTTP origin", () => {
    const config = loadCliProxyEgressRuntimeConfig({ CLIPROXY_EGRESS_PRIVATE_PROVIDER_ORIGIN: "http://100.64.0.10:43003" });
    expect(config.privateProviderOrigin).toEqual({ hostname: "100.64.0.10", port: 43003 });
  });

  test("rejects non-Tailscale or non-HTTP private Provider origins", () => {
    expect(() => loadCliProxyEgressRuntimeConfig({ CLIPROXY_EGRESS_PRIVATE_PROVIDER_ORIGIN: "http://192.168.1.2:43003" }))
      .toThrow("CLIPROXY_EGRESS_PRIVATE_PROVIDER_ORIGIN is invalid");
    expect(() => loadCliProxyEgressRuntimeConfig({ CLIPROXY_EGRESS_PRIVATE_PROVIDER_ORIGIN: "https://100.64.0.10:43003" }))
      .toThrow("CLIPROXY_EGRESS_PRIVATE_PROVIDER_ORIGIN is invalid");
  });
});
