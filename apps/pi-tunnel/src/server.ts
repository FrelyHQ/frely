import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { readBoundedRequestText } from "@frely/core";
import {
  PI_TUNNEL_ACTIVATION_PATH,
  PI_TUNNEL_CLIENT_PATH,
  PI_TUNNEL_NODE_PATH,
  PI_TUNNEL_PROTOCOL,
  PiTunnelDeviceService,
  PiTunnelDomainError,
  randomChallenge,
  verifyActivationProof,
  verifyClientConnectProof,
  verifyNodeConnectProof,
  type PiTunnelDeviceRepository,
} from "@frely/pi-tunnel";
import { OpaqueForwardQueue } from "./backpressure.js";
import { defaultPiTunnelLogger, PiTunnelMetrics, type PiTunnelLogger, type PiTunnelRole } from "./observability.js";

export interface PiTunnelServerOptions {
  readonly host: string;
  readonly port: number;
  readonly maxControlBytes: number;
  readonly maxFrameBytes: number;
  readonly bufferedHighWaterBytes: number;
  readonly bufferedAbsoluteBytes: number;
  readonly maxQueuedFrames: number;
  readonly handshakeTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly idleTimeoutMs: number;
  readonly hardLifetimeMs: number;
  readonly nodeRevocationPollMs: number;
  readonly activationRateLimitPerMinute: number;
  readonly maxConnections: number;
}

export interface PiTunnelServerDependencies {
  readonly repository: PiTunnelDeviceRepository;
  readonly logger?: PiTunnelLogger;
  readonly now?: () => Date;
  readonly metrics?: PiTunnelMetrics;
}

type Phase = "handshake" | "authorizing" | "ready" | "paired";

interface BaseState {
  readonly role: "node" | "client";
  phase: Phase;
  readonly challenge: string;
  readonly bornAt: number;
  lastActivityAt: number;
  alive: boolean;
  processing: boolean;
  handshakeTimer: ReturnType<typeof setTimeout>;
}

interface NodeState extends BaseState {
  readonly role: "node";
  nodeId: string | null;
  client: WebSocket | null;
  pendingAuthorization: { requestId: string; client: WebSocket } | null;
  toClient: OpaqueForwardQueue | null;
}

interface ClientState extends BaseState {
  readonly role: "client";
  nodeId: string | null;
  node: WebSocket | null;
  toNode: OpaqueForwardQueue | null;
}

type ConnectionState = NodeState | ClientState;

