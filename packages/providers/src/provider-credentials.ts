import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { RelayError, nowIso, resolverParts } from "@frely/core";
import type { Provider } from "@frely/application/runtime";

export type ProviderCredentialType = "api-key" | "oauth" | "identity";

export interface ProviderCredentialEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface ProviderCredentialConfig {
  preview: string;
  encryptedValue: ProviderCredentialEnvelope;
  updatedAt: string;
}

export type ApiKeyCredentialPayload = { apiKey: string };
export type OAuthCredentialPayload = { oauthProvider: string; oauthCredentials: Record<string, unknown> };
export type IdentityCredentialPayload = { provider: string; env: Record<string, string>; config?: Record<string, unknown> };
export type ProviderCredentialPayload = ApiKeyCredentialPayload | OAuthCredentialPayload | IdentityCredentialPayload;

export type ResolvedProviderCredential =
  | { kind: "api-key"; ref: string; apiKey: string }
  | { kind: "oauth"; ref: string; oauthProvider: string; oauthCredentials: Record<string, unknown> }
  | { kind: "identity"; ref: string; env: Record<string, string>; config?: Record<string, unknown> };

export interface ProviderCredentialSummary {
  type: ProviderCredentialType;
  preview: string;
  updatedAt: string;
  status: "configured";
}

const credentialConfigKey = "credential";
const encryptionSalt = "friday-relay.provider-credential.v1";

export function encryptProviderCredential(type: ProviderCredentialType, payload: unknown, updatedAt = nowIso()): ProviderCredentialConfig {
  return encryptProviderCredentialWithSecret(type, payload, requireProviderCredentialSecret(), updatedAt);
}

function encryptProviderCredentialWithSecret(type: ProviderCredentialType, payload: unknown, secret: string, updatedAt = nowIso()): ProviderCredentialConfig {
  const normalizedPayload = normalizeCredentialPayload(type, payload);
  const plaintext = Buffer.from(JSON.stringify(normalizedPayload), "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", providerCredentialKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    preview: credentialPreview(type, normalizedPayload),
    encryptedValue: {
      v: 1,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64")
    },
    updatedAt
  };
}

export function resolveProviderCredential(provider: Provider): ResolvedProviderCredential {
  const { fnName, fnArg } = credentialResolverParts(provider.credentialResolver);
  if ((fnName !== "api-key" && fnName !== "oauth" && fnName !== "identity") || fnArg !== "") {
    throw new RelayError("invalid_credential_resolver", `Unsupported credential resolver ${provider.credentialResolver}`, 400);
  }
  const config = parseProviderConfig(provider.configJson);
  const credentialConfig = parseCredentialConfig(config[credentialConfigKey]);
  if (!credentialConfig) throw new RelayError("provider_credential_missing", `Provider ${provider.id} credential is missing`, 401);
  const payload = decryptProviderCredentialPayload(fnName, credentialConfig);
  const ref = providerCredentialRef(provider.id);
  if (fnName === "api-key") {
    const apiKey = (payload as { apiKey?: unknown }).apiKey;
    if (typeof apiKey !== "string" || !apiKey) throw new RelayError("provider_credential_invalid", "Provider API key credential is invalid", 400);
    return { kind: "api-key", ref, apiKey };
  }
  if (fnName === "oauth") {
    const oauthProvider = (payload as { oauthProvider?: unknown }).oauthProvider;
    const oauthCredentials = (payload as { oauthCredentials?: unknown }).oauthCredentials;
    if (typeof oauthProvider !== "string" || !isRecord(oauthCredentials)) throw new RelayError("provider_credential_invalid", "Provider OAuth credential is invalid", 400);
    return { kind: "oauth", ref, oauthProvider, oauthCredentials };
  }
  const providerName = (payload as { provider?: unknown }).provider;
  const env = (payload as { env?: unknown }).env;
  const extraConfig = (payload as { config?: unknown }).config;
  if (typeof providerName !== "string" || !isStringRecord(env)) throw new RelayError("provider_credential_invalid", "Provider identity credential is invalid", 400);
  return {
    kind: "identity",
    ref,
    env,
    ...(isRecord(extraConfig) ? { config: extraConfig } : {})
  };
}

function credentialResolverParts(resolver: string) {
  try {
    return resolverParts(resolver);
  } catch {
    throw new RelayError("invalid_credential_resolver", `Unsupported credential resolver ${resolver}`, 400);
  }
}

export function setProviderCredentialConfig(configJson: string, credential: ProviderCredentialConfig): string {
  const config = parseProviderConfig(configJson);
  config[credentialConfigKey] = credential;
  return JSON.stringify(config);
}

export function clearProviderCredentialConfig(configJson: string): string {
  const config = parseProviderConfig(configJson);
  delete config[credentialConfigKey];
  return JSON.stringify(config);
}

