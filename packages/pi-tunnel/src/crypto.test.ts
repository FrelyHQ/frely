import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  PI_TUNNEL_PROTOCOL,
  activationProofBytes,
  clientConnectProofBytes,
  deriveNodeIdentity,
  hashActivationCode,
  nodeConnectProofBytes,
  verifyActivationProof,
  verifyClientConnectProof,
  verifyNodeConnectProof,
} from "./index.js";

function keyFixture() {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpki = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return { ...pair, publicKeySpki };
}

function signature(privateKey: ReturnType<typeof keyFixture>["privateKey"], bytes: Buffer): string {
  return sign(null, bytes, privateKey).toString("base64url");
}

describe("Pi Tunnel cryptographic contracts", () => {
  test("derives node identity only from canonical Ed25519 SPKI and verifies activation ownership", () => {
    const key = keyFixture();
    const identity = deriveNodeIdentity(key.publicKeySpki);
    const proof = {
      activationId: `pi_device_${"a".repeat(32)}`,
      publicKeySpki: key.publicKeySpki,
      nonce: randomBytes(32).toString("base64url"),
      issuedAt: "2026-08-25T00:00:00.000Z",
    };
    const verified = verifyActivationProof({
      ...proof,
      signature: signature(key.privateKey, activationProofBytes(proof)),
      now: new Date("2026-08-25T00:01:00.000Z"),
    });
    expect(verified).toEqual(identity);
    expect(identity.nodeId).toBe(identity.keyThumbprint);
    expect(identity.nodeId).toHaveLength(43);
  });

  test("rejects stale proofs and signatures from a different key", () => {
    const key = keyFixture();
    const attacker = keyFixture();
    const proof = {
      activationId: `pi_device_${"b".repeat(32)}`,
      publicKeySpki: key.publicKeySpki,
      nonce: randomBytes(32).toString("base64url"),
      issuedAt: "2026-08-25T00:00:00.000Z",
    };
    expect(() => verifyActivationProof({
      ...proof,
      signature: signature(attacker.privateKey, activationProofBytes(proof)),
      now: new Date("2026-08-25T00:00:01.000Z"),
    })).toThrow("activation_rejected");
    expect(() => verifyActivationProof({
      ...proof,
      signature: signature(key.privateKey, activationProofBytes(proof)),
      now: new Date("2026-08-25T00:10:00.000Z"),
    })).toThrow("activation_rejected");
  });

  test("binds Node and Client nonce proofs to the fixed protocol and target Node", () => {
    const node = keyFixture();
    const client = keyFixture();
    const identity = deriveNodeIdentity(node.publicKeySpki);
    const challenge = randomBytes(32).toString("base64url");
    const nodeProof = nodeConnectProofBytes({ challenge, nodeId: identity.nodeId, protocol: PI_TUNNEL_PROTOCOL });
    expect(verifyNodeConnectProof({
      challenge,
      nodeId: identity.nodeId,
      publicKeySpki: node.publicKeySpki,
      protocol: PI_TUNNEL_PROTOCOL,
      signature: signature(node.privateKey, nodeProof),
    })).toEqual(identity);

    const clientProof = clientConnectProofBytes({
      challenge,
      nodeId: identity.nodeId,
      clientPublicKeySpki: client.publicKeySpki,
      protocol: PI_TUNNEL_PROTOCOL,
    });
    expect(verifyClientConnectProof({
      challenge,
      nodeId: identity.nodeId,
      clientPublicKeySpki: client.publicKeySpki,
      protocol: PI_TUNNEL_PROTOCOL,
      signature: signature(client.privateKey, clientProof),
    }).clientKeyThumbprint).toHaveLength(43);
    expect(() => verifyClientConnectProof({
      challenge,
      nodeId: identity.nodeId,
      clientPublicKeySpki: client.publicKeySpki,
      protocol: `${PI_TUNNEL_PROTOCOL}.wrong`,
      signature: signature(client.privateKey, clientProof),
    })).toThrow("client_auth_rejected");
  });

  test("hashes a 256-bit activation code without preserving the raw value", () => {
    const raw = randomBytes(32).toString("base64url");
    const hashed = hashActivationCode(raw);
    expect(hashed).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
    expect(hashed).not.toContain(raw);
  });
});
