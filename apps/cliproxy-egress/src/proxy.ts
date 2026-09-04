import { promises as dns } from "node:dns";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import net, { type Socket } from "node:net";
import { pipeline } from "node:stream";

const DEFAULT_PORTS = new Set([80, 443]);
const DEFAULT_HEADER_BYTES = 32 * 1024;
const DEFAULT_HEADER_COUNT = 64;
const DEFAULT_DNS_TIMEOUT_MS = 5_000;
export const CLIPROXY_EGRESS_DEFAULT_LIFECYCLE = Object.freeze({
  idleTimeoutMs: 10 * 60_000,
  requestTimeoutMs: 30 * 60_000
});
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface EgressProxyOptions {
  allowedPorts?: ReadonlySet<number>;
  headerBytes?: number;
  headerCount?: number;
  dnsTimeoutMs?: number;
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  connect?: (address: ResolvedAddress, port: number) => Socket;
  privateProviderOrigin?: { hostname: string; port: number };
}

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["100::", 64],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 23],
  ["2002::", 16],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  if (family === 6 && new net.SocketAddress({ address, family: "ipv6" }).address.startsWith("::ffff:")) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error("invalid target port");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid target port");
  return port;
}

function assertTargetHostname(hostname: string): void {
  if (!hostname || hostname.length > 253 || hostname.endsWith(".")) throw new Error("invalid target host");
  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
    throw new Error("target host is not public");
  }
  const ipFamily = net.isIP(hostname);
  if (ipFamily !== 0 && !isPublicAddress(hostname)) throw new Error("target address is not public");
}

export function parseForwardTarget(
  rawUrl: string,
  allowedPorts: ReadonlySet<number> = DEFAULT_PORTS,
  privateProviderOrigin?: { hostname: string; port: number },
): URL {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error("absolute target URL required");
  }
  if (target.protocol !== "http:") throw new Error("forward proxy only accepts HTTP targets");
  if (target.username || target.password || target.hash) throw new Error("target credentials and fragments are forbidden");
  const port = parsePort(target.port, 80);
  const isExactPrivateOrigin = privateProviderOrigin?.hostname === target.hostname && privateProviderOrigin.port === port;
  if (!isExactPrivateOrigin) {
    assertTargetHostname(target.hostname);
    if (!allowedPorts.has(port)) throw new Error("target port is forbidden");
  }
  return target;
}

export function parseConnectTarget(rawAuthority: string, allowedPorts: ReadonlySet<number> = DEFAULT_PORTS): {
  hostname: string;
  port: number;
} {
  let target: URL;
  try {
    target = new URL(`https://${rawAuthority}`);
  } catch {
    throw new Error("invalid CONNECT authority");
  }
  if (target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("invalid CONNECT authority");
  }
  assertTargetHostname(target.hostname);
  const port = parsePort(target.port, 443);
  if (!allowedPorts.has(port)) throw new Error("target port is forbidden");
  return { hostname: target.hostname, port };
}

async function defaultResolve(hostname: string): Promise<readonly ResolvedAddress[]> {
  if (net.isIP(hostname) !== 0) {
    return [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }];
  }
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

export async function resolveAndPin(
  hostname: string,
  resolve: (hostname: string) => Promise<readonly ResolvedAddress[]> = defaultResolve,
): Promise<ResolvedAddress> {
  const addresses = await resolve(hostname);
  if (addresses.length === 0) throw new Error("target DNS returned no addresses");
  for (const address of addresses) {
    if ((address.family !== 4 && address.family !== 6) || net.isIP(address.address) !== address.family) {
      throw new Error("target DNS returned an invalid address");
    }
    if (!isPublicAddress(address.address)) throw new Error("target DNS returned a non-public address");
  }
  return addresses[0]!;
}

async function resolveAndPinWithin(
  hostname: string,
  resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>,
  timeoutMs: number,
): Promise<ResolvedAddress> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      resolveAndPin(hostname, resolve),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("target DNS timed out")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertHeaderBounds(message: IncomingMessage, maxCount: number, maxBytes: number): void {
  if (message.rawHeaders.length / 2 > maxCount) throw new Error("too many headers");
  let bytes = 0;
  for (const header of message.rawHeaders) bytes += Buffer.byteLength(header);
  if (bytes > maxBytes) throw new Error("headers are too large");
}

function sanitizedHeaders(headers: IncomingHttpHeaders, host?: string): IncomingHttpHeaders {
  const connectionTokens = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const result: IncomingHttpHeaders = host ? { host } : {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;
    result[lower] = value;
  }
  return result;
}

function respondError(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "text/plain", connection: "close" });
  response.end(status === 403 ? "egress target rejected\n" : "egress proxy failure\n");
}

function destroyQuietly(socket: Socket | undefined): void {
  if (socket && !socket.destroyed) socket.destroy();
}

