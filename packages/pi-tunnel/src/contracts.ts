export const PI_TUNNEL_PROTOCOL = "friday.pi-tunnel.v1" as const;
export const PI_TUNNEL_NODE_PATH = "/v1/pi-tunnel/node/connect" as const;
export const PI_TUNNEL_CLIENT_PATH = "/v1/pi-tunnel/client/connect" as const;
export const PI_TUNNEL_ACTIVATION_PATH = "/v1/pi-tunnel/activate" as const;

export const PI_TUNNEL_DEVICE_LIFECYCLES = ["pending", "active", "revoked"] as const;
export type PiTunnelDeviceLifecycle = (typeof PI_TUNNEL_DEVICE_LIFECYCLES)[number];

export const PI_TUNNEL_REVOCATION_REASONS = [
  "operator_revoked",
  "security_response",
  "key_compromise",
  "device_replaced",
] as const;
export type PiTunnelRevocationReason = (typeof PI_TUNNEL_REVOCATION_REASONS)[number];

export interface PiTunnelDevice {
  readonly id: string;
  readonly lifecycle: PiTunnelDeviceLifecycle;
  readonly activationCodeHash: string;
  readonly activationExpiresAt: string;
  readonly activationAttemptsRemaining: number;
  readonly nodeId: string | null;
  readonly nodePublicKeySpki: string | null;
  readonly nodeKeyThumbprint: string | null;
  readonly activatedAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: PiTunnelRevocationReason | null;
  readonly createdAt: string;
}

export interface CreateActivationSlotInput {
  readonly expiresAt: string;
  readonly attempts: number;
  readonly createdAt: string;
}

export interface CreatedActivationSlot {
  readonly device: PiTunnelDevice;
  readonly activationCode: string;
}

export interface VerifiedNodeIdentity {
  readonly nodeId: string;
  readonly publicKeySpki: string;
  readonly keyThumbprint: string;
}

export interface ConsumeActivationInput extends VerifiedNodeIdentity {
  readonly activationId: string;
  readonly activationCode: string;
  readonly activatedAt: string;
}

export interface PiTunnelDeviceRepository {
  createPending(input: {
    readonly id: string;
    readonly activationCodeHash: string;
    readonly activationExpiresAt: string;
    readonly activationAttemptsRemaining: number;
    readonly createdAt: string;
  }): Promise<PiTunnelDevice>;
  inspect(id: string): Promise<PiTunnelDevice | null>;
  consumeActivation(input: ConsumeActivationInput): Promise<PiTunnelDevice>;
  revoke(id: string, reason: PiTunnelRevocationReason, revokedAt: string): Promise<PiTunnelDevice>;
  findActiveByNodeId(nodeId: string): Promise<PiTunnelDevice | null>;
  findActiveNodeIds(nodeIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export class PiTunnelDomainError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