export interface PiTunnelServerRuntime {
  readonly server: HttpServer;
  readonly metrics: PiTunnelMetrics;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createPiTunnelServer(options: PiTunnelServerOptions, dependencies: PiTunnelServerDependencies): PiTunnelServerRuntime {
  validateRuntimeOptions(options);
  const repository = dependencies.repository;
  const devices = new PiTunnelDeviceService(repository);
  const logger = dependencies.logger ?? defaultPiTunnelLogger;
  const now = dependencies.now ?? (() => new Date());
  const metrics = dependencies.metrics ?? new PiTunnelMetrics();
  const states = new Map<WebSocket, ConnectionState>();
  const nodes = new Map<string, WebSocket>();
  const activationLimiter = new FixedWindowRateLimiter(options.activationRateLimitPerMinute, 60_000);
  let revocationPollInFlight = false;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxFrameBytes,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has(PI_TUNNEL_PROTOCOL) ? PI_TUNNEL_PROTOCOL : false;
    },
  });

  const server = createServer(async (request, response) => {
    const url = safeRequestUrl(request);
    if (request.method === "GET" && url?.pathname === "/health") {
      response.writeHead(200, noStoreHeaders({ "content-type": "application/json" }));
      response.end(JSON.stringify({ ok: true, service: "pi-tunnel", mode: "single-instance" }));
      return;
    }
    if (request.method === "POST" && url?.pathname === PI_TUNNEL_ACTIVATION_PATH) {
      await handleActivation(request, response);
      return;
    }
    response.writeHead(404, noStoreHeaders());
    response.end();
  });

  server.on("upgrade", (request, socket, head) => {
    const url = safeRequestUrl(request);
    const role = url?.pathname === PI_TUNNEL_NODE_PATH ? "node" : url?.pathname === PI_TUNNEL_CLIENT_PATH ? "client" : null;
    if (!role || request.method !== "GET" || !hasExactProtocol(request)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");
      socket.destroy();
      metrics.increment("protocolRejections");
      return;
    }
    if (wss.clients.size >= options.maxConnections) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nRetry-After: 1\r\n\r\n");
      socket.destroy();
      metrics.increment("connectionRejections");
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => accept(webSocket, role));
  });

  const lifecycleTimer = setInterval(() => {
    const at = now().getTime();
    for (const [socket, state] of states) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (at - state.bornAt >= options.hardLifetimeMs) {
        safeClose(socket, 4412, "hard_lifetime");
        continue;
      }
      if (at - state.lastActivityAt >= options.idleTimeoutMs) {
        safeClose(socket, 4411, "idle_timeout");
        continue;
      }
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, options.heartbeatIntervalMs);
  lifecycleTimer.unref?.();

  const revocationTimer = setInterval(() => {
    void pollRevocations();
  }, options.nodeRevocationPollMs);
  revocationTimer.unref?.();

  async function handleActivation(request: IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    if (!activationLimiter.take(now().getTime())) {
      metrics.increment("activationDenied");
      safeLog(logger, { role: "activation", action: "reject", result: "denied", errorCode: "rate_limited" });
      response.writeHead(429, noStoreHeaders({ "content-type": "application/json", "retry-after": "60" }));
      response.end(JSON.stringify({ error: { code: "activation_rejected" } }));
      return;
    }
    try {
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        throw new PiTunnelDomainError("activation_rejected");
      }
      const webRequest = toWebRequest(request);
      const raw = await readBoundedRequestText(webRequest, options.maxControlBytes * 2);
      const payload = parseActivationRequest(JSON.parse(raw) as unknown);
      const identity = verifyActivationProof({ ...payload, now: now() });
      const activated = await devices.activate({
        activationId: payload.activationId,
        activationCode: payload.activationCode,
        identity,
        now: now(),
      });
      metrics.increment("activationAllowed");
      safeLog(logger, { role: "activation", action: "activate", result: "success" });
      response.writeHead(200, noStoreHeaders({ "content-type": "application/json" }));
      response.end(JSON.stringify({ nodeId: activated.nodeId, keyThumbprint: activated.nodeKeyThumbprint, protocol: PI_TUNNEL_PROTOCOL }));
    } catch {
      metrics.increment("activationDenied");
      safeLog(logger, { role: "activation", action: "activate", result: "denied", errorCode: "activation_rejected" });
      response.writeHead(400, noStoreHeaders({ "content-type": "application/json" }));
      response.end(JSON.stringify({ error: { code: "activation_rejected" } }));
    }
  }

  function accept(socket: WebSocket, role: "node" | "client"): void {
    const at = now().getTime();
    const state: ConnectionState = role === "node"
      ? {
          role,
          phase: "handshake",
          challenge: randomChallenge(),
          bornAt: at,
          lastActivityAt: at,
          alive: true,
          processing: false,
          nodeId: null,
          client: null,
          pendingAuthorization: null,
          toClient: null,
          handshakeTimer: setTimeout(() => safeClose(socket, 4411, "handshake_timeout"), options.handshakeTimeoutMs),
        }
      : {
          role,
          phase: "handshake",
          challenge: randomChallenge(),
          bornAt: at,
          lastActivityAt: at,
          alive: true,
          processing: false,
          nodeId: null,
          node: null,
          toNode: null,
          handshakeTimer: setTimeout(() => safeClose(socket, 4411, "handshake_timeout"), options.handshakeTimeoutMs),
        };
    state.handshakeTimer.unref?.();
    states.set(socket, state);
    sendControl(socket, { type: "challenge", role, protocol: PI_TUNNEL_PROTOCOL, nonce: state.challenge });
    socket.on("pong", () => {
      state.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      state.lastActivityAt = now().getTime();
      state.alive = true;
      void handleMessage(socket, state, data, isBinary);
    });
    socket.on("error", () => undefined);
    socket.on("close", (code) => cleanup(socket, state, code));
  }

  async function handleMessage(socket: WebSocket, state: ConnectionState, data: RawData, isBinary: boolean): Promise<void> {
    if (state.phase === "paired") {
      if (!isBinary) {
        reject(socket, state.role, 4400, "text_frame_forbidden");
        return;
      }
      if (byteLength(data) > options.maxFrameBytes) {
        reject(socket, state.role, 1009, "frame_too_large");
        return;
      }
      const queue = state.role === "node" ? state.toClient : state.toNode;
      if (!queue?.forward(data)) {
        if (state.role === "node") {
          if (state.client?.readyState === WebSocket.OPEN) safeClose(state.client, 4408, "backpressure_limit");
          return;
        }
        safeClose(socket, 4408, "backpressure_limit");
      }
      return;
    }
    if (isBinary) {
      if (state.role === "node" && (state.phase === "ready" || state.phase === "authorizing")) return;
      reject(socket, state.role, 4400, "control_frame_invalid");
      return;
    }
    if (state.processing) {
      reject(socket, state.role, 4400, "concurrent_control");
      return;
    }
    if (byteLength(data) > options.maxControlBytes) {
      reject(socket, state.role, 4400, "control_frame_invalid");
      return;
    }
    state.processing = true;
    try {
      const parsed = JSON.parse(rawDataText(data)) as unknown;
      if (state.role === "node") await handleNodeControl(socket, state, parsed);
      else await handleClientControl(socket, state, parsed);
    } catch {
      reject(socket, state.role, 4401, "authentication_rejected");
    } finally {
      state.processing = false;
    }
  }

  async function handleNodeControl(socket: WebSocket, state: NodeState, payload: unknown): Promise<void> {
    if (state.phase === "handshake") {
      const message = parseNodeAuth(payload);
      const identity = verifyNodeConnectProof({ challenge: state.challenge, ...message });
      const device = await repository.findActiveByNodeId(identity.nodeId);
      if (states.get(socket) !== state || state.phase !== "handshake" || socket.readyState !== WebSocket.OPEN) return;
      if (!device || device.nodePublicKeySpki !== identity.publicKeySpki || device.nodeKeyThumbprint !== identity.keyThumbprint) {
        throw new PiTunnelDomainError("node_auth_rejected");
      }
      if (nodes.has(identity.nodeId)) {
        reject(socket, "node", 4409, "node_already_connected");
        return;
      }
      clearTimeout(state.handshakeTimer);
      state.nodeId = identity.nodeId;
      state.phase = "ready";
      nodes.set(identity.nodeId, socket);
      metrics.increment("nodeConnections");
      safeLog(logger, { role: "node", action: "connect", result: "success" });
      sendControl(socket, { type: "ready", role: "node", protocol: PI_TUNNEL_PROTOCOL });
      return;
    }
    const message = parseAuthorizationResult(payload);
    if (state.phase === "ready") return;
    if (state.phase === "authorizing") {
      const pending = state.pendingAuthorization;
      if (!pending || pending.requestId !== message.requestId) return;
      state.pendingAuthorization = null;
      state.phase = "ready";
      const clientState = states.get(pending.client);
      if (!clientState || clientState.role !== "client" || clientState.phase !== "authorizing") return;
      if (!message.allow) {
        metrics.increment("authorizationDenied");
        safeLog(logger, { role: "client", action: "authorize", result: "denied" });
        safeClose(pending.client, 4403, "client_denied");
        return;
      }
      pair(socket, state, pending.client, clientState);
      return;
    }
    throw new PiTunnelDomainError("node_control_invalid");
  }

  async function handleClientControl(socket: WebSocket, state: ClientState, payload: unknown): Promise<void> {
    if (state.phase !== "handshake") throw new PiTunnelDomainError("client_control_invalid");
    const message = parseClientAuth(payload);
    const clientIdentity = verifyClientConnectProof({ challenge: state.challenge, ...message });
    const nodeSocket = nodes.get(message.nodeId);
    const nodeState = nodeSocket ? states.get(nodeSocket) : null;
    if (!nodeSocket || !nodeState || nodeState.role !== "node" || nodeState.phase !== "ready" || nodeState.client || nodeState.pendingAuthorization) {
      reject(socket, "client", 4404, "node_unavailable");
      return;
    }
    clearTimeout(state.handshakeTimer);
    state.phase = "authorizing";
    state.nodeId = message.nodeId;
    state.node = nodeSocket;
    const requestId = randomBytes(16).toString("base64url");
    nodeState.phase = "authorizing";
    nodeState.pendingAuthorization = { requestId, client: socket };
    state.handshakeTimer = setTimeout(() => {
      if (state.phase === "authorizing" && nodeState.pendingAuthorization?.requestId === requestId) {
        nodeState.pendingAuthorization = null;
        nodeState.phase = "ready";
        state.node = null;
      }
      safeClose(socket, 4411, "authorization_timeout", 1_000);
    }, options.handshakeTimeoutMs);
    state.handshakeTimer.unref?.();
    sendControl(nodeSocket, {
      type: "authorizeClient",
      requestId,
      clientPublicKeySpki: clientIdentity.clientPublicKeySpki,
      clientKeyThumbprint: clientIdentity.clientKeyThumbprint,
    });
  }

  function pair(nodeSocket: WebSocket, nodeState: NodeState, clientSocket: WebSocket, clientState: ClientState): void {
    clearTimeout(clientState.handshakeTimer);
    if (nodeSocket.readyState !== WebSocket.OPEN || clientSocket.readyState !== WebSocket.OPEN) {
      safeClose(clientSocket, 4410, "connection_unavailable");
      return;
    }
    nodeState.phase = "paired";
    nodeState.client = clientSocket;
    clientState.phase = "paired";
    clientState.node = nodeSocket;
    const overflowClient = () => {
      metrics.increment("backpressureRejections");
      safeClose(clientSocket, 4408, "backpressure_limit");
    };
    nodeState.toClient = new OpaqueForwardQueue(clientSocket, {
      highWaterBytes: options.bufferedHighWaterBytes,
      absoluteBytes: options.bufferedAbsoluteBytes,
      maxQueuedFrames: options.maxQueuedFrames,
      metrics,
      onOverflow: overflowClient,
    });
    clientState.toNode = new OpaqueForwardQueue(nodeSocket, {
      highWaterBytes: options.bufferedHighWaterBytes,
      absoluteBytes: options.bufferedAbsoluteBytes,
      maxQueuedFrames: options.maxQueuedFrames,
      metrics,
      onOverflow: overflowClient,
    });
    metrics.increment("clientConnections");
    metrics.increment("authorizationAllowed");
    safeLog(logger, { role: "client", action: "authorize", result: "allowed" });
    sendControl(clientSocket, { type: "ready", role: "client", protocol: PI_TUNNEL_PROTOCOL });
    sendControl(nodeSocket, { type: "clientConnected" });
  }

  function cleanup(socket: WebSocket, state: ConnectionState, closeCode: number): void {
    clearTimeout(state.handshakeTimer);
    states.delete(socket);
    if (state.role === "client") {
      state.toNode?.clear();
      const nodeState = state.node ? states.get(state.node) : null;
      if (nodeState?.role === "node") {
        if (nodeState.client === socket) {
          nodeState.toClient?.clear();
          nodeState.toClient = null;
          nodeState.client = null;
          nodeState.phase = "ready";
          sendControl(state.node!, { type: "clientDisconnected" });
        }
        if (nodeState.pendingAuthorization?.client === socket) {
          nodeState.pendingAuthorization = null;
          nodeState.phase = "ready";
        }
      }
    } else {
      state.toClient?.clear();
      if (state.nodeId && nodes.get(state.nodeId) === socket) nodes.delete(state.nodeId);
      if (state.client?.readyState === WebSocket.OPEN) safeClose(state.client, 4410, "node_disconnected");
      if (state.pendingAuthorization?.client.readyState === WebSocket.OPEN) safeClose(state.pendingAuthorization.client, 4410, "node_disconnected");
    }
    safeLog(logger, { role: state.role, action: "close", result: "success", closeCode });
  }

  async function pollRevocations(): Promise<void> {
    if (revocationPollInFlight) return;
    revocationPollInFlight = true;
    const snapshot = [...nodes.entries()];
    try {
      const activeNodeIds = await repository.findActiveNodeIds(snapshot.map(([nodeId]) => nodeId));
      for (const [nodeId, socket] of snapshot) {
        if (nodes.get(nodeId) === socket && !activeNodeIds.has(nodeId)) safeClose(socket, 4410, "node_revoked");
      }
    } catch {
      for (const [nodeId, socket] of snapshot) {
        if (nodes.get(nodeId) === socket) safeClose(socket, 4410, "revocation_check_failed");
      }
    } finally {
      revocationPollInFlight = false;
    }
  }

  return {
    server,
    metrics,
    listen: () => new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(options.port, options.host, () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("pi_tunnel_listen_address_invalid"));
        safeLog(logger, { role: "service", action: "listen", result: "success" });
        resolve({ host: options.host, port: address.port });
      });
    }),
    close: async () => {
      clearInterval(lifecycleTimer);
      clearInterval(revocationTimer);
      for (const socket of states.keys()) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      wss.close();
    },
  };
}

