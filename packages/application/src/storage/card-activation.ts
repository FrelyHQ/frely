import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CARD_ACTIVATION_CODE_PREFIX = "fca_";
export const CARD_ACTIVATION_CODE_BYTES = 24;
export const CARD_ACTIVATION_CODE_LENGTH = CARD_ACTIVATION_CODE_PREFIX.length + 32;
export const CARD_ACTIVATION_KEY_PURPOSE = "friday-relay.card-activation-export.v1";
export const CARD_ACTIVATION_SCHEMA_VERSION = "113";
export const CARD_ACTIVATION_INTENT_VERSION = "1";

export interface CardActivationKey {
  version: number;
  key: Buffer;
}

export interface CardActivationKeyring {
  current: CardActivationKey;
  historical?: CardActivationKey[];
}

export interface EncryptedCardActivationSeed {
  version: 1;
  algorithm: "aes-256-gcm";
  keyVersion: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function cardActivationCodeHash(rawCode: string): string {
  return createHash("sha256").update(rawCode).digest("hex");
}

export function createCardActivationCode(seed: Buffer, batchId: string, ordinal: number): string {
  if (seed.length !== 32) throw new Error("card_activation_seed_invalid");
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("card_activation_ordinal_invalid");
  const digest = createHmac("sha256", seed)
    .update("friday-relay.card-activation-code.v1\0")
    .update(batchId)
    .update("\0")
    .update(String(ordinal))
    .digest()
    .subarray(0, CARD_ACTIVATION_CODE_BYTES);
  return `${CARD_ACTIVATION_CODE_PREFIX}${digest.toString("base64url")}`;
}

export function createCardActivationSeed(): Buffer {
  return randomBytes(32);
}

export function encryptCardActivationSeed(seed: Buffer, batchId: string, keyring: CardActivationKeyring): { ciphertext: string; keyVersion: number } {
  const key = validateKey(keyring.current);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(cardActivationAad(batchId));
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  const envelope: EncryptedCardActivationSeed = {
    version: 1,
    algorithm: "aes-256-gcm",
    keyVersion: key.version,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return { ciphertext: JSON.stringify(envelope), keyVersion: key.version };
}

export function decryptCardActivationSeed(encoded: string, batchId: string, keyring: CardActivationKeyring): Buffer {
  let envelope: EncryptedCardActivationSeed;
  try {
    envelope = JSON.parse(encoded) as EncryptedCardActivationSeed;
  } catch {
    throw new Error("card_activation_seed_envelope_invalid");
  }
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm" || !Number.isSafeInteger(envelope.keyVersion)) {
    throw new Error("card_activation_seed_envelope_invalid");
  }
  const key = [keyring.current, ...(keyring.historical ?? [])].find((candidate) => candidate.version === envelope.keyVersion);
  if (!key) throw new Error("card_activation_export_key_unavailable");
  const validatedKey = validateKey(key);
  try {
    const decipher = createDecipheriv("aes-256-gcm", validatedKey.key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(cardActivationAad(batchId));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const seed = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
    if (seed.length !== 32) throw new Error("card_activation_seed_invalid");
    return seed;
  } catch (error) {
    if (error instanceof Error && error.message === "card_activation_seed_invalid") throw error;
    throw new Error("card_activation_seed_decrypt_failed");
  }
}

export function loadCardActivationKeyring(env: NodeJS.ProcessEnv = process.env): CardActivationKeyring | null {
  const raw = env.FRIDAY_RELAY_CARD_ACTIVATION_EXPORT_KEYRING ?? env.CARD_ACTIVATION_EXPORT_KEYRING;
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as { current?: { version?: unknown; key?: unknown }; historical?: Array<{ version?: unknown; key?: unknown }> };
    if (!parsed.current) return null;
    const current = parseKey(parsed.current);
    const historical = (parsed.historical ?? []).map(parseKey);
    if (new Set([current.version, ...historical.map((key) => key.version)]).size !== historical.length + 1) return null;
    return { current, historical };
  } catch {
    return null;
  }
}

export function signCardActivationIntent(codeHash: string, expiresAtEpochSeconds: number, secret: string): string {
  const payload = `${CARD_ACTIVATION_INTENT_VERSION}.${codeHash}.${expiresAtEpochSeconds}`;
  const signature = createHmac("sha256", secret).update(`friday-relay.card-activation-intent.v1\0${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyCardActivationIntent(value: string, secret: string, nowEpochSeconds = Math.floor(Date.now() / 1000)): { codeHash: string; expiresAtEpochSeconds: number } | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== CARD_ACTIVATION_INTENT_VERSION || !/^[0-9a-f]{64}$/u.test(parts[1] ?? "") || !/^\d+$/u.test(parts[2] ?? "") || !parts[3]) return null;
  const codeHash = parts[1]!;
  const expiresPart = parts[2]!;
  const signature = parts[3]!;
  const expiresAtEpochSeconds = Number(expiresPart);
  if (!Number.isSafeInteger(expiresAtEpochSeconds) || expiresAtEpochSeconds <= nowEpochSeconds) return null;
  const expected = signCardActivationIntent(codeHash, expiresAtEpochSeconds, secret).split(".")[3]!;
  const actualBytes = Buffer.from(signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  return { codeHash, expiresAtEpochSeconds };
}

function cardActivationAad(batchId: string): Buffer {
  return Buffer.concat([
    Buffer.from(CARD_ACTIVATION_KEY_PURPOSE, "utf8"),
    Buffer.from([0]),
    Buffer.from(CARD_ACTIVATION_SCHEMA_VERSION, "utf8"),
    Buffer.from([0]),
    Buffer.from(batchId, "utf8"),
  ]);
}

function parseKey(value: { version?: unknown; key?: unknown }): CardActivationKey {
  const version = Number(value.version);
  if (!Number.isSafeInteger(version) || version < 1 || typeof value.key !== "string") throw new Error("card_activation_key_invalid");
  const key = Buffer.from(value.key, "base64url");
  return validateKey({ version, key });
}

function validateKey(value: CardActivationKey): CardActivationKey {
  if (!Number.isSafeInteger(value.version) || value.version < 1 || value.key.length !== 32) throw new Error("card_activation_key_invalid");
  return value;
}
