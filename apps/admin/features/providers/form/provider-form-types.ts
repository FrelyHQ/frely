export type ProviderAuthMode = "api-key" | "oauth" | "identity";
export type ProviderApiFormat = "auto" | "openai" | "openai-responses" | "anthropic";
export type ProviderStatus = "enabled" | "disabled";

export interface ProviderFormValues {
  id: string;
  scopeRef: string;
  name: string;
  kind: string;
  status: ProviderStatus;
  apiFormat: ProviderApiFormat;
  authMode: ProviderAuthMode;
  baseUrlResolver: string;
  modelsResolver: string;
  configJson: string;
  apiKey: string;
  identityJson: string;
}

export interface ProviderEditSource {
  id: string;
  scopeRef: string;
  name: string;
  kind: string;
  status: string;
  baseUrlResolver: string;
  credentialResolver: string;
  modelsResolver: string;
  configJson: string;
}

export interface CreateProviderInput {
  id: string;
  scopeRef: string;
  name: string;
  kind: string;
  baseUrlResolver: string;
  credentialResolver: string;
  modelsResolver: string;
  config: Record<string, unknown>;
}

export interface UpdateProviderInput extends CreateProviderInput {
  status: ProviderStatus;
}

export type ProviderFormConversion<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; field?: keyof ProviderFormValues };
