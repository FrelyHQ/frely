import { afterEach, describe, expect, test, vi } from "vitest";
import { cliProxyApiImageVersion, runtimeVersions } from "./runtime-versions";

afterEach(() => vi.unstubAllEnvs());

describe("runtimeVersions", () => {
  test("shows versions reported by the running Web and Gateway services", async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, service: "web", version: "0.45.1" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, service: "gateway-srv", version: "0.45.0" })));

    await expect(runtimeVersions({
      fetchImplementation,
      webBaseUrl: "http://web:43001",
      gatewayBaseUrl: "http://gateway-srv:43000",
      cliProxyApiImage: "ghcr.io/hu-wentao/friday-relay-cli-proxy-api@sha256:da72cae2b450a71720d2555bc905e3e27de14161208776b71ba471d0318a9867",
      cliProxyRuntimeIdentity: async () => ({ version: "v7.2.145", commit: "d9cea89", buildDate: "2026-08-28T09:30:55.000Z", evidenceContract: "cpa-basic@1", adaptation: "friday-evidence-v1" })
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ service: "User Console", version: "0.45.1", availability: "running" }),
      expect.objectContaining({ service: "Gateway", version: "0.45.0", availability: "running" }),
      expect.objectContaining({ service: "CLIProxyAPI Running binary", version: "v7.2.145", detail: "Commit d9cea89; cpa-basic@1; friday-evidence-v1; built 2026-08-28T09:30:55.000Z", availability: "running" }),
      expect.objectContaining({ service: "CLIProxyAPI Configured image", version: "digest-pinned", detail: "Pinned image sha256:da72cae2b450", availability: "configured" })
    ]));
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  test("uses a bundled version when a runtime health check is unavailable", async () => {
    const fetchImplementation = vi.fn().mockRejectedValue(new Error("unavailable"));

    const versions = await runtimeVersions({
      fetchImplementation,
      gatewayFallbackVersion: "0.61.0",
      webFallbackVersion: "0.61.0",
      cliProxyRuntimeIdentity: async () => { throw new Error("unavailable"); }
    });

    expect(versions.find((item) => item.service === "Gateway")).toMatchObject({
      availability: "unavailable",
      version: "0.61.0",
      detail: "Runtime health check unavailable; configured version",
    });
    expect(versions.find((item) => item.service === "CLIProxyAPI Running binary")).toMatchObject({ availability: "unavailable", version: "unavailable" });
  });

  test("falls back to startup image metadata without importing sibling applications", async () => {
    const fetchImplementation = vi.fn().mockRejectedValue(new Error("unavailable"));
    vi.stubEnv("FRIDAY_RELAY_GATEWAY_IMAGE", "friday-relay-gateway:pkg-0.61.0");
    vi.stubEnv("FRIDAY_RELAY_WEB_IMAGE", "friday-relay-web:pkg-0.61.1");

    const versions = await runtimeVersions({
      fetchImplementation,
      cliProxyRuntimeIdentity: async () => { throw new Error("unavailable"); }
    });

    expect(versions.find((item) => item.service === "Gateway")).toMatchObject({ version: "0.61.0", availability: "unavailable" });
    expect(versions.find((item) => item.service === "User Console")).toMatchObject({ version: "0.61.1", availability: "unavailable" });
  });

  test("marks a running CLIProxyAPI identity mismatch as an error without substituting the configured image", async () => {
    const versions = await runtimeVersions({
      fetchImplementation: vi.fn().mockRejectedValue(new Error("unavailable")),
      cliProxyRuntimeIdentity: async () => ({ version: "v7.2.101", commit: "deadbee", buildDate: "2026-07-26T20:55:09.000Z", evidenceContract: "cpa-basic@1", adaptation: "friday-evidence-v1" })
    });

    expect(versions.find((item) => item.service === "CLIProxyAPI Running binary")).toMatchObject({
      version: "v7.2.101",
      availability: "error",
      detail: "Expected v7.2.145 / d9cea89 / cpa-basic@1; reported v7.2.101 / deadbee / cpa-basic@1"
    });
    expect(versions.find((item) => item.service === "CLIProxyAPI Configured image")).toMatchObject({
      version: "latest",
      availability: "configured"
    });
  });

  test("formats a non-digest CLIProxyAPI image without fabricating a digest", () => {
    expect(cliProxyApiImageVersion("eceasy/cli-proxy-api:latest")).toEqual({ version: "latest", detail: "Configured image tag" });
  });
});
