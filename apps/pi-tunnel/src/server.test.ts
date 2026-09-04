import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import WebSocket from "ws";
import { afterEach, describe, expect, test } from "vitest";
import {
  PI_TUNNEL_ACTIVATION_PATH,
  PI_TUNNEL_CLIENT_PATH,
  PI_TUNNEL_NODE_PATH,
  PI_TUNNEL_PROTOCOL,
  PiTunnelDomainError,
  activationCodeMatches,
  activationProofBytes,
  clientConnectProofBytes,
  deriveNodeIdentity,
  hashActivationCode,
  nodeConnectProofBytes,
  type ConsumeActivationInput,
  type PiTunnelDevice,
  type PiTunnelDeviceRepository,
  type PiTunnelRevocationReason,
} from "@frely/pi-tunnel";
import { createPiTunnelServer, type PiTunnelServerRuntime } from "./server.js";
import type { PiTunnelSafeLog } from "./observability.js";

class TestRepository implements PiTunnelDeviceRepository {
  readonly rows = new Map<string, PiTunnelDevice>();
  nodeLookupDelayMs = 0;
  activeLookupDelayMs = 0;
  activeLookupCalls = 0;
  activeLookupInFlight = 0;
  maxActiveLookupInFlight = 0;

  async createPending(input: {
    id: string;
    activationCodeHash: string;
    activationExpiresAt: string;
    activationAttemptsRemaining: number;
    createdAt: string;
  }): Promise<PiTunnelDevice> {
    const row: PiTunnelDevice = {
      id: input.id,
      lifecycle: "pending",
      activationCodeHash: input.activationCodeHash,
      activationExpiresAt: input.activationExpiresAt,
      activationAttemptsRemaining: input.activationAttemptsRemaining,
      nodeId: null,
      nodePublicKeySpki: null,
      nodeKeyThumbprint: null,
      activatedAt: null,
      revokedAt: null,
      revocationReason: null,
      createdAt: input.createdAt,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async inspect(id: string): Promise<PiTunnelDevice | null> {
    return this.rows.get(id) ?? null;
  }

  async consumeActivation(input: ConsumeActivationInput): Promise<PiTunnelDevice> {
    const row = this.rows.get(input.activationId);
    if (!row || row.lifecycle !== "pending" || row.activationExpiresAt <= input.activatedAt || row.activationAttemptsRemaining < 1) {
      throw new PiTunnelDomainError("activation_rejected");
    }
    if (!activationCodeMatches(row.activationCodeHash, input.activationCode)) {
      this.rows.set(row.id, { ...row, activationAttemptsRemaining: row.activationAttemptsRemaining - 1 });
      throw new PiTunnelDomainError("activation_rejected");
    }
    const active: PiTunnelDevice = {
      ...row,
      lifecycle: "active",
      nodeId: input.nodeId,
      nodePublicKeySpki: input.publicKeySpki,
      nodeKeyThumbprint: input.keyThumbprint,
      activatedAt: input.activatedAt,
    };
    this.rows.set(row.id, active);
    return active;
  }

  async revoke(id: string, reason: PiTunnelRevocationReason, revokedAt: string): Promise<PiTunnelDevice> {
    const row = this.rows.get(id);
    if (!row) throw new PiTunnelDomainError("device_not_found");
    const revoked = { ...row, lifecycle: "revoked" as const, reason, revokedAt, revocationReason: reason };
    this.rows.set(id, revoked);
    return revoked;
  }

  async findActiveByNodeId(nodeId: string): Promise<PiTunnelDevice | null> {
    if (this.nodeLookupDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.nodeLookupDelayMs));
    return [...this.rows.values()].find((row) => row.lifecycle === "active" && row.nodeId === nodeId) ?? null;
  }

  async findActiveNodeIds(nodeIds: readonly string[]): Promise<ReadonlySet<string>> {
    this.activeLookupCalls += 1;
    this.activeLookupInFlight += 1;
    this.maxActiveLookupInFlight = Math.max(this.maxActiveLookupInFlight, this.activeLookupInFlight);
    try {
      if (this.activeLookupDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.activeLookupDelayMs));
      const requested = new Set(nodeIds);
      return new Set([...this.rows.values()].flatMap((row) => row.lifecycle === "active" && row.nodeId && requested.has(row.nodeId) ? [row.nodeId] : []));
    } finally {
      this.activeLookupInFlight -= 1;
    }
  }