export function createEgressProxy(options: EgressProxyOptions = {}): http.Server {
  const allowedPorts = options.allowedPorts ?? DEFAULT_PORTS;
  const maxHeaderBytes = options.headerBytes ?? DEFAULT_HEADER_BYTES;
  const maxHeaderCount = options.headerCount ?? DEFAULT_HEADER_COUNT;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? CLIPROXY_EGRESS_DEFAULT_LIFECYCLE.idleTimeoutMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? CLIPROXY_EGRESS_DEFAULT_LIFECYCLE.requestTimeoutMs;
  const resolve = options.resolve ?? defaultResolve;
  const connect = options.connect ?? ((address, port) => net.connect({ host: address.address, port, family: address.family }));
  const privateProviderOrigin = options.privateProviderOrigin;

  const server = http.createServer(
    {
      maxHeaderSize: maxHeaderBytes,
      requestTimeout: requestTimeoutMs,
      headersTimeout: Math.min(idleTimeoutMs, requestTimeoutMs),
      keepAliveTimeout: 5_000,
    },
    async (request, response) => {
      if (request.url === "/healthz" && ["127.0.0.1", "127.0.0.1:8318"].includes(request.headers.host ?? "")) {
        response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("ok\n");
        return;
      }

      let target: URL;
      try {
        assertHeaderBounds(request, maxHeaderCount, maxHeaderBytes);
        target = parseForwardTarget(request.url ?? "", allowedPorts, privateProviderOrigin);
      } catch {
        request.resume();
        respondError(response, 403);
        return;
      }

      let pinned: ResolvedAddress;
      try {
        const port = parsePort(target.port, 80);
        pinned = privateProviderOrigin && target.hostname === privateProviderOrigin.hostname && port === privateProviderOrigin.port
          ? await resolvePrivateOriginWithin(target.hostname, resolve, dnsTimeoutMs)
          : await resolveAndPinWithin(target.hostname, resolve, dnsTimeoutMs);
      } catch {
        request.resume();
        respondError(response, 403);
        return;
      }
      if (request.destroyed || response.destroyed) return;

      const port = parsePort(target.port, 80);
      let upstreamSocket: Socket | undefined;
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => {
        upstreamSocket = connect(pinned, port);
        upstreamSocket.setTimeout(idleTimeoutMs, () => upstreamSocket?.destroy());
        return upstreamSocket;
      };
      const upstream = http.request({
        protocol: "http:",
        hostname: target.hostname,
        port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: sanitizedHeaders(request.headers, target.host),
        maxHeaderSize: maxHeaderBytes,
        setHost: false,
        agent,
      });
      upstream.maxHeadersCount = maxHeaderCount;
      const deadline = setTimeout(() => upstream.destroy(), requestTimeoutMs);
      deadline.unref();
      const abort = () => upstream.destroy();
      request.once("aborted", abort);
      response.once("close", abort);
      upstream.once("response", (upstreamResponse) => {
        try {
          assertHeaderBounds(upstreamResponse, maxHeaderCount, maxHeaderBytes);
        } catch {
          upstreamResponse.destroy();
          respondError(response, 502);
          return;
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, sanitizedHeaders(upstreamResponse.headers));
        pipeline(upstreamResponse, response, () => undefined);
      });
      upstream.once("error", () => respondError(response, 502));
      upstream.once("close", () => {
        clearTimeout(deadline);
        agent.destroy();
        request.off("aborted", abort);
        response.off("close", abort);
      });
      pipeline(request, upstream, () => undefined);
    },
  );

  server.on("connect", async (request, rawClientSocket, head) => {
    const clientSocket = rawClientSocket as Socket;
    let target: { hostname: string; port: number };
    try {
      assertHeaderBounds(request, maxHeaderCount, maxHeaderBytes);
      target = parseConnectTarget(request.url ?? "", allowedPorts);
    } catch {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    let pinned: ResolvedAddress;
    try {
      pinned = await resolveAndPinWithin(target.hostname, resolve, dnsTimeoutMs);
    } catch {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (clientSocket.destroyed) return;

    const upstreamSocket = connect(pinned, target.port);
    const deadline = setTimeout(() => {
      destroyQuietly(clientSocket);
      destroyQuietly(upstreamSocket);
    }, requestTimeoutMs);
    deadline.unref();
    const closeBoth = () => {
      clearTimeout(deadline);
      destroyQuietly(clientSocket);
      destroyQuietly(upstreamSocket);
    };
    clientSocket.setTimeout(idleTimeoutMs, closeBoth);
    upstreamSocket.setTimeout(idleTimeoutMs, closeBoth);
    let connected = false;
    upstreamSocket.once("error", () => {
      if (!clientSocket.destroyed && !connected) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      } else {
        closeBoth();
      }
    });
    upstreamSocket.once("connect", () => {
      connected = true;
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstreamSocket.write(head);
      pipeline(clientSocket, upstreamSocket, () => closeBoth());
      pipeline(upstreamSocket, clientSocket, () => closeBoth());
    });
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

async function resolvePrivateOriginWithin(
  hostname: string,
  resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>,
  timeoutMs: number,
): Promise<ResolvedAddress> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      resolve(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("target DNS timed out")), timeoutMs);
        timer.unref();
      }),
    ]);
    const first = addresses[0];
    if (!first || (first.family !== 4 && first.family !== 6) || net.isIP(first.address) !== first.family) throw new Error("target DNS returned an invalid address");
    return first;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
