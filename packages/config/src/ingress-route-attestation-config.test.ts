import { testConfig } from "@frely/testkit";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./index.js";

describe("Gateway ingress route attestation configuration", () => {
  it("defaults to observe and accepts only observe or required", () => {
    const base = testConfig();
    const { ingressRouteAttestationMode: _mode, ...gateway } = base.gateway;
    expect(parseConfig({ ...base, gateway }).gateway.ingressRouteAttestationMode).toBe("observe");
    expect(parseConfig({ ...base, gateway: { ...gateway, ingressRouteAttestationMode: "required" } }).gateway.ingressRouteAttestationMode).toBe("required");
    expect(() => parseConfig({ ...base, gateway: { ...gateway, ingressRouteAttestationMode: "permissive" } })).toThrow();
  });
});
