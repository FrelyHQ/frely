import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIPROXY_EGRESS_DEFAULT_LIFECYCLE,
  createEgressProxy,
  isPublicAddress,
  parseConnectTarget,
  parseForwardTarget,
  resolveAndPin,
} from "../apps/cliproxy-egress/src/proxy.js";
import {
  CLIPROXY_UNDICI_TIMEOUTS,
  DEFAULT_CLIPROXY_STREAM_HARD_LIFETIME_MS
} from "../packages/providers/src/cliproxy/client.js";
import { DEFAULT_CLIPROXY_TIMEOUT_MS } from "../packages/providers/src/cliproxy/config.js";
import { DEFAULT_CLIPROXY_STREAM_IDLE_TIMEOUT_MS } from "../packages/providers/src/cliproxy/transport.js";

const servers: Array<http.Server | net.Server> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: http.Server | net.Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return address.port;
}

describe("CLIProxy egress target validation", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "64:ff9b::1",
    "2001::1",
    "2002::1",
    "2001:db8::1",
    "3fff::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("accepts public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("limits schemes, ports, credentials, fragments, and local hostnames", () => {
    expect(() => parseForwardTarget("https://example.com/path")).toThrow();
    expect(() => parseForwardTarget("http://example.com:8080/path")).toThrow();
    expect(() => parseForwardTarget("http://user:secret@example.com/path")).toThrow();
    expect(() => parseForwardTarget("http://localhost/path")).toThrow();
    expect(() => parseConnectTarget("example.com:80", new Set([443]))).toThrow();
    expect(() => parseConnectTarget("127.0.0.1:443")).toThrow();
  });

  it("rejects an entire DNS answer set if any address is non-public", async () => {
    await expect(
      resolveAndPin("example.com", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]),
    ).rejects.toThrow("non-public");
  });
});

