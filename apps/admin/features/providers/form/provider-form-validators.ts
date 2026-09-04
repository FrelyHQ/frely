import type { ProviderFormValues } from "./provider-form-types";

export function requiredProviderValue(value: string, label: string): string | undefined {
  return value.trim() ? undefined : `${label} is required.`;
}

export function validateProviderConfigJson(value: string): string | undefined {
  const parsed = parseProviderConfigJson(value);
  return parsed.ok ? undefined : parsed.message;
}

export function parseProviderConfigJson(value: string):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    return { ok: false, message: "Config JSON is not valid JSON." };
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return { ok: false, message: "Config JSON must be an object." };
  }
  if (containsSensitiveProviderConfig(parsed)) {
    return {
      ok: false,
      message: "Provider credentials and secrets are not allowed in Config JSON. Use the Credential section instead."
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export function validateProviderIdentityJson(value: string): string | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && !Array.isArray(parsed) && typeof parsed === "object"
      ? undefined
      : "Identity JSON must be an object.";
  } catch {
    return "Identity JSON is not valid JSON.";
  }
}

export function validateProviderFormValues(values: ProviderFormValues): Partial<Record<keyof ProviderFormValues, string>> {
  const errors: Partial<Record<keyof ProviderFormValues, string>> = {};
  for (const [field, label] of [
    ["id", "Provider ID"],
    ["name", "Display Name"],
    ["scopeRef", "Scope"],
    ["kind", "Kind"],
    ["baseUrlResolver", "Base URL Resolver"],
    ["modelsResolver", "Models Resolver"]
  ] as const) {
    const error = requiredProviderValue(values[field], label);
    if (error) errors[field] = error;
  }
  const configError = validateProviderConfigJson(values.configJson);
  if (configError) errors.configJson = configError;
  if (values.authMode === "identity") {
    const identityError = validateProviderIdentityJson(values.identityJson);
    if (identityError) errors.identityJson = identityError;
  }
  return errors;
}

export function containsSensitiveProviderConfig(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveProviderConfig);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (isServiceAccountDocument(record)) return true;
  return Object.entries(record).some(([key, child]) => (
    isSensitiveProviderConfigKey(key) || containsSensitiveProviderConfig(child)
  ));
}

export function isSensitiveProviderConfigKey(key: string): boolean {
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

export function isServiceAccountDocument(value: Record<string, unknown>): boolean {
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
