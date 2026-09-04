import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { RelayError } from "@frely/core";
import { ProxyAgent } from "proxy-agent";
import type { HubConfig, HubProxyConfig, HubUpstream } from "./config.js";
import { assertUpstreamUrlAllowed, type AllowedUpstreamUrl } from "./security.js";

export interface UpstreamRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  upstream: HubUpstream;
  proxy: HubProxyConfig;
}

const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

export async function requestUpstream(config: HubConfig, request: UpstreamRequest, redirects = 0): Promise<Response> {
  if (redirects > 5) throw new RelayError("upstream_redirect_limit", "Upstream redirect limit exceeded", 502);
  const target = await assertUpstreamUrlAllowed(config, request.upstream, request.url);
  const response = await nodeRequest(target, request);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) return response;
    const redirectUrl = new URL(location, target.url);
    if (redirectUrl.origin !== target.url.origin) {
      throw new RelayError("upstream_redirect_not_allowed", "Upstream redirect target is not allowed", 502);
    }
    return requestUpstream(config, { ...request, url: redirectUrl.toString() }, redirects + 1);
  }
  return response;
}

export function resolveProxyConfig(config: HubConfig, upstream: HubUpstream): HubProxyConfig {
  if (upstream.kind !== "remote-openai") return { mode: "none" };
  if (!upstream.proxy || upstream.proxy === "default") return config.proxy;
  return upstream.proxy;
}

export function proxyModeLabel(proxy: HubProxyConfig): string {
  return proxy.mode;
}

export function joinUpstreamUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  if (new URL(normalizedBase).pathname.endsWith("/v1") && endpoint.startsWith("/v1/")) {
    return `${normalizedBase}${endpoint.slice(3)}`;
  }
  return `${normalizedBase}${endpoint}`;
}

function nodeRequest(target: AllowedUpstreamUrl, request: UpstreamRequest): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = target.url;
    const useHttps = url.protocol === "https:";
    const headers = { ...request.headers };
    if (target.connectionUrl !== target.url) headers.host = url.host;
    if (request.body !== undefined && headers["content-length"] === undefined) {
      headers["content-length"] = Buffer.byteLength(request.body).toString();
    }
    const client = useHttps ? https : http;
    const outgoing = client.request(target.connectionUrl, {
      method: request.method,
      headers,
      agent: agentFor(url, request.proxy),
      ...(target.family === undefined ? {} : { family: target.family }),
      ...(target.servername === undefined ? {} : { servername: target.servername })
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) responseHeaders.set(key, value.join(","));
        else if (value !== undefined) responseHeaders.set(key, value);
      }
      const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status: incoming.statusCode ?? 502, headers: responseHeaders }));
    });
    outgoing.on("error", reject);
    if (request.body !== undefined) outgoing.write(request.body);
    outgoing.end();
  });
}

function agentFor(url: URL, proxy: HubProxyConfig): http.Agent | https.Agent | ProxyAgent {
  if (proxy.mode === "none") return url.protocol === "https:" ? keepAliveHttpsAgent : keepAliveHttpAgent;
  if (proxy.mode === "explicit") {
    const proxyUrl = process.env[proxy.urlEnv];
    if (!proxyUrl) throw new RelayError("proxy_url_missing", "Configured proxy URL env is missing", 500);
    return new ProxyAgent({
      keepAlive: true,
      getProxyForUrl: () => proxyUrl
    });
  }
  return new ProxyAgent({ keepAlive: true });
}