export function providerCredentialSummary(configJson: string, credentialResolver: string): ProviderCredentialSummary | null {
  const type = credentialTypeFromResolver(credentialResolver);
  const credential = parseCredentialConfig(parseProviderConfig(configJson)[credentialConfigKey]);
  if (!credential) return null;
  return { type, preview: credential.preview, updatedAt: credential.updatedAt, status: "configured" };
}

export function sanitizeProviderConfigJson(configJson: string, credentialResolver: string): string {
  const config = redactSensitiveProviderConfig(parseProviderConfig(configJson));
  const credential = providerCredentialSummary(configJson, credentialResolver);
  if (credential) config[credentialConfigKey] = credential;
  return JSON.stringify(config);
}

export function sanitizeProvider<T extends Provider>(provider: T): T {
  return { ...provider, configJson: sanitizeProviderConfigJson(provider.configJson, provider.credentialResolver) };
}

export function providerCredentialRef(providerId: string): string {
  return `provider:${providerId}`;
}

export function assertSafeProviderConfigInput(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (Array.isArray(value) || typeof value !== "object") throw new RelayError("invalid_provider_config", "Provider config must be an object", 400);
  const config = value as Record<string, unknown>;
  if (containsSensitiveProviderConfig(config)) {
    throw new RelayError("provider_config_credential_not_allowed", "Provider credentials are not allowed in provider config", 400);
  }
  return config;
}

export function mergeConfigPreservingCredential(existingConfigJson: string | undefined, inputConfig: Record<string, unknown>): string {
  const nextConfig = { ...inputConfig };
  const existingCredential = parseProviderConfig(existingConfigJson)[credentialConfigKey];
  if (existingCredential !== undefined) nextConfig[credentialConfigKey] = existingCredential;
  return JSON.stringify(nextConfig);
}

export function decryptProviderCredentialPayload(type: ProviderCredentialType, credential: ProviderCredentialConfig): ProviderCredentialPayload {
  return decryptProviderCredentialPayloadWithSecret(type, credential, requireProviderCredentialSecret());
}

function decryptProviderCredentialPayloadWithSecret(type: ProviderCredentialType, credential: ProviderCredentialConfig, secret: string): ProviderCredentialPayload {
  const key = providerCredentialKey(secret);
  try {
    const envelope = credential.encryptedValue;
    assertCredentialEnvelope(envelope);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
    return normalizeCredentialPayload(type, JSON.parse(plaintext.toString("utf8")) as unknown);
  } catch {
    throw new RelayError("provider_credential_decrypt_failed", "Provider credential could not be decrypted", 401);
  }
}

function requireProviderCredentialSecret(): string {
  const secret = process.env.FRIDAY_RELAY_SECRET_KEY;
  if (!secret) throw new RelayError("provider_credential_key_required", "FRIDAY_RELAY_SECRET_KEY is required for provider credentials", 500);
  return secret;
}

function providerCredentialKey(secret: string): Buffer {
  return scryptSync(secret, encryptionSalt, 32);
}

function parseProviderConfig(configJson: string | undefined): Record<string, unknown> {
  if (!configJson) return {};
  try {
    const parsed = JSON.parse(configJson) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseCredentialConfig(value: unknown): ProviderCredentialConfig | null {
  if (!isRecord(value)) return null;
  const encryptedValue = value.encryptedValue;
  if (!isRecord(encryptedValue)) return null;
  if (typeof value.preview !== "string" || typeof value.updatedAt !== "string") return null;
  if (encryptedValue.v !== 1 || encryptedValue.alg !== "aes-256-gcm" || typeof encryptedValue.iv !== "string" || typeof encryptedValue.ciphertext !== "string" || typeof encryptedValue.tag !== "string") return null;
  return {
    preview: value.preview,
    encryptedValue: encryptedValue as unknown as ProviderCredentialEnvelope,
    updatedAt: value.updatedAt
  };
}

function credentialConfigWithEncryptedValue(configJson: string): ProviderCredentialConfig | null {
  const config = parseProviderConfig(configJson);
  const rawCredential = config[credentialConfigKey];
  if (!isRecord(rawCredential) || !isRecord(rawCredential.encryptedValue)) return null;
  const credential = parseCredentialConfig(rawCredential);
  if (!credential) throw new RelayError("provider_credential_invalid", "Provider credential config is invalid", 400);
  return credential;
}

function normalizeCredentialPayload(type: ProviderCredentialType, payload: unknown): ProviderCredentialPayload {
  if (!isRecord(payload)) throw new RelayError("provider_credential_invalid", "Provider credential payload must be an object", 400);
  if (type === "api-key") {
    const apiKey = payload.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new RelayError("provider_credential_invalid", "Provider API key is required", 400);
    return { apiKey };
  }
  if (type === "oauth") {
    const oauthProvider = payload.oauthProvider;
    const oauthCredentials = payload.oauthCredentials;
    if (typeof oauthProvider !== "string" || !oauthProvider.trim() || !isRecord(oauthCredentials)) throw new RelayError("provider_credential_invalid", "Provider OAuth credentials are required", 400);
    return { oauthProvider, oauthCredentials };
  }
  const provider = payload.provider;
  const env = payload.env;
  const config = payload.config;
  if (typeof provider !== "string" || !provider.trim() || !isStringRecord(env)) throw new RelayError("provider_credential_invalid", "Provider identity env is required", 400);
  return {
    provider,
    env,
    ...(isRecord(config) ? { config } : {})
  };
}

function credentialPreview(type: ProviderCredentialType, payload: ProviderCredentialPayload): string {
  if (type === "api-key") {
    const apiKey = (payload as ApiKeyCredentialPayload).apiKey;
    if (apiKey.length <= 8) return "[configured]";
    return `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`;
  }
  if (type === "oauth") {
    return `${(payload as OAuthCredentialPayload).oauthProvider} connected`;
  }
  const identity = payload as IdentityCredentialPayload;
  const region = identity.env.AWS_REGION ?? identity.env.GOOGLE_CLOUD_LOCATION;
  return region ? `${identity.provider}:${region}` : identity.provider;
}

function containsSensitiveProviderConfig(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveProviderConfig);
  if (!isRecord(value)) return false;
  if (isServiceAccountDocument(value)) return true;
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveProviderConfigKey(key) || containsSensitiveProviderConfig(child)) return true;
  }
  return false;
}

function isSensitiveProviderConfigKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return compact === "identity"
    || compact === "encryptedvalue"
    || compact === "serviceaccount"
    || compact === "serviceaccountjson"
    || compact === "clientemail"
    || sensitiveProviderConfigFilePathKeyPattern.test(compact)
    || compact === "connectionstring"
    || compact === "databaseurl"
    || compact === "dsn"
    || compact === "code"
    || compact === "state"
    || compact === "codeverifier"
    || compact === "pkceverifier"
    || compact === "oauthcode"
    || compact === "oauthstate"
    || compact === "oauthnonce"
    || compact === "oidcnonce"
    || compact === "clientassertion"
    || compact === "jwt"
    || compact === "token"
    || sensitiveProviderConfigMaterialKeyPattern.test(compact)
    || compact.endsWith("accesskeyid")
    || compact.includes("authorization")
    || compact.includes("credential")
    || compact.includes("password")
    || compact.includes("secret");
}

const sensitiveProviderConfigMaterialKeyPattern = /(?:token|apikey|privatekey|signingkey|passphrase)(?:value|file|filepath|path|pem|pemfile|json|key|secret|material|contents?|data|base64|bytes)?$/u;
const sensitiveProviderConfigFilePathKeyPattern = /^(?:auth|serviceaccount)(?:file(?:name|path)?|path)$/u;

function redactSensitiveProviderConfig(value: Record<string, unknown>): Record<string, unknown> {
  if (isServiceAccountDocument(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => (
    isSensitiveProviderConfigKey(key)
      ? []
      : [[key, redactSensitiveProviderConfigValue(child)]]
  )));
}

function redactSensitiveProviderConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveProviderConfigValue);
  return isRecord(value) ? redactSensitiveProviderConfig(value) : value;
}

function isServiceAccountDocument(value: Record<string, unknown>): boolean {
  const entries = Object.entries(value);
  const type = entries.find(([key]) => compactProviderConfigKey(key) === "type")?.[1];
  if (typeof type === "string" && compactProviderConfigKey(type) === "serviceaccount") return true;
  const keys = new Set(entries.map(([key]) => compactProviderConfigKey(key)));
  return keys.has("projectid")
    && keys.has("tokenuri")
    && (keys.has("privatekey") || keys.has("clientemail"));
}

function compactProviderConfigKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function credentialTypeFromResolver(resolver: string): ProviderCredentialType {
  const { fnName, fnArg } = credentialResolverParts(resolver);
  if ((fnName === "api-key" || fnName === "oauth" || fnName === "identity") && fnArg === "") return fnName;
  throw new RelayError("invalid_credential_resolver", `Unsupported credential resolver ${resolver}`, 400);
}

function assertCredentialEnvelope(envelope: ProviderCredentialEnvelope): void {
  if (envelope.v !== 1 || envelope.alg !== "aes-256-gcm") throw new Error("Unsupported envelope");
  const fields = [envelope.iv, envelope.ciphertext, envelope.tag];
  if (fields.some((field) => typeof field !== "string" || field.length === 0)) throw new Error("Invalid envelope");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
