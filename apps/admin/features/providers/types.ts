import type { AuthMode } from "./form/provider-form-fields";

export interface BuiltinProviderMetadata {
  id: "cliproxy";
  label: "CLIProxyAPI";
  authModes: readonly AuthMode[];
  description: string;
}

export const CLI_PROXY_PROVIDER_METADATA: BuiltinProviderMetadata = {
  id: "cliproxy",
  label: "CLIProxyAPI",
  authModes: ["api-key"],
  description: "Deployment-managed CLIProxyAPI transport with Provider-scoped credential isolation."
};

export interface ProviderSummary {
  id: string;
}

export interface TeamSummary {
  id: string;
  name: string;
  status: string;
}

export interface AdminSession {
  userId: string;
  email: string;
}

export interface ProviderDialogData {
  teams: TeamSummary[];
  session: AdminSession;
}

export interface UserCandidate {
  id: string;
  email: string;
  status: string;
}

export interface ApiKeyCandidate {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  status: string;
}

export interface ProviderModelRecord {
  id: string;
  providerId: string;
  providerModelName: string;
  displayName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRecord {
  id: string;
  scopeRef: string;
  name: string;
  kind: string;
  status: string;
  configJson: string;
  modelCount?: number;
  models?: ProviderModelRecord[];
  binding: {
    authMethod: "oauth" | "api-key" | "credential-import";
    credentialOwnership: "cpa-managed" | "linked";
    credentialPreview: string | null;
    revision: number;
    syncStatus: "pending" | "ready" | "error" | "cleared";
    errorCode: string | null;
    updatedAt: string;
  } | null;
}
