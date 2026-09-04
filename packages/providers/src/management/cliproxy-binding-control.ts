import { RelayError, type ScopeRef } from "@frely/core";
import type { Provider, ProviderBinding, ApplicationOperationPort } from "@frely/application/runtime";
import { CliProxyControlClient, isConfirmedCliProxyCredentialFailure, type CliProxyControlCredentialSummary, type CliProxyControlModelMapping } from "../cliproxy/control-client.js";
import { validateProviderId } from "../cliproxy/provider-id.js";
import { assertCliProxyKindAuthMethod, type CliProxyAuthMethod } from "../cliproxy/provider-kinds.js";

export function validateCliProxyProviderDefinition(input: {
  id: string;
  kind: string;
  authMethod?: unknown;
  credentialResolver: string;
  modelsResolver: string;
  baseUrlResolver: string;
  configJson: string;
}): { configJson: string; authMethod: CliProxyAuthMethod } | null {
  try {
    validateProviderId(input.id);
  } catch {
    throw new RelayError("cliproxy_provider_id_invalid", "CLIProxyAPI Provider ID is invalid", 400);
  }
  const { authMethod } = assertCliProxyKindAuthMethod(input.kind, input.authMethod);
  const credentialResolver = cliProxyCredentialResolver(authMethod);
  if (input.credentialResolver !== credentialResolver) {
    throw new RelayError("invalid_credential_resolver", `CLIProxyAPI ${authMethod} Providers require ${credentialResolver}`, 400);
  }
  if (input.modelsResolver !== "cliproxyapi:catalog") throw new RelayError("invalid_models_resolver", "CLIProxyAPI Providers require cliproxyapi:catalog", 400);
  if (input.baseUrlResolver !== "literal:") throw new RelayError("invalid_base_url_resolver", "CLIProxyAPI internal URL is deployment controlled", 400);
  return { configJson: JSON.stringify(parsePublicConfig(input.configJson, input.kind, authMethod)), authMethod };
}

export function cliProxyCredentialResolver(authMethod: CliProxyAuthMethod): "api-key:" | "oauth:" | "identity:" {
  if (authMethod === "api-key") return "api-key:";
  if (authMethod === "oauth") return "oauth:";
  if (authMethod === "credential-import") return "identity:";
  throw new RelayError("cliproxy_auth_method_invalid", "CLIProxyAPI Provider Auth Method is invalid", 400);
}

export async function saveStoredCliProxyApiKey(
  repo: ApplicationOperationPort,
  provider: Provider,
  payload: unknown,
  signal?: AbortSignal
): Promise<ProviderBinding> {
  const binding = requiredBinding(repo, provider.id);
  assertCliProxyKindAuthMethod(provider.kind, binding.authMethod);
  if (binding.authMethod !== "api-key") throw new RelayError("provider_credential_type_mismatch", "Provider Auth Method does not accept an API key", 400);
  const apiKey = parseApiKeyPayload(payload);
  const config = parsePublicConfig(provider.configJson, provider.kind, "api-key");
  repo.upsertProviderBinding({ ...binding, syncStatus: "pending", revision: binding.revision + 1 });
  try {
    const result = await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).putApiKey({
      providerId: provider.id,
      kind: provider.kind as Parameters<CliProxyControlClient["putApiKey"]>[0]["kind"],
      apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      models: config.models,
      ...(signal ? { signal } : {})
    });
    return persistReadyBinding(repo, binding, result, binding.revision + 1);
  } catch (error) {
    persistBindingError(repo, binding, stableCode(error), binding.revision + 1);
    throw error;
  }
}

export async function importStoredCliProxyCredential(
  repo: ApplicationOperationPort,
  provider: Provider,
  serviceAccountJson: string,
  location: string,
  signal?: AbortSignal
): Promise<ProviderBinding> {
  const binding = requiredBinding(repo, provider.id);
  const validated = assertCliProxyKindAuthMethod(provider.kind, binding.authMethod);
  if (validated.authMethod !== "credential-import" || validated.kind !== "vertex") throw new RelayError("provider_credential_type_mismatch", "Provider Auth Method does not accept a credential import", 400);
  const revision = binding.revision + 1;
  repo.upsertProviderBinding({ ...binding, syncStatus: "pending", revision });
  try {
    const result = await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).importCredential({ providerId: provider.id, serviceAccountJson, location, ...(signal ? { signal } : {}) });
    return persistReadyBinding(repo, binding, result, revision);
  } catch (error) {
    persistBindingError(repo, binding, stableCode(error), revision);
    throw error;
  }
}