function parseActivationRequest(value: unknown) {
  const record = exactRecord(value, ["activationCode", "activationId", "issuedAt", "nonce", "publicKeySpki", "signature"]);
  return {
    activationId: boundedString(record.activationId, 128),
    activationCode: boundedString(record.activationCode, 128),
    publicKeySpki: boundedString(record.publicKeySpki, 128),
    nonce: boundedString(record.nonce, 128),
    issuedAt: boundedString(record.issuedAt, 64),
    signature: boundedString(record.signature, 128),
  };
}

function parseNodeAuth(value: unknown) {
  const record = exactRecord(value, ["nodeId", "protocol", "publicKeySpki", "signature", "type"]);
  if (record.type !== "nodeAuth") throw new PiTunnelDomainError("node_auth_rejected");
  return {
    nodeId: boundedString(record.nodeId, 64),
    protocol: exactProtocol(record.protocol),
    publicKeySpki: boundedString(record.publicKeySpki, 128),
    signature: boundedString(record.signature, 128),
  };
}

function parseClientAuth(value: unknown) {
  const record = exactRecord(value, ["clientPublicKeySpki", "nodeId", "protocol", "signature", "type"]);
  if (record.type !== "clientAuth") throw new PiTunnelDomainError("client_auth_rejected");
  return {
    nodeId: boundedString(record.nodeId, 64),
    protocol: exactProtocol(record.protocol),
    clientPublicKeySpki: boundedString(record.clientPublicKeySpki, 128),
    signature: boundedString(record.signature, 128),
  };
}

