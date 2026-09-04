"use client";

import type { ReactNode } from "react";
import type { SearchSelectOption } from "../../../pages/owner/_components/search-select";

export type AuthMode = "api-key" | "oauth" | "identity";
export type ProviderApiFormat = "auto" | "openai" | "openai-responses" | "anthropic";

interface ProviderFormFieldsProps {
  providerIdControl: ReactNode;
  providerIdHelp: string;
  displayNameControl: ReactNode;
  scopeControl: ReactNode;
  scopeHelp: string;
  statusControl: ReactNode;
  statusHelp: string;
  kindControl: ReactNode;
  kindHelp: string;
  apiFormatControl: ReactNode;
  baseUrlResolverControl: ReactNode;
  baseUrlResolverHelp?: string | undefined;
  authModeControl: ReactNode;
  authModeTitle?: string | undefined;
  authModeHelp?: string | undefined;
  credentialResolver: string;
  modelsResolverControl: ReactNode;
  configJsonControl: ReactNode;
  configJsonHelp: string;
}

export function ProviderFormFields({
  providerIdControl,
  providerIdHelp,
  displayNameControl,
  scopeControl,
  scopeHelp,
  statusControl,
  statusHelp,
  kindControl,
  kindHelp,
  apiFormatControl,
  baseUrlResolverControl,
  baseUrlResolverHelp,
  authModeControl,
  authModeTitle,
  authModeHelp,
  credentialResolver,
  modelsResolverControl,
  configJsonControl,
  configJsonHelp
}: ProviderFormFieldsProps) {
  return (
    <div className="form-grid">
      <label>
        Provider ID
        {providerIdControl}
        <span>{providerIdHelp}</span>
      </label>
      <label>
        Display Name
        {displayNameControl}
        <span>Name shown in admin tables.</span>
      </label>
      <label>
        Scope
        {scopeControl}
        <span>{scopeHelp}</span>
      </label>
      <label>
        Status
        {statusControl}
        <span>{statusHelp}</span>
      </label>
      <label>
        Kind
        {kindControl}
        <span>{kindHelp}</span>
      </label>
      <label>
        API Format
        {apiFormatControl}
        <span>Upstream request/response protocol used by this Provider.</span>
      </label>
      <label>
        Base URL Resolver
        {baseUrlResolverControl}
        <span>{baseUrlResolverHelp ?? "How this provider resolves its base URL."}</span>
      </label>
      <label>
        {authModeTitle ?? "Auth Mode"}
        {authModeControl}
        <span>{authModeHelp ?? `Credential resolver: ${credentialResolver}`}</span>
      </label>
      <label>
        Models Resolver
        {modelsResolverControl}
        <span>Use a supported resolver for compatible custom Providers. CLIProxyAPI Providers are managed in their dedicated dialog.</span>
      </label>
      <label>
        Config JSON
        {configJsonControl}
        <span>{configJsonHelp}</span>
      </label>
    </div>
  );
}

export function defaultAuthMode(kind: string, provider?: Pick<ProviderMetadataForAuth, "authModes">): AuthMode {
  return authModesForProvider(kind, provider)[0] ?? "api-key";
}

export function authModesForProvider(kind: string, provider?: Pick<ProviderMetadataForAuth, "authModes">): AuthMode[] {
  if (provider?.authModes?.length) return [...provider.authModes];
  if (kind === "amazon-bedrock") return ["identity"];
  if (kind === "google-vertex") return ["api-key", "identity"];
  return ["api-key"];
}

export function authModeLabel(mode: AuthMode) {
  if (mode === "api-key") return "API Key";
  if (mode === "oauth") return "OAuth";
  return "Cloud Identity";
}

export function defaultCredentialResolver(authMode: AuthMode) {
  return `${authMode}:`;
}

interface ProviderMetadataForAuth {
  authModes: readonly AuthMode[];
}

interface TeamScopeInput {
  id: string;
  name?: string;
  status?: string;
}

interface UserScopeInput {
  id: string;
  email?: string;
  role?: string;
  status?: string;
}

interface ApiKeyScopeInput {
  id: string;
  name?: string;
  keyPrefix?: string;
  status?: string;
}

export function buildProviderScopeOptions({
  teams,
  users,
  apiKeys,
  extraScopeRefs = []
}: {
  teams: TeamScopeInput[];
  users: UserScopeInput[];
  apiKeys: ApiKeyScopeInput[];
  extraScopeRefs?: string[];
}): SearchSelectOption[] {
  const options: SearchSelectOption[] = [
    {
      value: "global:",
      label: "Global",
      description: "Global scope",
      searchText: "global global:",
      className: "scope-global"
    },
    ...teams.map((team) => scopeOption(`team:${team.id}`, `Team / ${team.name ?? team.id}`, `${team.status ?? "team"} (${team.id})`, "scope-team")),
    ...users.map((user) => scopeOption(`user:${user.id}`, `User / ${user.email ?? user.id}`, `${user.role ?? user.status ?? "user"} (${user.id})`, "scope-user")),
    ...apiKeys.map((apiKey) => scopeOption(`key:${apiKey.id}`, `Key / ${apiKey.name ?? apiKey.id}`, `${apiKey.keyPrefix ?? apiKey.status ?? "key"} (${apiKey.id})`, "scope-key"))
  ];
  const seen = new Set(options.map((option) => option.value));
  for (const scopeRef of extraScopeRefs) {
    if (!scopeRef || seen.has(scopeRef)) continue;
    seen.add(scopeRef);
    options.push(scopeOption(scopeRef, scopeRef, "Current or custom scope", ""));
  }
  return options;
}

function scopeOption(value: string, label: string, description: string, className: string): SearchSelectOption {
  return { value, label, description, searchText: `${value} ${label} ${description}`, className };
}
