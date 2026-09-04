import { parseConfiguredPrivateProviderOrigin } from "@frely/core";

export interface CliProxyEgressRuntimeConfig {
  port: number;
  allowedPorts: ReadonlySet<number>;
  privateProviderOrigin?: { hostname: string; port: number };
}

export function loadCliProxyEgressRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): CliProxyEgressRuntimeConfig {
  const port = parsePort(environment.PORT ?? "8318", "PORT is invalid");
  const privateProviderOrigin = environment.CLIPROXY_EGRESS_PRIVATE_PROVIDER_ORIGIN
    ? parseTailscalePrivateOrigin(environment.CLIPROXY_EGRESS_PRIVATE_PROVIDER_ORIGIN, "CLIPROXY_EGRESS_PRIVATE_PROVIDER_ORIGIN is invalid")
    : parseTestOnlyPrivateOrigin(environment.CLIPROXY_EGRESS_E2E_ALLOWED_ORIGIN, environment.NODE_ENV);
  return {
    port,
    allowedPorts: parseAllowedPorts(environment.CLIPROXY_EGRESS_ALLOWED_PORTS),
    ...(privateProviderOrigin ? { privateProviderOrigin } : {})
  };
}

function parseAllowedPorts(raw: string | undefined): ReadonlySet<number> {
  const ports = new Set<number>();
  for (const value of (raw ?? "80,443").split(",")) {
    ports.add(parsePort(value.trim(), "CLIPROXY_EGRESS_ALLOWED_PORTS is invalid"));
  }
  if (ports.size === 0) throw new Error("CLIPROXY_EGRESS_ALLOWED_PORTS must not be empty");
  return ports;
}

function parsePort(raw: string, message: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(message);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(message);
  return port;
}

function parseTestOnlyPrivateOrigin(raw: string | undefined, nodeEnvironment: string | undefined): { hostname: string; port: number } | undefined {
  if (!raw) return undefined;
  if (nodeEnvironment !== "test") throw new Error("CLIPROXY_EGRESS_E2E_ALLOWED_ORIGIN requires NODE_ENV=test");
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port) throw new Error("CLIPROXY_EGRESS_E2E_ALLOWED_ORIGIN is invalid");
  return { hostname: url.hostname, port: parsePort(url.port, "CLIPROXY_EGRESS_E2E_ALLOWED_ORIGIN is invalid") };
}

function parseTailscalePrivateOrigin(raw: string, message: string): { hostname: string; port: number } {
  try {
    const origin = parseConfiguredPrivateProviderOrigin(raw);
    return { hostname: origin.hostname, port: origin.port };
  } catch {
    throw new Error(message);
  }
}
