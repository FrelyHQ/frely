import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CliProxyProviderKind } from "@frely/providers";

const AAD = Buffer.from("friday-relay:cliproxy-control:credentials:v1", "utf8");

export interface StoredModelMapping {
  name: string;
  alias: string;
}

export interface StoredCredentialPublicConfig {
  baseUrl?: string;
  models: StoredModelMapping[];
}

export interface StoredCredential {
  ref: string;
  providerId: string;
  kind: CliProxyProviderKind;
  authMethod: "api-key" | "oauth" | "credential-import";
  apiKey?: string;
  authFileName?: string;
  config: StoredCredentialPublicConfig;
  createdAt: string;
  updatedAt: string;
}

interface StorePayload {
  version: 1;
  credentials: StoredCredential[];
}

interface EncryptedEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export class CredentialStore {
  readonly #path: string;
  readonly #key: Buffer;
  #payload: StorePayload = { version: 1, credentials: [] };

  constructor(path: string, key: Buffer) {
    if (key.byteLength !== 32) throw new Error("cliproxy_control_store_key_invalid");
    this.#path = path;
    this.#key = Buffer.from(key);
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    let encoded: string;
    try {
      encoded = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.#payload = decryptPayload(encoded, this.#key);
  }

  async repairOAuthModelPrefixes(): Promise<number> {
    let repaired = 0;
    const credentials = this.#payload.credentials.map((credential) => {
      if (credential.authMethod !== "oauth" && credential.authMethod !== "credential-import") return credential;
      const prefix = `${credential.providerId}/`;
      const aliases = new Set<string>();
      const models = credential.config.models.map((model) => {
        const name = model.name.startsWith(prefix) ? model.name.slice(prefix.length) : model.name;
        const alias = model.alias.startsWith(prefix) ? model.alias.slice(prefix.length) : model.alias;
        if (name !== model.name || alias !== model.alias) repaired += 1;
        if (!name || !alias || name.includes("/") || alias.includes("/") || aliases.has(alias)) throw new Error("cliproxy_control_store_invalid");
        aliases.add(alias);
        return { name, alias };
      });
      return { ...credential, config: { ...credential.config, models } };
    });
    if (repaired > 0) await this.#replace({ version: 1, credentials });
    return repaired;
  }

  list(): readonly StoredCredential[] {
    return this.#payload.credentials.map(cloneCredential);
  }

  get(providerId: string): StoredCredential | undefined {
    const value = this.#payload.credentials.find((entry) => entry.providerId === providerId);
    return value ? cloneCredential(value) : undefined;
  }

  async upsert(input: Omit<StoredCredential, "ref" | "createdAt" | "updatedAt"> & { ref?: string }): Promise<StoredCredential> {
    const now = new Date().toISOString();
    const existing = this.#payload.credentials.find((entry) => entry.providerId === input.providerId);
    const value: StoredCredential = {
      ...input,
      config: clonePublicConfig(input.config),
      ref: input.ref ?? existing?.ref ?? `cpa_cred_${randomBytes(18).toString("base64url")}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const credentials = this.#payload.credentials.filter((entry) => entry.providerId !== input.providerId);
    credentials.push(value);
    credentials.sort((left, right) => left.providerId.localeCompare(right.providerId));
    await this.#replace({ version: 1, credentials });
    return cloneCredential(value);
  }

  async delete(providerId: string): Promise<StoredCredential | undefined> {
    const existing = this.#payload.credentials.find((entry) => entry.providerId === providerId);
    if (!existing) return undefined;
    await this.#replace({ version: 1, credentials: this.#payload.credentials.filter((entry) => entry.providerId !== providerId) });
    return cloneCredential(existing);
  }

  async restore(value: StoredCredential): Promise<void> {
    const credentials = this.#payload.credentials.filter((entry) => entry.providerId !== value.providerId);
    credentials.push(cloneCredential(value));
    credentials.sort((left, right) => left.providerId.localeCompare(right.providerId));
    await this.#replace({ version: 1, credentials });
  }

  async #replace(payload: StorePayload): Promise<void> {
    const encoded = encryptPayload(payload, this.#key);
    const tempPath = `${this.#path}.tmp`;
    await writeFile(tempPath, encoded, { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, this.#path);
    this.#payload = payload;
  }
}

export function parseStoreKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("cliproxy_control_store_key_required");
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const value = Buffer.from(raw, "base64");
  if (value.byteLength !== 32) throw new Error("cliproxy_control_store_key_invalid");
  return value;
}

function encryptPayload(payload: StorePayload, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
  return `${JSON.stringify(envelope)}\n`;
}

function decryptPayload(encoded: string, key: Buffer): StorePayload {
  const envelope = JSON.parse(encoded) as Partial<EncryptedEnvelope>;
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm" || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("cliproxy_control_store_invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
  const payload = JSON.parse(plaintext) as Partial<StorePayload>;
  if (payload.version !== 1 || !Array.isArray(payload.credentials)) throw new Error("cliproxy_control_store_invalid");
  return { version: 1, credentials: payload.credentials.map(parseStoredCredential) };
}

function parseStoredCredential(value: unknown): StoredCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cliproxy_control_store_invalid");
  const entry = value as StoredCredential;
  if (typeof entry.ref !== "string" || typeof entry.providerId !== "string" || typeof entry.kind !== "string" || typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") {
    throw new Error("cliproxy_control_store_invalid");
  }
  const authMethod = entry.authMethod ?? (typeof entry.apiKey === "string" ? "api-key" : undefined);
  if (authMethod !== "api-key" && authMethod !== "oauth" && authMethod !== "credential-import") throw new Error("cliproxy_control_store_invalid");
  if (authMethod === "api-key" && typeof entry.apiKey !== "string") throw new Error("cliproxy_control_store_invalid");
  if ((authMethod === "oauth" || authMethod === "credential-import") && typeof entry.authFileName !== "string") throw new Error("cliproxy_control_store_invalid");
  return { ...entry, authMethod, config: clonePublicConfig(entry.config) };
}

function cloneCredential(value: StoredCredential): StoredCredential {
  return { ...value, config: clonePublicConfig(value.config) };
}

function clonePublicConfig(value: StoredCredentialPublicConfig): StoredCredentialPublicConfig {
  return { ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}), models: value.models.map((model) => ({ ...model })) };
}