function parseAuthorizationResult(value: unknown): { requestId: string; allow: boolean } {
  const record = exactRecord(value, ["allow", "requestId", "type"]);
  if (record.type !== "authorizeClientResult" || typeof record.allow !== "boolean") {
    throw new PiTunnelDomainError("authorization_response_invalid");
  }
  return { requestId: boundedString(record.requestId, 64), allow: record.allow };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PiTunnelDomainError("control_invalid");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PiTunnelDomainError("control_invalid");
  }
  return record;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\n")) {
    throw new PiTunnelDomainError("control_invalid");
  }
  return value;
}

function exactProtocol(value: unknown): typeof PI_TUNNEL_PROTOCOL {
  if (value !== PI_TUNNEL_PROTOCOL) throw new PiTunnelDomainError("protocol_unsupported");
  return PI_TUNNEL_PROTOCOL;
}

function sendControl(socket: WebSocket, value: object): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(value));
}

function reject(socket: WebSocket, role: PiTunnelRole, closeCode: number, errorCode: string): void {
  safeClose(socket, closeCode, errorCode);
  void role;
}

function safeClose(socket: WebSocket, code: number, reason: string, terminateAfterMs?: number): void {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  socket.close(code, reason.slice(0, 123));
  if (terminateAfterMs === undefined) return;
  const timer = setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, terminateAfterMs);
  timer.unref?.();
  socket.once("close", () => clearTimeout(timer));
}