export async function reconcileStoredCliProxyProvider(repo: ApplicationOperationPort, providerId: string, signal?: AbortSignal): Promise<ProviderBinding | null> {
  const provider = requiredProvider(repo, providerId);
  const binding = requiredBinding(repo, providerId);
  if (parseCredentialRefs(binding).length === 0) return binding;
  try {
    await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).reconcile(providerId, signal);
    return persistReconciledBinding(repo, binding, binding.revision);
  } catch (error) {
    return isConfirmedCliProxyCredentialFailure(error)
      ? persistBindingError(repo, binding, stableCode(error), binding.revision)
      : binding;
  }
}

export async function recoverStoredCliProxyProviderBinding(repo: ApplicationOperationPort, providerId: string, signal?: AbortSignal): Promise<ProviderBinding> {
  const provider = requiredProvider(repo, providerId);
  const binding = requiredBinding(repo, providerId);
  const revision = binding.revision + 1;
  repo.upsertProviderBinding({ ...binding, syncStatus: "pending", revision });
  try {
    const control = CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId);
    const recovered = parseCredentialRefs(binding).length === 0
      ? await control.getCredential(providerId, signal)
      : null;
    await control.reconcile(providerId, signal);
    return recovered
      ? persistReadyBinding(repo, binding, recovered, revision)
      : persistReconciledBinding(repo, binding, revision);
  } catch (error) {
    if (isConfirmedCliProxyCredentialFailure(error)) persistBindingError(repo, binding, stableCode(error), revision);
    else repo.upsertProviderBinding(binding);
    throw error;
  }
}

export async function deleteStoredCliProxyProviderBinding(repo: ApplicationOperationPort, provider: Provider, signal?: AbortSignal): Promise<void> {
  const binding = repo.getProviderBinding(provider.id);
  if (!binding || binding.credentialOwnership !== "cpa-managed") return;
  repo.upsertProviderBinding({ ...binding, syncStatus: "pending", revision: binding.revision + 1 });
  try {
    await CliProxyControlClient.fromEnv(process.env, provider.cpaInstanceId).deleteCredential(provider.id, signal);
    repo.upsertProviderBinding({
      ...binding,
      credentialRefsJson: "[]",
      credentialPreview: null,
      revision: binding.revision + 1,
      syncStatus: "cleared"
    });
  } catch (error) {
    persistBindingError(repo, binding, stableCode(error), binding.revision + 1);
    throw error;
  }
}

export async function clearStoredCliProxyProviderCredential(repo: ApplicationOperationPort, provider: Provider, signal?: AbortSignal): Promise<Provider> {
  const disabled = persistProvider(repo, { ...provider, status: "disabled" });
  await deleteStoredCliProxyProviderBinding(repo, disabled, signal);
  return requiredProvider(repo, provider.id);
}

export function cliProxyBindingFailure(state: ProviderBinding | null): RelayError | null {
  if (!state || state.syncStatus !== "error") return null;
  return new RelayError(state.errorCode ?? "cliproxy_binding_error", "CLIProxyAPI Provider binding reconciliation failed", 503);
}

export function safeProviderBinding(binding: ProviderBinding | undefined): Record<string, unknown> | null {
  if (!binding) return null;
  return {
    authMethod: binding.authMethod,
    credentialOwnership: binding.credentialOwnership,
    credentialPreview: binding.credentialPreview,
    revision: binding.revision,
    syncStatus: binding.syncStatus,
    errorCode: binding.errorCode,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt
  };
}

