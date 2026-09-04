import { RelayError } from "@frely/core";

export const CLI_PROXY_PROVIDER_KINDS = [
  "codex",
  "gemini",
  "claude",
  "antigravity",
  "kimi",
  "xai",
  "openai-compatible",
  "vertex"
] as const;

export const CPA_PROVIDER_CAPABILITY_VERSION = "v7.2.145" as const;

export type CliProxyProviderKind = (typeof CLI_PROXY_PROVIDER_KINDS)[number];
export type CliProxyAuthMethod = "oauth" | "api-key" | "credential-import";
export type CliProxyCredentialForm = "oauth" | "api-key" | "credential-import";
export type CliProxyBaseUrlInput = "hidden" | "optional" | "required";
export type CliProxyApiKeyManagementPath = "codex-api-key" | "gemini-api-key" | "claude-api-key" | "xai-api-key" | "openai-compatibility" | "vertex-api-key";
export type CliProxyOAuthManagementPath = "codex-auth-url" | "anthropic-auth-url" | "antigravity-auth-url" | "kimi-auth-url" | "xai-auth-url";

export interface CliProxyEnabledFlow {
  id: string;
  label: string;
  authMethod: CliProxyAuthMethod;
  form: CliProxyCredentialForm;
  baseUrlInput: CliProxyBaseUrlInput;
  exposure: "enabled";
  managementPath: CliProxyApiKeyManagementPath | CliProxyOAuthManagementPath | "vertex/import";
}

export interface CliProxyBlockedCapability {
  id: string;
  label: string;
  authMethod: CliProxyAuthMethod;
  form: CliProxyCredentialForm;
  baseUrlInput: CliProxyBaseUrlInput;
  exposure: "blocked";
  managementPath: string;
  reasonCode: string;
  reason: string;
}

export interface CliProxyKindDefinition {
  cpaVersion: typeof CPA_PROVIDER_CAPABILITY_VERSION;
  kind: CliProxyProviderKind;
  label: string;
  flows: readonly CliProxyEnabledFlow[];
  authMethods: readonly CliProxyAuthMethod[];
  apiKeyManagementPath?: CliProxyApiKeyManagementPath;
  oauthManagementPath?: CliProxyOAuthManagementPath;
}

const flow = (value: CliProxyEnabledFlow): CliProxyEnabledFlow => Object.freeze(value);

export const CLI_PROXY_KIND_DEFINITIONS: Readonly<Record<CliProxyProviderKind, CliProxyKindDefinition>> = Object.freeze({
  codex: kind("codex", "OpenAI / Codex-compatible", [
    flow({ id: "codex-oauth", label: "OAuth", authMethod: "oauth", form: "oauth", baseUrlInput: "hidden", exposure: "enabled", managementPath: "codex-auth-url" }),
    flow({ id: "codex-api-key", label: "API Key", authMethod: "api-key", form: "api-key", baseUrlInput: "optional", exposure: "enabled", managementPath: "codex-api-key" })
  ]),
  gemini: kind("gemini", "Gemini / Gemini-compatible", [
    flow({ id: "gemini-api-key", label: "API Key", authMethod: "api-key", form: "api-key", baseUrlInput: "optional", exposure: "enabled", managementPath: "gemini-api-key" })
  ]),
  claude: kind("claude", "Claude / Anthropic-compatible", [
    flow({ id: "claude-oauth", label: "OAuth", authMethod: "oauth", form: "oauth", baseUrlInput: "hidden", exposure: "enabled", managementPath: "anthropic-auth-url" }),
    flow({ id: "claude-api-key", label: "API Key", authMethod: "api-key", form: "api-key", baseUrlInput: "optional", exposure: "enabled", managementPath: "claude-api-key" })
  ]),
  antigravity: kind("antigravity", "Antigravity", [
    flow({ id: "antigravity-oauth", label: "OAuth", authMethod: "oauth", form: "oauth", baseUrlInput: "hidden", exposure: "enabled", managementPath: "antigravity-auth-url" })
  ]),
  kimi: kind("kimi", "Kimi", [
    flow({ id: "kimi-oauth", label: "OAuth", authMethod: "oauth", form: "oauth", baseUrlInput: "hidden", exposure: "enabled", managementPath: "kimi-auth-url" })
  ]),
  xai: kind("xai", "xAI / Grok-compatible", [
    flow({ id: "xai-oauth", label: "OAuth", authMethod: "oauth", form: "oauth", baseUrlInput: "hidden", exposure: "enabled", managementPath: "xai-auth-url" }),
    flow({ id: "xai-api-key", label: "API Key", authMethod: "api-key", form: "api-key", baseUrlInput: "optional", exposure: "enabled", managementPath: "xai-api-key" })
  ]),
  "openai-compatible": kind("openai-compatible", "OpenAI-compatible", [
    flow({ id: "openai-compatible-api-key", label: "API Key", authMethod: "api-key", form: "api-key", baseUrlInput: "required", exposure: "enabled", managementPath: "openai-compatibility" })
  ]),
  vertex: kind("vertex", "Vertex / Vertex-compatible", [
    flow({ id: "vertex-api-key", label: "API Key", authMethod: "api-key", form: "api-key", baseUrlInput: "optional", exposure: "enabled", managementPath: "vertex-api-key" }),
    flow({ id: "vertex-credential-import", label: "Service Account Import", authMethod: "credential-import", form: "credential-import", baseUrlInput: "hidden", exposure: "enabled", managementPath: "vertex/import" })
  ])
});

