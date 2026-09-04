import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { resolvePublicProviderUrl, RelayError, type PublicProviderUrlResolution } from "@frely/core";
import type { HubConfig, HubUpstream } from "./config.js";

export interface AllowedUpstreamUrl {
  url: URL;
  connectionUrl: URL;
  family?: 4 | 6;
  servername?: string;
}

export async function assertUpstreamUrlAllowed(
  config: HubConfig,
  upstream: HubUpstream,
  value: string,
  resolvePublicUrl: (candidate: string) => Promise<PublicProviderUrlResolution> = resolvePublicProviderUrl
): Promise<AllowedUpstreamUrl> {
  if (upstream.kind === "remote-openai") {
    const resolved = await resolvePublicUrl(value);
    const connectionUrl = new URL(resolved.url);
    connectionUrl.hostname = resolved.family === 6 ? `[${resolved.address}]` : resolved.address;
    const hostname = normalizeHostname(resolved.url.hostname);
    return {
      url: resolved.url,
      connectionUrl,
      family: resolved.family,
      ...(isIP(hostname) === 0 ? { servername: hostname } : {})
    };
  }
  const url = await assertLocalUrlAllowed(config, value);
  return { url, connectionUrl: url };
}

export function isLoopbackHost(host: string): boolean {
  const hostname = normalizeHostname(host);
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function isLoopbackListenHost(host: string): boolean {
  return isLoopbackHost(host) || host === "";
}

async function assertLocalUrlAllowed(config: HubConfig, value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayError("invalid_upstream_url", "Local upstream URL is invalid", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RelayError("upstream_url_not_allowed", "Local upstream URL must use HTTP or HTTPS", 400);
  }
  const rawHostname = url.hostname.toLowerCase();
  const hostname = normalizeHostname(rawHostname);
  if (isLoopbackHost(hostname)) return url;
  if (config.security.localNetworkAllowlist.includes(rawHostname) || config.security.localNetworkAllowlist.includes(hostname)) return url;
  const directIp = isIP(hostname) ? [hostname] : [];
  const resolvedIps = directIp.length > 0 ? directIp : (await lookup(hostname, { all: true })).map((item) => item.address);
  if (resolvedIps.length > 0 && resolvedIps.every((ip) => config.security.localNetworkAllowlist.includes(ip))) return url;
  throw new RelayError("upstream_url_not_allowed", "Local upstream must be loopback or explicitly allowlisted", 400);
}

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}