function parsePublicConfig(configJson: string, kind: string, authMethod: CliProxyAuthMethod): { baseUrl?: string; models: CliProxyControlModelMapping[] } {
  const definition = assertCliProxyKindAuthMethod(kind, authMethod);
  let raw: unknown;
  try {
    raw = JSON.parse(configJson);
  } catch {
    throw new RelayError("cliproxy_provider_config_invalid", "CLIProxyAPI Provider public config is invalid", 400);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RelayError("cliproxy_provider_config_invalid", "CLIProxyAPI Provider public config is invalid", 400);
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "baseUrl" && key !== "models")) throw new RelayError("cliproxy_provider_config_invalid", "CLIProxyAPI Provider config contains unsupported fields", 400);
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  if (definition.flow.baseUrlInput === "required" && !baseUrl) throw new RelayError("cliproxy_base_url_required", `${definition.definition.label} Providers require a public base URL`, 400);
  if (definition.flow.baseUrlInput === "hidden" && baseUrl) throw new RelayError("cliproxy_base_url_unsupported", "This CLIProxyAPI credential flow does not accept a base URL", 400);
  const models = authMethod !== "api-key" && (record.models === undefined || (Array.isArray(record.models) && record.models.length === 0))
    ? []
    : parseModelMappings(record.models);
  return { ...(baseUrl ? { baseUrl } : {}), models };
}

function parseModelMappings(value: unknown): CliProxyControlModelMapping[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8192) throw new RelayError("cliproxy_models_invalid", "CLIProxyAPI Provider model mappings must contain between 1 and 8192 entries", 400);
  const aliases = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RelayError("cliproxy_models_invalid", "CLIProxyAPI model mappings are invalid", 400);
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "name" && key !== "alias")) throw new RelayError("cliproxy_models_invalid", "CLIProxyAPI model mappings are invalid", 400);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const alias = typeof record.alias === "string" ? record.alias.trim() : "";
    if (!name || !alias || name.includes("/") || alias.includes("/") || aliases.has(alias)) throw new RelayError("cliproxy_models_invalid", "CLIProxyAPI model mappings are invalid", 400);
    aliases.add(alias);
    return { name, alias };
  });
}

function parseApiKeyPayload(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("provider_credential_invalid", "API key payload is invalid", 400);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "apiKey")) throw new RelayError("provider_credential_invalid", "API key payload is invalid", 400);
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  if (apiKey.length < 8) throw new RelayError("provider_credential_invalid", "API key is required", 400);
  return apiKey;
}

function persistReadyBinding(repo: ApplicationOperationPort, binding: ProviderBinding, result: CliProxyControlCredentialSummary, revision: number): ProviderBinding {
  return repo.upsertProviderBinding({
    ...binding,
    credentialRefsJson: JSON.stringify([result.credentialRef]),
    credentialPreview: result.preview,
    revision,
    syncStatus: "ready"
  });
}

function persistReconciledBinding(repo: ApplicationOperationPort, binding: ProviderBinding, revision: number): ProviderBinding {
  return repo.upsertProviderBinding({ ...binding, revision, syncStatus: "ready" });
}

function persistBindingError(repo: ApplicationOperationPort, binding: ProviderBinding, code: string, revision: number): ProviderBinding {
  return repo.upsertProviderBinding({ ...binding, revision, syncStatus: "error", errorCode: code });
}

function parseCredentialRefs(binding: ProviderBinding): string[] {
  try {
    const value = JSON.parse(binding.credentialRefsJson) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function requiredBinding(repo: ApplicationOperationPort, providerId: string): ProviderBinding {
  const binding = repo.getProviderBinding(providerId);
  if (!binding) throw new RelayError("cliproxy_binding_not_found", "CLIProxyAPI Provider binding is missing", 409);
  return binding;
}

function requiredProvider(repo: ApplicationOperationPort, providerId: string): Provider {
  const provider = repo.getProvider(providerId);
  if (!provider) throw new RelayError("provider_not_found", `Provider ${providerId} not found`, 404);
  return provider;
}

function persistProvider(repo: ApplicationOperationPort, provider: Provider): Provider {
  return repo.upsertProvider({ ...provider, scopeRef: provider.scopeRef as ScopeRef });
}

function stableCode(error: unknown): string {
  if (error instanceof RelayError && /^cliproxy_[a-z0-9_]{1,96}$/.test(error.code)) return error.code;
  return "cliproxy_control_unavailable";
}
