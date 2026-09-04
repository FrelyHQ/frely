import type { AppConfig } from "@frely/config";
import { testConfig } from "@frely/testkit";
import { describe, expect, it } from "vitest";
import {
  INTERNAL_GATEWAY_INGRESS_ROUTE_ID,
  INGRESS_ROUTE_ATTESTATION_HEADER,
  isPlatformGatewayHostname,
  resolveGatewayRequestHostAsync,
} from "./gateway-hosts.js";

const repo = {
  async resolveEnabledPublicHost() { return null; },
  async resolveActiveDomainBinding() { return null; },
};

describe("Gateway host trust", () => {
  it("accepts only the platform hostname and the fixed Compose-internal Gateway hostname", () => {
    expect(isPlatformGatewayHostname("relay.example", "https://relay.example")).toBe(true);
    expect(isPlatformGatewayHostname("gateway-srv", "https://relay.example")).toBe(true);
    expect(isPlatformGatewayHostname("unbound.example", "https://relay.example")).toBe(false);
  });

  it("preserves the normalized admitted Host and observes a missing external route attestation", async () => {
    await expect(resolveGatewayRequestHostAsync(repo, config("observe"), new Headers({ host: "Relay.Example.Test." })))
      .resolves.toEqual({ kind: "default", hostname: "relay.example.test", ingressRouteId: null });
  });

  it("accepts only the stable lowercase route id grammar for external Hosts", async () => {
    const headers = new Headers({ host: "relay.example.test", [INGRESS_ROUTE_ATTESTATION_HEADER]: "edge:relay.hk-v1" });
    await expect(resolveGatewayRequestHostAsync(repo, config("observe"), headers))
      .resolves.toMatchObject({ ingressRouteId: "edge:relay.hk-v1" });

    for (const value of ["Edge:relay", "edge:relay,edge:other", "", `a${"b".repeat(128)}`]) {
      await expect(resolveGatewayRequestHostAsync(repo, config("observe"), new Headers({ host: "relay.example.test", [INGRESS_ROUTE_ATTESTATION_HEADER]: value })))
        .rejects.toMatchObject({ code: "host_not_allowed", status: 421 });
    }
  });

  it("requires external attestation only in required mode", async () => {
    await expect(resolveGatewayRequestHostAsync(repo, config("required"), new Headers({ host: "relay.example.test" })))
      .rejects.toMatchObject({ code: "host_not_allowed", status: 421 });
  });

  it("owns the internal route identity and rejects any supplied attestation", async () => {
    await expect(resolveGatewayRequestHostAsync(repo, config("required"), new Headers({ host: "gateway-srv" })))
      .resolves.toEqual({ kind: "internal", hostname: "gateway-srv", ingressRouteId: INTERNAL_GATEWAY_INGRESS_ROUTE_ID });

    await expect(resolveGatewayRequestHostAsync(repo, config("observe"), new Headers({ host: "gateway-srv", [INGRESS_ROUTE_ATTESTATION_HEADER]: "internal:spoof" })))
      .rejects.toMatchObject({ code: "host_not_allowed", status: 421 });
  });
});

function config(mode: AppConfig["gateway"]["ingressRouteAttestationMode"]): AppConfig {
  const base = testConfig();
  return {
    ...base,
    app: { ...base.app, publicBaseUrl: "https://relay.example.test" },
    gateway: { ...base.gateway, ingressRouteAttestationMode: mode },
  };
}
