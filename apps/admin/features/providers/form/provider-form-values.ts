import {
  apiFormatConfig,
  apiFormatFromConfig,
  authModeFromCredentialResolver,
  defaultCredentialResolver
} from "./provider-form-options";
import type {
  CreateProviderInput,
  ProviderEditSource,
  ProviderFormConversion,
  ProviderFormValues,
  ProviderStatus,
  UpdateProviderInput
} from "./provider-form-types";
import {
  isSensitiveProviderConfigKey,
  isServiceAccountDocument,
  parseProviderConfigJson,
  validateProviderFormValues,
} from "./provider-form-validators";

export interface CreateProviderDefaults {
  id?: string;
  scopeRef?: string;
  name?: string;
  kind?: string;
  baseUrlResolver?: string;
}

export function createProviderFormDefaults(defaults: CreateProviderDefaults = {}): ProviderFormValues {
  return {
    id: defaults.id ?? "",
    scopeRef: defaults.scopeRef ?? "",
    name: defaults.name ?? "Provider",
    kind: defaults.kind ?? "openai-compatible",
    status: "disabled",
    apiFormat: "auto",
    authMode: "api-key",
    baseUrlResolver: defaults.baseUrlResolver ?? "literal:",
    modelsResolver: "provider:path:/models",
    configJson: "{}",
    apiKey: "",
    identityJson: defaultIdentityJson
  };
}

export function editProviderFormDefaults(provider: ProviderEditSource): ProviderFormValues {
  const config = publicConfigFromJson(provider.configJson);
  return {
    id: provider.id,
    scopeRef: provider.scopeRef,
    name: provider.name,
    kind: provider.kind,
    status: normalizeStatus(provider.status),
    apiFormat: apiFormatFromConfig(config),
    authMode: authModeFromCredentialResolver(provider.credentialResolver),
    baseUrlResolver: provider.baseUrlResolver,
    modelsResolver: provider.modelsResolver,
    configJson: JSON.stringify(config, null, 2),
    // Existing secrets are deliberately never copied into edit defaults.
    apiKey: "",
    identityJson: ""
  };
}

export function toCreateProviderInput(values: ProviderFormValues): ProviderFormConversion<CreateProviderInput> {
  return toProviderInput(values, false);
}

export function toUpdateProviderInput(values: ProviderFormValues): ProviderFormConversion<UpdateProviderInput> {
  return toProviderInput(values, true);
}

function toProviderInput(values: ProviderFormValues, includeStatus: false): ProviderFormConversion<CreateProviderInput>;
function toProviderInput(values: ProviderFormValues, includeStatus: true): ProviderFormConversion<UpdateProviderInput>;
function toProviderInput(
  values: ProviderFormValues,
  includeStatus: boolean
): ProviderFormConversion<CreateProviderInput | UpdateProviderInput> {
  const errors = validateProviderFormValues(values);
  const firstError = Object.entries(errors)[0] as [keyof ProviderFormValues, string] | undefined;
  if (firstError) return { ok: false, field: firstError[0], message: firstError[1] };

  const parsedConfig = parseProviderConfigJson(values.configJson);
  if (!parsedConfig.ok) return { ok: false, field: "configJson", message: parsedConfig.message };
  const config = { ...parsedConfig.value };
  if (values.apiFormat === "auto") delete config.apiFormat;
  else Object.assign(config, apiFormatConfig(values.apiFormat));

  const input: CreateProviderInput = {
    id: values.id.trim(),
    scopeRef: values.scopeRef.trim(),
    name: values.name.trim(),
    kind: values.kind.trim(),
    baseUrlResolver: values.baseUrlResolver.trim(),
    credentialResolver: defaultCredentialResolver(values.authMode),
    modelsResolver: values.modelsResolver.trim(),
    config
  };
  return includeStatus
    ? { ok: true, value: { ...input, status: normalizeStatus(values.status) } }
    : { ok: true, value: input };
}

function publicConfigFromJson(configJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson || "{}") as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {};
    return removeCredentialMetadata(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

function removeCredentialMetadata(config: Record<string, unknown>): Record<string, unknown> {
  if (isServiceAccountDocument(config)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSensitiveConfigKey(key)) continue;
    result[key] = Array.isArray(value)
      ? value.map((item) => item && typeof item === "object" && !Array.isArray(item)
        ? removeCredentialMetadata(item as Record<string, unknown>)
        : item)
      : value && typeof value === "object"
        ? removeCredentialMetadata(value as Record<string, unknown>)
        : value;
  }
  return result;
}

function isSensitiveConfigKey(key: string): boolean {
  return isSensitiveProviderConfigKey(key);
}

function normalizeStatus(status: string): ProviderStatus {
  return status === "enabled" ? "enabled" : "disabled";
}

const defaultIdentityJson = JSON.stringify({
  provider: "amazon-bedrock",
  env: { AWS_REGION: "us-east-1" }
}, null, 2);