describe("CLIProxy egress forwarding", () => {
  it("does not impose a lifecycle shorter than the Provider transport", () => {
    expect(CLIPROXY_EGRESS_DEFAULT_LIFECYCLE).toEqual({
      idleTimeoutMs: DEFAULT_CLIPROXY_STREAM_IDLE_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_CLIPROXY_STREAM_HARD_LIFETIME_MS
    });
    expect(DEFAULT_CLIPROXY_TIMEOUT_MS).toBe(10 * 60_000);
    expect(DEFAULT_CLIPROXY_STREAM_IDLE_TIMEOUT_MS).toBe(DEFAULT_CLIPROXY_TIMEOUT_MS);
    expect(DEFAULT_CLIPROXY_STREAM_HARD_LIFETIME_MS).toBe(30 * 60_000);
    expect(CLIPROXY_UNDICI_TIMEOUTS).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
  });

  it("pins the validated IP, strips hop-by-hop headers, and streams HTTP", async () => {
    const seen: { body?: string; headers?: http.IncomingHttpHeaders; url?: string } = {};
    const target = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.body = Buffer.concat(chunks).toString("utf8");
        seen.headers = request.headers;
        seen.url = request.url;
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("forwarded");
      });
    });
    const targetPort = await listen(target);
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const connect = vi.fn(() => net.connect({ host: "127.0.0.1", port: targetPort }));
    const proxy = createEgressProxy({ resolve, connect, allowedPorts: new Set([80]) });
    const proxyPort = await listen(proxy);

    const result = await new Promise<{ body: string; status: number }>((resolveResult, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        method: "POST",
        path: "http://example.com/v1/test?x=1",
        headers: {
          host: "proxy.invalid",
          connection: "keep-alive, x-remove-me",
          "x-remove-me": "secret-hop-value",
          authorization: "Bearer opaque-upstream-secret",
        },
      });
      request.once("error", reject);
      request.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolveResult({ body: Buffer.concat(chunks).toString("utf8"), status: response.statusCode ?? 0 }));
      });
      request.end("streamed-body");
    });

    expect(result).toEqual({ body: "forwarded", status: 200 });
    expect(resolve).toHaveBeenCalledWith("example.com");
    expect(connect).toHaveBeenCalledWith({ address: "93.184.216.34", family: 4 }, 80);
    expect(seen).toMatchObject({ body: "streamed-body", url: "/v1/test?x=1" });
    expect(seen.headers?.host).toBe("example.com");
    expect(seen.headers?.authorization).toBe("Bearer opaque-upstream-secret");
    expect(seen.headers?.["x-remove-me"]).toBeUndefined();
  });

  it("revalidates CONNECT and pins the tunnel to the validated IP", async () => {
    const target = net.createServer((socket) => socket.pipe(socket));
    const targetPort = await listen(target);
    const resolve = vi.fn(async () => [{ address: "1.1.1.1", family: 4 as const }]);
    const connect = vi.fn(() => net.connect({ host: "127.0.0.1", port: targetPort }));
    const proxy = createEgressProxy({ resolve, connect, allowedPorts: new Set([443]) });
    const proxyPort = await listen(proxy);
    const client = net.connect({ host: "127.0.0.1", port: proxyPort });
    client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");

    let received = "";
    await new Promise<void>((resolveResult, reject) => {
      client.on("data", (chunk) => {
        received += chunk.toString("utf8");
        if (received.includes("200 Connection Established") && !received.includes("tunnel-payload")) {
          client.write("tunnel-payload");
        }
        if (received.includes("tunnel-payload")) resolveResult();
      });
      client.once("error", reject);
    });
    client.destroy();

    expect(resolve).toHaveBeenCalledWith("example.com");
    expect(connect).toHaveBeenCalledWith({ address: "1.1.1.1", family: 4 }, 443);
  });

  it("does not follow redirects and revalidates every client-followed hop", async () => {
    const target = http.createServer((request, response) => {
      if (request.headers.host === "first.example") {
        response.writeHead(302, { location: "http://second.example/final" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("second-hop");
    });
    const targetPort = await listen(target);
    const resolve = vi.fn(async (hostname: string) => [{
      address: hostname === "first.example" ? "1.1.1.1" : "8.8.8.8",
      family: 4 as const,
    }]);
    const connect = vi.fn(() => net.connect({ host: "127.0.0.1", port: targetPort }));
    const proxy = createEgressProxy({ resolve, connect, allowedPorts: new Set([80]) });
    const proxyPort = await listen(proxy);

    const requestThroughProxy = (url: string) => new Promise<{ body: string; location?: string; status: number }>((resolveResult, reject) => {
      const request = http.request({ host: "127.0.0.1", port: proxyPort, path: url });
      request.once("error", reject);
      request.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolveResult({
          body: Buffer.concat(chunks).toString("utf8"),
          ...(typeof response.headers.location === "string" ? { location: response.headers.location } : {}),
          status: response.statusCode ?? 0,
        }));
      });
      request.end();
    });

    const first = await requestThroughProxy("http://first.example/start");
    expect(first).toEqual({ body: "", location: "http://second.example/final", status: 302 });
    expect(resolve).toHaveBeenCalledTimes(1);
    const second = await requestThroughProxy(first.location!);
    expect(second).toEqual({ body: "second-hop", status: 200 });
    expect(resolve).toHaveBeenNthCalledWith(1, "first.example");
    expect(resolve).toHaveBeenNthCalledWith(2, "second.example");
    expect(connect).toHaveBeenNthCalledWith(1, { address: "1.1.1.1", family: 4 }, 80);
    expect(connect).toHaveBeenNthCalledWith(2, { address: "8.8.8.8", family: 4 }, 80);
  });

  it("returns a generic denial without connecting for private DNS", async () => {
    const connect = vi.fn(() => {
      throw new Error("must not connect");
    });
    const proxy = createEgressProxy({
      resolve: async () => [{ address: "169.254.169.254", family: 4 }],
      connect,
      allowedPorts: new Set([80]),
    });
    const proxyPort = await listen(proxy);
    const response = await new Promise<{ body: string; status: number }>((resolveResult, reject) => {
      const request = http.request({ host: "127.0.0.1", port: proxyPort, path: "http://example.com/private" });
      request.once("error", reject);
      request.once("response", (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => resolveResult({
          body: Buffer.concat(chunks).toString("utf8"),
          status: incoming.statusCode ?? 0,
        }));
      });
      request.end();
    });
    expect(response.status).toBe(403);
    expect(response.body).toBe("egress target rejected\n");
    expect(connect).not.toHaveBeenCalled();
  });

  it("allows one exact configured private HTTP origin without weakening other targets", async () => {
    const target = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("test-only-ok");
    });
    const targetPort = await listen(target);
    const connect = vi.fn(() => net.connect({ host: "127.0.0.1", port: targetPort }));
    const proxy = createEgressProxy({
      resolve: async () => [{ address: "172.20.0.8", family: 4 }],
      connect,
      allowedPorts: new Set([80, 443]),
      privateProviderOrigin: { hostname: "cliproxy-e2e-upstream", port: 18080 },
    });
    const proxyPort = await listen(proxy);
    const exact = await new Promise<{ body: string; status: number }>((resolveResult, reject) => {
      const request = http.request({ host: "127.0.0.1", port: proxyPort, path: "http://cliproxy-e2e-upstream:18080/v1/models" });
      request.once("error", reject);
      request.once("response", (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => resolveResult({ body: Buffer.concat(chunks).toString("utf8"), status: incoming.statusCode ?? 0 }));
      });
      request.end();
    });
    expect(exact).toEqual({ body: "test-only-ok", status: 200 });
    expect(connect).toHaveBeenCalledTimes(1);

    const denied = await new Promise<number>((resolveResult, reject) => {
      const request = http.request({ host: "127.0.0.1", port: proxyPort, path: "http://other-private:18080/v1/models" });
      request.once("error", reject);
      request.once("response", (incoming) => {
        incoming.resume();
        incoming.once("end", () => resolveResult(incoming.statusCode ?? 0));
      });
      request.end();
    });
    expect(denied).toBe(403);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("fails closed when request header bounds are exceeded", async () => {
    const connect = vi.fn(() => {
      throw new Error("must not connect");
    });
    const proxy = createEgressProxy({
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      connect,
      allowedPorts: new Set([80]),
      headerCount: 1,
    });
    const proxyPort = await listen(proxy);
    const response = await new Promise<number>((resolveResult, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        path: "http://example.com/test",
        headers: { "x-extra": "bounded" },
      });
      request.once("error", reject);
      request.once("response", (incoming) => {
        incoming.resume();
        incoming.once("end", () => resolveResult(incoming.statusCode ?? 0));
      });
      request.end();
    });
    expect(response).toBe(403);
    expect(connect).not.toHaveBeenCalled();
  });

  it("bounds DNS resolution and never attempts a connection after timeout", async () => {
    const connect = vi.fn(() => {
      throw new Error("must not connect");
    });
    const proxy = createEgressProxy({
      resolve: () => new Promise(() => undefined),
      connect,
      allowedPorts: new Set([80]),
      dnsTimeoutMs: 20,
    });
    const proxyPort = await listen(proxy);
    const status = await new Promise<number>((resolveResult, reject) => {
      const request = http.request({ host: "127.0.0.1", port: proxyPort, path: "http://example.com/dns-timeout" });
      request.once("error", reject);
      request.once("response", (response) => {
        response.resume();
        response.once("end", () => resolveResult(response.statusCode ?? 0));
      });
      request.end();
    });
    expect(status).toBe(403);
    expect(connect).not.toHaveBeenCalled();
  });

  it("bounds total upstream time and returns only a generic failure", async () => {
    const acceptedSockets: net.Socket[] = [];
    const target = net.createServer((socket) => acceptedSockets.push(socket));
    const targetPort = await listen(target);
    const proxy = createEgressProxy({
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      connect: () => net.connect({ host: "127.0.0.1", port: targetPort }),
      allowedPorts: new Set([80]),
      idleTimeoutMs: 1_000,
      requestTimeoutMs: 30,
    });
    const proxyPort = await listen(proxy);
    const result = await new Promise<{ body: string; status: number }>((resolveResult, reject) => {
      const request = http.request({ host: "127.0.0.1", port: proxyPort, path: "http://example.com/slow" });
      request.once("error", reject);
      request.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolveResult({ body: Buffer.concat(chunks).toString("utf8"), status: response.statusCode ?? 0 }));
      });
      request.end();
    });
    for (const socket of acceptedSockets) socket.destroy();
    expect(result).toEqual({ body: "egress proxy failure\n", status: 502 });
  });

  it("propagates client abort to the pinned upstream socket", async () => {
    const acceptedSockets: net.Socket[] = [];
    const target = net.createServer((socket) => acceptedSockets.push(socket));
    const targetPort = await listen(target);
    let upstreamSocket: net.Socket | undefined;
    const proxy = createEgressProxy({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      connect: () => {
        upstreamSocket = net.connect({ host: "127.0.0.1", port: targetPort });
        return upstreamSocket;
      },
      allowedPorts: new Set([80]),
    });
    const proxyPort = await listen(proxy);
    const request = http.request({ host: "127.0.0.1", port: proxyPort, path: "http://example.com/abort" });
    request.on("error", () => undefined);
    request.end();
    for (let attempt = 0; attempt < 50 && !upstreamSocket; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(upstreamSocket).toBeDefined();
    request.destroy();
    if (upstreamSocket && !upstreamSocket.destroyed) await once(upstreamSocket, "close");
    expect(upstreamSocket?.destroyed).toBe(true);
    for (const socket of acceptedSockets) socket.destroy();
  });

  it("streams a backpressured request body without truncation", async () => {
    let receivedBytes = 0;
    const target = http.createServer((request, response) => {
      request.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        request.pause();
        setTimeout(() => request.resume(), 1);
      });
      request.on("end", () => {
        response.writeHead(204);
        response.end();
      });
    });
    const targetPort = await listen(target);
    const proxy = createEgressProxy({
      resolve: async () => [{ address: "1.1.1.1", family: 4 }],
      connect: () => net.connect({ host: "127.0.0.1", port: targetPort }),
      allowedPorts: new Set([80]),
    });
    const proxyPort = await listen(proxy);
    const body = Buffer.alloc(1024 * 1024, 0x61);
    const status = await new Promise<number>((resolveResult, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        method: "POST",
        path: "http://example.com/upload",
        headers: { "content-length": String(body.length) },
      });
      request.once("error", reject);
      request.once("response", (response) => {
        response.resume();
        response.once("end", () => resolveResult(response.statusCode ?? 0));
      });
      request.end(body);
    });
    expect(status).toBe(204);
    expect(receivedBytes).toBe(body.length);
  });
});
