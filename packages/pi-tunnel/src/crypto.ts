import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { PiTunnelDomainError, type VerifiedNodeIdentity } from "./contracts.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const ACTIVATION_ID_PATTERN = /^pi_device_[a-f0-9]{32}$/u;
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PROOF_FRESHNESS_MS = 5 * 60_000;

export function createActivationSecret(): { activationCode: string; activationCodeHash: string } {
  const activationCode = randomBytes(32).toString("base64url");
  return { activationCode, activationCodeHash: hashActivationCode(activationCode) };
}

export function createActivationId(): string {
  return `pi_device_${randomBytes(16).toString("hex")}`;
}

export function hashActivationCode(activationCode: string): string {
  const bytes = decodeBase64Url(activationCode, 32, "activation_code_invalid");
  return `sha256:${createHash("sha256").update(bytes).digest("base64url")}`;
}

export function activationCodeMatches(storedHash: string, activationCode: string): boolean {
  let actual: Buffer;
  try {
    actual = Buffer.from(hashActivationCode(activationCode), "utf8");
  } catch {
    actual = Buffer.from(`sha256:${"A".repeat(43)}`, "utf8");
  }
  const expected = Buffer.from(storedHash, "utf8");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

export function parseEd25519PublicKey(publicKeySpki: string): { key: KeyObject; canonicalSpki: string } {
  const der = decodeBase64Url(publicKeySpki, 44, "public_key_invalid");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new PiTunnelDomainError("public_key_invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new PiTunnelDomainError("public_key_invalid");
  const canonical = key.export({ format: "der", type: "spki" });
  const canonicalBuffer = Buffer.isBuffer(canonical) ? canonical : Buffer.from(canonical);
  if (!timingSafeEqual(canonicalBuffer, der)) throw new PiTunnelDomainError("public_key_invalid");
  return { key, canonicalSpki: canonicalBuffer.toString("base64url") };
}

export function deriveNodeIdentity(publicKeySpki: string): VerifiedNodeIdentity {
  const parsed = parseEd25519PublicKey(publicKeySpki);
  const der = Buffer.from(parsed.canonicalSpki, "base64url");
  const digest = createHash("sha256").update(der).digest("base64url");
  return { nodeId: digest, publicKeySpki: parsed.canonicalSpki, keyThumbprint: digest };
}

export function verifyActivationProof(input: {
  activationId: string;
  publicKeySpki: string;
  nonce: string;
  issuedAt: string;
  signature: string;
  now?: Date;
}): VerifiedNodeIdentity {
  if (!ACTIVATION_ID_PATTERN.test(input.activationId)) throw new PiTunnelDomainError("activation_rejected");
  const identity = deriveNodeIdentity(input.publicKeySpki);
  decodeBase64Url(input.nonce, 32, "activation_rejected");
  const issuedAtMs = Date.parse(input.issuedAt);
  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(issuedAtMs) || Math.abs(nowMs - issuedAtMs) > PROOF_FRESHNESS_MS) {
    throw new PiTunnelDomainError("activation_rejected");
  }
  verifySignature(
    identity.publicKeySpki,
    activationProofBytes({
      activationId: input.activationId,
      publicKeySpki: identity.publicKeySpki,
      nonce: input.nonce,
      issuedAt: new Date(issuedAtMs).toISOString(),
    }),
    input.signature,
    "activation_rejected",
  );
  return identity;
}

export function activationProofBytes(input: {
  activationId: string;
  publicKeySpki: string;
  nonce: string;
  issuedAt: string;
}): Buffer {
  return canonicalProof("activation", [input.activationId, input.publicKeySpki, input.nonce, input.issuedAt]);
}

export function nodeConnectProofBytes(input: { challenge: string; nodeId: string; protocol: string }): Buffer {
  return canonicalProof("node-connect", [input.challenge, input.nodeId, input.protocol]);
}

export function clientConnectProofBytes(input: {
  challenge: string;
  nodeId: string;
  clientPublicKeySpki: string;
  protocol: string;
}): Buffer {
  return canonicalProof("client-connect", [input.challenge, input.nodeId, input.clientPublicKeySpki, input.protocol]);
}

export function verifyNodeConnectProof(input: {
  challenge: string;
  nodeId: string;
  publicKeySpki: string;
  protocol: string;
  signature: string;
}): VerifiedNodeIdentity {
  if (!NODE_ID_PATTERN.test(input.nodeId)) throw new PiTunnelDomainError("node_auth_rejected");
  const identity = deriveNodeIdentity(input.publicKeySpki);
  if (identity.nodeId !== input.nodeId) throw new PiTunnelDomainError("node_auth_rejected");
  verifySignature(
    identity.publicKeySpki,
    nodeConnectProofBytes({ challenge: input.challenge, nodeId: input.nodeId, protocol: input.protocol }),
    input.signature,
    "node_auth_rejected",
  );
  return identity;
}

export function verifyClientConnectProof(input: {
  challenge: string;
  nodeId: string;
  clientPublicKeySpki: string;
  protocol: string;
  signature: string;
}): { clientPublicKeySpki: string; clientKeyThumbprint: string } {
  if (!NODE_ID_PATTERN.test(input.nodeId)) throw new PiTunnelDomainError("client_auth_rejected");
  const parsed = parseEd25519PublicKey(input.clientPublicKeySpki);
  const thumbprint = createHash("sha256").update(Buffer.from(parsed.canonicalSpki, "base64url")).digest("base64url");
  verifySignature(
    parsed.canonicalSpki,
    clientConnectProofBytes({
      challenge: input.challenge,
      nodeId: input.nodeId,
      clientPublicKeySpki: parsed.canonicalSpki,
      protocol: input.protocol,
    }),
    input.signature,
    "client_auth_rejected",
  );
  return { clientPublicKeySpki: parsed.canonicalSpki, clientKeyThumbprint: thumbprint };
}

export function randomChallenge(): string {
  return randomBytes(32).toString("base64url");
}

function verifySignature(publicKeySpki: string, message: Buffer, signature: string, errorCode: string): void {
  const signatureBytes = decodeBase64Url(signature, 64, errorCode);
  const key = parseEd25519PublicKey(publicKeySpki).key;
  if (!verify(null, message, key, signatureBytes)) throw new PiTunnelDomainError(errorCode);
}

function canonicalProof(kind: string, values: readonly string[]): Buffer {
  for (const value of values) {
    if (!value || value.includes("\n") || value.length > 512) throw new PiTunnelDomainError("proof_value_invalid");
  }
  return Buffer.from([`friday.pi-tunnel.${kind}.v1`, ...values].join("\n"), "utf8");
}

function decodeBase64Url(value: string, expectedBytes: number, errorCode: string): Buffer {
  if (!BASE64URL_PATTERN.test(value) || value.includes("=") || value.length > 512) {
    throw new PiTunnelDomainError(errorCode);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw new PiTunnelDomainError(errorCode);
  }
  if (bytes.byteLength !== expectedBytes || bytes.toString("base64url") !== value) {
    throw new PiTunnelDomainError(errorCode);
  }
  return bytes;
}
