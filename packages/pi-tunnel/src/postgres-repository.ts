import {
  createPostgresClientFromEnvironment,
  type Prisma,
  type PostgresClientOwner,
} from "@frely/postgres/server";
import {
  PiTunnelDomainError,
  type ConsumeActivationInput,
  type PiTunnelDevice,
  type PiTunnelDeviceRepository,
  type PiTunnelRevocationReason,
} from "./contracts.js";
import { activationCodeMatches } from "./crypto.js";

type DeviceRow = Awaited<ReturnType<Prisma.TransactionClient["pi_tunnel_devices"]["findUnique"]>>;

export interface PostgresPiTunnelDeviceRuntime {
  readonly repository: PiTunnelDeviceRepository;
  close(): Promise<void>;
}

export function createPostgresPiTunnelDeviceRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): PostgresPiTunnelDeviceRuntime {
  const owner = createPostgresClientFromEnvironment({
    ...environment,
    FRIDAY_RELAY_PG_APPLICATION_NAME: environment.FRIDAY_RELAY_PG_APPLICATION_NAME ?? "friday-relay-pi-tunnel",
  });
  return {
    repository: new PostgresPiTunnelDeviceRepository(owner),
    close: () => owner.close(),
  };
}

export class PostgresPiTunnelDeviceRepository implements PiTunnelDeviceRepository {
  constructor(private readonly owner: PostgresClientOwner) {}

  async createPending(input: {
    id: string;
    activationCodeHash: string;
    activationExpiresAt: string;
    activationAttemptsRemaining: number;
    createdAt: string;
  }): Promise<PiTunnelDevice> {
    const row = await this.owner.prisma.pi_tunnel_devices.create({
      data: {
        id: input.id,
        lifecycle: "pending",
        activation_code_hash: input.activationCodeHash,
        activation_expires_at: input.activationExpiresAt,
        activation_attempts_remaining: input.activationAttemptsRemaining,
        node_id: null,
        node_public_key_spki: null,
        node_key_thumbprint: null,
        activated_at: null,
        revoked_at: null,
        revocation_reason: null,
        created_at: input.createdAt,
      },
    });
    return mapDevice(row);
  }

  async inspect(id: string): Promise<PiTunnelDevice | null> {
    return mapNullable(await this.owner.prisma.pi_tunnel_devices.findUnique({ where: { id } }));
  }

  async consumeActivation(input: ConsumeActivationInput): Promise<PiTunnelDevice> {
    const result = await this.owner.withPrismaTransaction(async (transaction): Promise<PiTunnelDevice | null> => {
      await transaction.$queryRaw`SELECT "id" FROM "pi_tunnel_devices" WHERE "id" = ${input.activationId} FOR UPDATE`;
      const row = await transaction.pi_tunnel_devices.findUnique({ where: { id: input.activationId } });
      if (!row) {
        activationCodeMatches(`sha256:${"A".repeat(43)}`, input.activationCode);
        return null;
      }
      if (row.lifecycle !== "pending" || row.activation_attempts_remaining < 1 || row.activation_expires_at <= input.activatedAt) {
        return null;
      }
      if (!activationCodeMatches(row.activation_code_hash, input.activationCode)) {
        await transaction.pi_tunnel_devices.update({
          where: { id: row.id },
          data: { activation_attempts_remaining: row.activation_attempts_remaining - 1 },
        });
        return null;
      }
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.nodeId}, 0))::text AS "lock"`;
      const identityAlreadyBound = await transaction.pi_tunnel_devices.findFirst({
        where: { OR: [{ node_id: input.nodeId }, { node_key_thumbprint: input.keyThumbprint }] },
        select: { id: true },
      });
      if (identityAlreadyBound) return null;
      const activated = await transaction.pi_tunnel_devices.update({
        where: { id: row.id },
        data: {
          lifecycle: "active",
          node_id: input.nodeId,
          node_public_key_spki: input.publicKeySpki,
          node_key_thumbprint: input.keyThumbprint,
          activated_at: input.activatedAt,
        },
      });
      return mapDevice(activated);
    }, 1, { isolationLevel: "ReadCommitted", statementTimeoutMillis: 5_000 });
    if (!result) throw new PiTunnelDomainError("activation_rejected");
    return result;
  }

  revoke(id: string, reason: PiTunnelRevocationReason, revokedAt: string): Promise<PiTunnelDevice> {
    return this.owner.withPrismaTransaction(async (transaction) => {
      await transaction.$queryRaw`SELECT "id" FROM "pi_tunnel_devices" WHERE "id" = ${id} FOR UPDATE`;
      const row = await transaction.pi_tunnel_devices.findUnique({ where: { id } });
      if (!row) throw new PiTunnelDomainError("device_not_found");
      if (row.lifecycle === "revoked") return mapDevice(row);
      return mapDevice(await transaction.pi_tunnel_devices.update({
        where: { id },
        data: { lifecycle: "revoked", revoked_at: revokedAt, revocation_reason: reason },
      }));
    }, 1, { isolationLevel: "ReadCommitted", statementTimeoutMillis: 5_000 });
  }

  async findActiveByNodeId(nodeId: string): Promise<PiTunnelDevice | null> {
    return mapNullable(await this.owner.prisma.pi_tunnel_devices.findFirst({
      where: { node_id: nodeId, lifecycle: "active", revoked_at: null },
    }));
  }

  async findActiveNodeIds(nodeIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (nodeIds.length === 0) return new Set();
    const rows = await this.owner.prisma.pi_tunnel_devices.findMany({
      where: { node_id: { in: [...new Set(nodeIds)] }, lifecycle: "active", revoked_at: null },
      select: { node_id: true },
    });
    return new Set(rows.flatMap((row) => row.node_id ? [row.node_id] : []));
  }
}

function mapNullable(row: DeviceRow): PiTunnelDevice | null {
  return row ? mapDevice(row) : null;
}

function mapDevice(row: NonNullable<DeviceRow>): PiTunnelDevice {
  return {
    id: row.id,
    lifecycle: row.lifecycle as PiTunnelDevice["lifecycle"],
    activationCodeHash: row.activation_code_hash,
    activationExpiresAt: row.activation_expires_at,
    activationAttemptsRemaining: row.activation_attempts_remaining,
    nodeId: row.node_id,
    nodePublicKeySpki: row.node_public_key_spki,
    nodeKeyThumbprint: row.node_key_thumbprint,
    activatedAt: row.activated_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason as PiTunnelDevice["revocationReason"],
    createdAt: row.created_at,
  };
}
