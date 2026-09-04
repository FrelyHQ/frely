import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  PiTunnelDeviceService,
  PiTunnelDomainError,
  activationCodeMatches,
  deriveNodeIdentity,
  type ConsumeActivationInput,
  type PiTunnelDevice,
  type PiTunnelDeviceRepository,
  type PiTunnelRevocationReason,
} from "./index.js";

class MemoryDeviceRepository implements PiTunnelDeviceRepository {
  readonly rows = new Map<string, PiTunnelDevice>();
  private serial = Promise.resolve();

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

  consumeActivation(input: ConsumeActivationInput): Promise<PiTunnelDevice> {
    return this.exclusive(async () => {
      const row = this.rows.get(input.activationId);
      if (!row || row.lifecycle !== "pending" || row.activationAttemptsRemaining < 1 || row.activationExpiresAt <= input.activatedAt) {
        throw new PiTunnelDomainError("activation_rejected");
      }
      if (!activationCodeMatches(row.activationCodeHash, input.activationCode)) {
        this.rows.set(row.id, { ...row, activationAttemptsRemaining: row.activationAttemptsRemaining - 1 });
        throw new PiTunnelDomainError("activation_rejected");
      }
      if ([...this.rows.values()].some((candidate) => candidate.nodeId === input.nodeId)) {
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
    });
  }

  revoke(id: string, reason: PiTunnelRevocationReason, revokedAt: string): Promise<PiTunnelDevice> {
    return this.exclusive(async () => {
      const row = this.rows.get(id);
      if (!row) throw new PiTunnelDomainError("device_not_found");
      if (row.lifecycle === "revoked") return row;
      const revoked: PiTunnelDevice = { ...row, lifecycle: "revoked", revokedAt, revocationReason: reason };
      this.rows.set(id, revoked);
      return revoked;
    });
  }

  async findActiveByNodeId(nodeId: string): Promise<PiTunnelDevice | null> {
    return [...this.rows.values()].find((row) => row.lifecycle === "active" && row.nodeId === nodeId) ?? null;
  }

  async findActiveNodeIds(nodeIds: readonly string[]): Promise<ReadonlySet<string>> {
    const requested = new Set(nodeIds);
    return new Set([...this.rows.values()].flatMap((row) => row.lifecycle === "active" && row.nodeId && requested.has(row.nodeId) ? [row.nodeId] : []));
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const before = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await before;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function nodeIdentity() {
  const pair = generateKeyPairSync("ed25519");
  return deriveNodeIdentity(pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"));
}

describe("Pi Tunnel device admission", () => {
  test("consumes one high-entropy activation code exactly once", async () => {
    const repository = new MemoryDeviceRepository();
    const service = new PiTunnelDeviceService(repository);
    const slot = await service.createActivationSlot({ ttlSeconds: 600, attempts: 3, now: new Date("2026-08-25T00:00:00.000Z") });
    expect(slot.activationCode).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(slot.device.activationCodeHash).not.toContain(slot.activationCode);
    const active = await service.activate({
      activationId: slot.device.id,
      activationCode: slot.activationCode,
      identity: nodeIdentity(),
      now: new Date("2026-08-25T00:01:00.000Z"),
    });
    expect(active.lifecycle).toBe("active");
    await expect(service.activate({
      activationId: slot.device.id,
      activationCode: slot.activationCode,
      identity: nodeIdentity(),
      now: new Date("2026-08-25T00:02:00.000Z"),
    })).rejects.toThrow("activation_rejected");
  });

  test("decrements only an existing pending slot for a wrong code and rejects expiry", async () => {
    const repository = new MemoryDeviceRepository();
    const service = new PiTunnelDeviceService(repository);
    const slot = await service.createActivationSlot({ ttlSeconds: 60, attempts: 2, now: new Date("2026-08-25T00:00:00.000Z") });
    await expect(service.activate({
      activationId: slot.device.id,
      activationCode: "A".repeat(43),
      identity: nodeIdentity(),
      now: new Date("2026-08-25T00:00:30.000Z"),
    })).rejects.toThrow("activation_rejected");
    expect((await service.inspect(slot.device.id))?.activationAttemptsRemaining).toBe(1);
    await expect(service.activate({
      activationId: slot.device.id,
      activationCode: slot.activationCode,
      identity: nodeIdentity(),
      now: new Date("2026-08-25T00:01:00.000Z"),
    })).rejects.toThrow("activation_rejected");
  });

  test("rejects activation after revocation", async () => {
    const repository = new MemoryDeviceRepository();
    const service = new PiTunnelDeviceService(repository);
    const slot = await service.createActivationSlot({ ttlSeconds: 600, attempts: 3, now: new Date("2026-08-25T00:00:00.000Z") });
    await service.revoke({ id: slot.device.id, reason: "operator_revoked", now: new Date("2026-08-25T00:00:01.000Z") });
    await expect(service.activate({
      activationId: slot.device.id,
      activationCode: slot.activationCode,
      identity: nodeIdentity(),
      now: new Date("2026-08-25T00:00:02.000Z"),
    })).rejects.toThrow("activation_rejected");
  });

  test("serializes concurrent consumption so only one activation succeeds", async () => {
    const repository = new MemoryDeviceRepository();
    const service = new PiTunnelDeviceService(repository);
    const slot = await service.createActivationSlot({ ttlSeconds: 600, attempts: 3, now: new Date("2026-08-25T00:00:00.000Z") });
    const identity = nodeIdentity();
    const results = await Promise.allSettled([
      service.activate({ activationId: slot.device.id, activationCode: slot.activationCode, identity, now: new Date("2026-08-25T00:00:01.000Z") }),
      service.activate({ activationId: slot.device.id, activationCode: slot.activationCode, identity, now: new Date("2026-08-25T00:00:01.000Z") }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});

export { MemoryDeviceRepository };