export const CLI_PROXY_BLOCKED_CAPABILITIES: readonly CliProxyBlockedCapability[] = Object.freeze([
  Object.freeze({
    id: "gemini-interactions-api-key",
    label: "Gemini Interactions API Key",
    authMethod: "api-key",
    form: "api-key",
    baseUrlInput: "optional",
    exposure: "blocked",
    managementPath: "interactions-api-key",
    reasonCode: "public_interactions_gateway_unavailable",
    reason: "Frely does not expose a public Interactions Gateway path."
  })
]);

export interface ProviderOnboardingUiFlow {
  id: string;
  label: string;
  authMethod: CliProxyAuthMethod;
  form: CliProxyCredentialForm;
  baseUrlInput: CliProxyBaseUrlInput;
}

export interface ProviderOnboardingUiOption {
  value: CliProxyProviderKind;
  label: string;
  flows: ProviderOnboardingUiFlow[];
}

export interface ProviderOnboardingUiCapabilities {
  version: typeof CPA_PROVIDER_CAPABILITY_VERSION;
  options: ProviderOnboardingUiOption[];
  blocked: Array<{ id: string; label: string; reasonCode: string; reason: string }>;
}

export function providerOnboardingUiCapabilities(): ProviderOnboardingUiCapabilities {
  return {
    version: CPA_PROVIDER_CAPABILITY_VERSION,
    options: CLI_PROXY_PROVIDER_KINDS.map((providerKind) => {
      const definition = CLI_PROXY_KIND_DEFINITIONS[providerKind];
      return {
        value: providerKind,
        label: definition.label,
        flows: definition.flows.map(({ id, label, authMethod, form, baseUrlInput }) => ({ id, label, authMethod, form, baseUrlInput }))
      };
    }),
    blocked: CLI_PROXY_BLOCKED_CAPABILITIES.map(({ id, label, reasonCode, reason }) => ({ id, label, reasonCode, reason }))
  };
}

export function isCliProxyProviderKind(value: unknown): value is CliProxyProviderKind {
  return typeof value === "string" && (CLI_PROXY_PROVIDER_KINDS as readonly string[]).includes(value);
}

export function assertCliProxyKindAuthMethod(kindValue: unknown, authMethodValue: unknown): { kind: CliProxyProviderKind; authMethod: CliProxyAuthMethod; definition: CliProxyKindDefinition; flow: CliProxyEnabledFlow } {
  if (!isCliProxyProviderKind(kindValue)) throw new RelayError("cliproxy_kind_unsupported", "CLIProxyAPI Provider kind is not supported", 400);
  if (authMethodValue !== "oauth" && authMethodValue !== "api-key" && authMethodValue !== "credential-import") {
    throw new RelayError("cliproxy_auth_method_unsupported", "CLIProxyAPI Auth Method is not supported", 400);
  }
  const definition = CLI_PROXY_KIND_DEFINITIONS[kindValue];
  const selectedFlow = definition.flows.find((candidate) => candidate.authMethod === authMethodValue);
  if (!selectedFlow) throw new RelayError("cliproxy_auth_method_unsupported", `Auth Method ${authMethodValue} is not supported for ${kindValue}`, 400);
  return { kind: kindValue, authMethod: authMethodValue, definition, flow: selectedFlow };
}

function kind(kindValue: CliProxyProviderKind, label: string, flows: readonly CliProxyEnabledFlow[]): CliProxyKindDefinition {
  return Object.freeze({
    cpaVersion: CPA_PROVIDER_CAPABILITY_VERSION,
    kind: kindValue,
    label,
    flows: Object.freeze([...flows]),
    authMethods: Object.freeze(flows.map((candidate) => candidate.authMethod)),
    ...apiKeyPath(flows),
    ...oauthPath(flows)
  });
}

function apiKeyPath(flows: readonly CliProxyEnabledFlow[]): { apiKeyManagementPath?: CliProxyApiKeyManagementPath } {
  const path = flows.find((candidate) => candidate.authMethod === "api-key")?.managementPath;
  return path && path !== "vertex/import" ? { apiKeyManagementPath: path as CliProxyApiKeyManagementPath } : {};
}

function oauthPath(flows: readonly CliProxyEnabledFlow[]): { oauthManagementPath?: CliProxyOAuthManagementPath } {
  const path = flows.find((candidate) => candidate.authMethod === "oauth")?.managementPath;
  return path ? { oauthManagementPath: path as CliProxyOAuthManagementPath } : {};
}
