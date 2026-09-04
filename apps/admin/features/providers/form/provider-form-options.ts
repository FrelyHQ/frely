import type { ProviderApiFormat, ProviderAuthMode } from "./provider-form-types";

export function defaultCredentialResolver(authMode: ProviderAuthMode): string {
  return `${authMode}:`;
}

export function authModeFromCredentialResolver(resolver: string): ProviderAuthMode {
  if (resolver === "oauth:") return "oauth";
  if (resolver === "identity:") return "identity";
  return "api-key";
}

export function apiFormatConfig(apiFormat: ProviderApiFormat): Record<string, unknown> {
  return apiFormat === "auto" ? {} : { apiFormat };
}

export function apiFormatFromConfig(config: Record<string, unknown>): ProviderApiFormat {
  const value = config.apiFormat;
  if (value === "openai" || value === "openai-responses" || value === "anthropic") return value;
  return "auto";
}