  addActive(identity: ReturnType<typeof deriveNodeIdentity>, id = `pi_device_${randomBytes(16).toString("hex")}`): void {
    this.rows.set(id, {
      id,
      lifecycle: "active",
      activationCodeHash: hashActivationCode(randomBytes(32).toString("base64url")),
      activationExpiresAt: "2099-01-01T00:00:00.000Z",
      activationAttemptsRemaining: 5,
      nodeId: identity.nodeId,
      nodePublicKeySpki: identity.publicKeySpki,
      nodeKeyThumbprint: identity.keyThumbprint,
      activatedAt: "2026-08-25T00:00:00.000Z",
      revokedAt: null,
      revocationReason: null,
      createdAt: "2026-08-25T00:00:00.000Z",
    });
  }
}

interface KeyFixture {
  readonly privateKey: KeyObject;
  readonly publicKeySpki: string;
}

function keyFixture(): KeyFixture {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    publicKeySpki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

class Harness {
  private readonly messages: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
  private readonly waiters: Array<(message: { data: WebSocket.RawData; binary: boolean }) => void> = [];
  readonly opened: Promise<void>;

  constructor(readonly socket: WebSocket) {
    this.opened = new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("message", (data, binary) => {
      const message = { data, binary };
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
  }

  async nextJson(): Promise<Record<string, unknown>> {
    const message = await this.next();
    expect(message.binary).toBe(false);
    return JSON.parse(Buffer.from(message.data as Buffer).toString("utf8")) as Record<string, unknown>;
  }

  async nextBinary(): Promise<Buffer> {
    const message = await this.next();
    expect(message.binary).toBe(true);
    return Buffer.from(message.data as Buffer);
  }

  closeEvent(): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => this.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") })));
  }

  private next(): Promise<{ data: WebSocket.RawData; binary: boolean }> {
    const existing = this.messages.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket_message_timeout")), 2_000);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}

const runtimes: PiTunnelServerRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

async function start(repository: TestRepository, logs: PiTunnelSafeLog[] = [], overrides: Partial<Parameters<typeof createPiTunnelServer>[0]> = {}) {
  const runtime = createPiTunnelServer({
    host: "127.0.0.1",
    port: 0,
    maxControlBytes: 8_192,
    maxFrameBytes: 1_024,
    bufferedHighWaterBytes: 2_048,
    bufferedAbsoluteBytes: 8_192,
    maxQueuedFrames: 128,
    handshakeTimeoutMs: 200,
    heartbeatIntervalMs: 1_000,
    idleTimeoutMs: 5_000,
    hardLifetimeMs: 60_000,
    nodeRevocationPollMs: 1_000,
    activationRateLimitPerMinute: 10,
    maxConnections: 1_024,
    ...overrides,
  }, { repository, logger: (entry) => logs.push(entry) });
  runtimes.push(runtime);
  const address = await runtime.listen();
  return { runtime, baseHttp: `http://127.0.0.1:${address.port}`, baseWs: `ws://127.0.0.1:${address.port}` };
}

async function connectNode(baseWs: string, key: KeyFixture) {
  const identity = deriveNodeIdentity(key.publicKeySpki);
  const harness = new Harness(new WebSocket(`${baseWs}${PI_TUNNEL_NODE_PATH}`, PI_TUNNEL_PROTOCOL));
  await harness.opened;
  const challenge = await harness.nextJson();
  const nonce = String(challenge.nonce);
  harness.socket.send(JSON.stringify({
    type: "nodeAuth",
    protocol: PI_TUNNEL_PROTOCOL,
    nodeId: identity.nodeId,
    publicKeySpki: key.publicKeySpki,
    signature: sign(null, nodeConnectProofBytes({ challenge: nonce, nodeId: identity.nodeId, protocol: PI_TUNNEL_PROTOCOL }), key.privateKey).toString("base64url"),
  }));
  expect(await harness.nextJson()).toMatchObject({ type: "ready", role: "node" });
  return { harness, identity };
}

async function beginClient(baseWs: string, nodeId: string, key: KeyFixture) {
  const harness = new Harness(new WebSocket(`${baseWs}${PI_TUNNEL_CLIENT_PATH}`, PI_TUNNEL_PROTOCOL));
  await harness.opened;
  const challenge = await harness.nextJson();
  const nonce = String(challenge.nonce);
  harness.socket.send(JSON.stringify({
    type: "clientAuth",
    protocol: PI_TUNNEL_PROTOCOL,
    nodeId,
    clientPublicKeySpki: key.publicKeySpki,
    signature: sign(null, clientConnectProofBytes({ challenge: nonce, nodeId, clientPublicKeySpki: key.publicKeySpki, protocol: PI_TUNNEL_PROTOCOL }), key.privateKey).toString("base64url"),
  }));
  return harness;
}

async function rejectedUpgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, PI_TUNNEL_PROTOCOL);
    socket.once("open", () => reject(new Error("websocket_upgrade_unexpectedly_succeeded")));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("error", () => undefined);
  });
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function authorize(node: Harness, client: Harness, allow: boolean) {
  const request = await node.nextJson();
  expect(request).toMatchObject({ type: "authorizeClient" });
  node.socket.send(JSON.stringify({ type: "authorizeClientResult", requestId: request.requestId, allow }));
  if (allow) {
    expect(await client.nextJson()).toMatchObject({ type: "ready", role: "client" });
    expect(await node.nextJson()).toEqual({ type: "clientConnected" });
  }
  return request;
}

describe("minimal Pi Tunnel server", () => {
  test("activates a Node with a single-use code and derived key identity without leaking proof material", async () => {
    const repository = new TestRepository();
    const logs: PiTunnelSafeLog[] = [];
    const { runtime, baseHttp } = await start(repository, logs);
    const key = keyFixture();
    const activationId = `pi_device_${"a".repeat(32)}`;
    const activationCode = randomBytes(32).toString("base64url");
    await repository.createPending({
      id: activationId,
      activationCodeHash: hashActivationCode(activationCode),
      activationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      activationAttemptsRemaining: 3,
      createdAt: new Date().toISOString(),
    });
    const nonce = randomBytes(32).toString("base64url");
    const issuedAt = new Date().toISOString();
    const proof = { activationId, publicKeySpki: key.publicKeySpki, nonce, issuedAt };
    const signature = sign(null, activationProofBytes(proof), key.privateKey).toString("base64url");
    const response = await fetch(`${baseHttp}${PI_TUNNEL_ACTIVATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...proof, activationCode, signature }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const identity = deriveNodeIdentity(key.publicKeySpki);
    expect(await response.json()).toEqual({ nodeId: identity.nodeId, keyThumbprint: identity.keyThumbprint, protocol: PI_TUNNEL_PROTOCOL });
    const replay = await fetch(`${baseHttp}${PI_TUNNEL_ACTIVATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...proof, activationCode, signature }),
    });
    expect(replay.status).toBe(400);
    const observable = JSON.stringify({ logs, metrics: runtime.metrics.snapshot(), rows: [...repository.rows.values()] });
    expect(observable).not.toContain(activationCode);
    expect(observable).not.toContain(signature);
  });

  test("uses Node-owned Client authorization and forwards opaque binary bytes in both directions", async () => {
    const repository = new TestRepository();
    const logs: PiTunnelSafeLog[] = [];
    const { runtime, baseWs } = await start(repository, logs);
    const nodeKey = keyFixture();
    const nodeIdentity = deriveNodeIdentity(nodeKey.publicKeySpki);
    repository.addActive(nodeIdentity);
    const node = await connectNode(baseWs, nodeKey);
    const client = await beginClient(baseWs, nodeIdentity.nodeId, keyFixture());
    await authorize(node.harness, client, true);

    const clientPayload = Buffer.from("opaque-client-payload-sentinel");
    client.socket.send(clientPayload);
    expect(await node.harness.nextBinary()).toEqual(clientPayload);
    const nodePayload = randomBytes(128);
    node.harness.socket.send(nodePayload);
    expect(await client.nextBinary()).toEqual(nodePayload);
    expect(runtime.metrics.snapshot().opaque_bytes_forwarded).toBe(clientPayload.byteLength + nodePayload.byteLength);
    const observable = JSON.stringify({ logs, metrics: runtime.metrics.snapshot(), rows: [...repository.rows.values()] });
    expect(observable).not.toContain(clientPayload.toString("utf8"));
  });

  test("keeps the Node connected across a Client disconnect and stale in-flight Node frame", async () => {
    const repository = new TestRepository();
    const { baseWs } = await start(repository);
    const nodeKey = keyFixture();
    const identity = deriveNodeIdentity(nodeKey.publicKeySpki);
    repository.addActive(identity);
    const node = await connectNode(baseWs, nodeKey);
    const first = await beginClient(baseWs, identity.nodeId, keyFixture());
    await authorize(node.harness, first, true);
    const firstClose = first.closeEvent();
    first.socket.close(1000, "done");
    node.harness.socket.send(Buffer.from("stale-in-flight-frame"));
    expect((await firstClose).code).toBe(1000);
    expect(await node.harness.nextJson()).toEqual({ type: "clientDisconnected" });

    const second = await beginClient(baseWs, identity.nodeId, keyFixture());
    await authorize(node.harness, second, true);
    const secondClose = second.closeEvent();
    node.harness.socket.close(1000, "done");
    expect((await secondClose).code).toBe(4410);
  });

  test("rejects a Client denied by the Node and leaves the Node ready", async () => {
    const repository = new TestRepository();
    const { baseWs } = await start(repository);
    const nodeKey = keyFixture();
    const identity = deriveNodeIdentity(nodeKey.publicKeySpki);
    repository.addActive(identity);
    const node = await connectNode(baseWs, nodeKey);
    const unpairedClient = await beginClient(baseWs, identity.nodeId, keyFixture());
    const close = unpairedClient.closeEvent();
    await authorize(node.harness, unpairedClient, false);
    expect((await close).code).toBe(4403);
    const pairedClient = await beginClient(baseWs, identity.nodeId, keyFixture());
    await authorize(node.harness, pairedClient, true);
  });

  test("ignores a late authorization result after the Client disconnects", async () => {
    const repository = new TestRepository();
    const { baseWs } = await start(repository);
    const nodeKey = keyFixture();
    const identity = deriveNodeIdentity(nodeKey.publicKeySpki);
    repository.addActive(identity);
    const node = await connectNode(baseWs, nodeKey);
    const canceledClient = await beginClient(baseWs, identity.nodeId, keyFixture());
    const request = await node.harness.nextJson();
    const canceledClose = canceledClient.closeEvent();
    canceledClient.socket.close(1000, "canceled");
    expect((await canceledClose).code).toBe(1000);
    node.harness.socket.send(JSON.stringify({ type: "authorizeClientResult", requestId: request.requestId, allow: false }));

    const nextClient = await beginClient(baseWs, identity.nodeId, keyFixture());
    await authorize(node.harness, nextClient, true);
  });

  test("does not register a ghost Node when identity lookup returns after handshake timeout", async () => {
    const repository = new TestRepository();
    repository.nodeLookupDelayMs = 80;
    const { runtime, baseWs } = await start(repository, [], { handshakeTimeoutMs: 25 });
    const nodeKey = keyFixture();
    const identity = deriveNodeIdentity(nodeKey.publicKeySpki);
    repository.addActive(identity);
    const stale = new Harness(new WebSocket(`${baseWs}${PI_TUNNEL_NODE_PATH}`, PI_TUNNEL_PROTOCOL));
    await stale.opened;
    const challenge = await stale.nextJson();
    const staleClose = stale.closeEvent();
    stale.socket.send(JSON.stringify({
      type: "nodeAuth",
      protocol: PI_TUNNEL_PROTOCOL,
      nodeId: identity.nodeId,
      publicKeySpki: nodeKey.publicKeySpki,
      signature: sign(null, nodeConnectProofBytes({ challenge: String(challenge.nonce), nodeId: identity.nodeId, protocol: PI_TUNNEL_PROTOCOL }), nodeKey.privateKey).toString("base64url"),
    }));
    expect((await staleClose).code).toBe(4411);
    await wait(100);
    expect(runtime.metrics.snapshot().node_connections).toBe(0);

    repository.nodeLookupDelayMs = 0;
    await connectNode(baseWs, nodeKey);
    expect(runtime.metrics.snapshot().node_connections).toBe(1);
  });

  test("enforces idle timeout despite automatic pong traffic", async () => {
    const repository = new TestRepository();
    const { baseWs } = await start(repository, [], {
      heartbeatIntervalMs: 10,
      idleTimeoutMs: 35,
      hardLifetimeMs: 1_000,
    });
    const nodeKey = keyFixture();
    const identity = deriveNodeIdentity(nodeKey.publicKeySpki);
    repository.addActive(identity);
    const node = await connectNode(baseWs, nodeKey);
    expect((await node.harness.closeEvent()).code).toBe(4411);
  });

  test("rejects WebSocket upgrades above the configured connection cap", async () => {
    const repository = new TestRepository();
    const { baseWs } = await start(repository, [], { maxConnections: 1 });
    const first = new Harness(new WebSocket(`${baseWs}${PI_TUNNEL_CLIENT_PATH}`, PI_TUNNEL_PROTOCOL));
    await first.opened;
    await first.nextJson();
    expect(await rejectedUpgradeStatus(`${baseWs}${PI_TUNNEL_CLIENT_PATH}`)).toBe(503);
  });

  test("does not overlap slow revocation polls", async () => {
    const repository = new TestRepository();
    repository.activeLookupDelayMs = 40;
    const { baseWs } = await start(repository, [], { nodeRevocationPollMs: 10 });
    const nodeKey = keyFixture();
    const identity = deriveNodeIdentity(nodeKey.publicKeySpki);
    repository.addActive(identity);
    await connectNode(baseWs, nodeKey);
    await wait(110);
    expect(repository.activeLookupCalls).toBeGreaterThanOrEqual(2);
    expect(repository.maxActiveLookupInFlight).toBe(1);
  });

  test("rejects unactivated or revoked Nodes and invalid Client nonce proof", async () => {
    const repository = new TestRepository();
    const { baseWs } = await start(repository);
    const key = keyFixture();
    const identity = deriveNodeIdentity(key.publicKeySpki);
    const unactivated = new Harness(new WebSocket(`${baseWs}${PI_TUNNEL_NODE_PATH}`, PI_TUNNEL_PROTOCOL));
    await unactivated.opened;
    const challenge = await unactivated.nextJson();
    const close = unactivated.closeEvent();
    unactivated.socket.send(JSON.stringify({
      type: "nodeAuth",
      protocol: PI_TUNNEL_PROTOCOL,
      nodeId: identity.nodeId,
      publicKeySpki: key.publicKeySpki,
      signature: sign(null, nodeConnectProofBytes({ challenge: String(challenge.nonce), nodeId: identity.nodeId, protocol: PI_TUNNEL_PROTOCOL }), key.privateKey).toString("base64url"),
    }));
    expect((await close).code).toBe(4401);

    repository.addActive(identity);
    const activeId = [...repository.rows.values()][0]!.id;
    await repository.revoke(activeId, "operator_revoked", new Date().toISOString());
    const revoked = new Harness(new WebSocket(`${baseWs}${PI_TUNNEL_NODE_PATH}`, PI_TUNNEL_PROTOCOL));
    await revoked.opened;
    const revokedChallenge = await revoked.nextJson();
    const revokedClose = revoked.closeEvent();
    revoked.socket.send(JSON.stringify({
      type: "nodeAuth",
      protocol: PI_TUNNEL_PROTOCOL,
      nodeId: identity.nodeId,
      publicKeySpki: key.publicKeySpki,
      signature: sign(null, nodeConnectProofBytes({ challenge: String(revokedChallenge.nonce), nodeId: identity.nodeId, protocol: PI_TUNNEL_PROTOCOL }), key.privateKey).toString("base64url"),
    }));
    expect((await revokedClose).code).toBe(4401);
  });

  test("rejects text after pairing, oversized frames, incomplete handshakes, and stalled authorization", async () => {
    const repository = new TestRepository();
    const { baseWs } = await start(repository, [], { handshakeTimeoutMs: 50 });
    const timeoutClient = new Harness(new WebSocket(`${baseWs}${PI_TUNNEL_CLIENT_PATH}`, PI_TUNNEL_PROTOCOL));
    await timeoutClient.opened;
    await timeoutClient.nextJson();
    expect((await timeoutClient.closeEvent()).code).toBe(4411);

    const nodeKey = keyFixture();
    const identity = deriveNodeIdentity(nodeKey.publicKeySpki);
    repository.addActive(identity);
    const node = await connectNode(baseWs, nodeKey);
    const stalledClient = await beginClient(baseWs, identity.nodeId, keyFixture());
    const stalledClose = stalledClient.closeEvent();
    const staleAuthorization = await node.harness.nextJson();
    expect(staleAuthorization).toMatchObject({ type: "authorizeClient" });
    expect((await stalledClose).code).toBe(4411);
    node.harness.socket.send(JSON.stringify({ type: "authorizeClientResult", requestId: staleAuthorization.requestId, allow: true }));

    const textClient = await beginClient(baseWs, identity.nodeId, keyFixture());
    await authorize(node.harness, textClient, true);
    const textClose = textClient.closeEvent();
    textClient.socket.send("plaintext-forbidden");
    expect((await textClose).code).toBe(4400);
    expect(await node.harness.nextJson()).toEqual({ type: "clientDisconnected" });

    const largeClient = await beginClient(baseWs, identity.nodeId, keyFixture());
    await authorize(node.harness, largeClient, true);
    const largeClose = largeClient.closeEvent();
    largeClient.socket.send(Buffer.alloc(2_048));
    expect((await largeClose).code).toBe(1009);
  });
});