function safeLog(logger: PiTunnelLogger, input: Omit<Parameters<PiTunnelLogger>[0], "event">): void {
  logger({ event: "pi_tunnel.lifecycle", ...input });
}

function hasExactProtocol(request: IncomingMessage): boolean {
  const raw = request.headers["sec-websocket-protocol"];
  return typeof raw === "string" && raw === PI_TUNNEL_PROTOCOL;
}

function safeRequestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", "http://pi-tunnel.invalid");
  } catch {
    return null;
  }
}

function noStoreHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra };
}

function toWebRequest(message: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(","));
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(`http://pi-tunnel.invalid${message.url ?? "/"}`, {
    method: message.method,
    headers,
    body: message as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

function byteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.reduce((total, item) => total + item.byteLength, 0);
}

function validateRuntimeOptions(options: PiTunnelServerOptions): void {
  const positive = [
    options.maxControlBytes,
    options.maxFrameBytes,
    options.bufferedHighWaterBytes,
    options.bufferedAbsoluteBytes,
    options.maxQueuedFrames,
    options.handshakeTimeoutMs,
    options.heartbeatIntervalMs,
    options.idleTimeoutMs,
    options.hardLifetimeMs,
    options.nodeRevocationPollMs,
    options.activationRateLimitPerMinute,
    options.maxConnections,
  ];
  if (positive.some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("pi_tunnel_runtime_options_invalid");
  if (options.host !== "127.0.0.1" && options.host !== "::1") throw new Error("pi_tunnel_loopback_host_required");
  if (options.bufferedHighWaterBytes < options.maxFrameBytes || options.bufferedAbsoluteBytes <= options.bufferedHighWaterBytes) {
    throw new Error("pi_tunnel_backpressure_options_invalid");
  }
}

class FixedWindowRateLimiter {
  private windowStartedAt = 0;
  private count = 0;

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  take(now: number): boolean {
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }
}
