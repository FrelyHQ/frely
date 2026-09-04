import {
  PI_TUNNEL_REVOCATION_REASONS,
  PiTunnelDomainError,
  type CreatedActivationSlot,
  type PiTunnelDevice,
  type PiTunnelDeviceRepository,
  type PiTunnelRevocationReason,
  type VerifiedNodeIdentity,
} from "./contracts.js";
import { createActivationId, createActivationSecret } from "./crypto.js";

export class PiTunnelDeviceService {
  constructor(private readonly repository: PiTunnelDeviceRepository) {}

  async createActivationSlot(input: { ttlSeconds: number; attempts: number; now?: Date }): Promise<CreatedActivationSlot> {
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 86_400) {
      throw new PiTunnelDomainError("activation_ttl_invalid");
    }
    if (!Number.isSafeInteger(input.attempts) || input.attempts < 1 || input.attempts > 10) {
      throw new PiTunnelDomainError("activation_attempts_invalid");
    }
    const now = input.now ?? new Date();
    const secret = createActivationSecret();
    const device = await this.repository.createPending({
      id: createActivationId(),
      activationCodeHash: secret.activationCodeHash,
      activationExpiresAt: new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString(),
      activationAttemptsRemaining: input.attempts,
      createdAt: now.toISOString(),
    });
    return { device, activationCode: secret.activationCode };
  }

  inspect(id: string): Promise<PiTunnelDevice | null> {
    return this.repository.inspect(id);
  }

  activate(input: {
    activationId: string;
    activationCode: string;
    identity: VerifiedNodeIdentity;
    now?: Date;
  }): Promise<PiTunnelDevice> {
    return this.repository.consumeActivation({
      activationId: input.activationId,
      activationCode: input.activationCode,
      ...input.identity,
      activatedAt: (input.now ?? new Date()).toISOString(),
    });
  }

  revoke(input: { id: string; reason: PiTunnelRevocationReason; now?: Date }): Promise<PiTunnelDevice> {
    if (!(PI_TUNNEL_REVOCATION_REASONS as readonly string[]).includes(input.reason)) {
      throw new PiTunnelDomainError("revocation_reason_invalid");
    }
    return this.repository.revoke(input.id, input.reason, (input.now ?? new Date()).toISOString());
  }
}
