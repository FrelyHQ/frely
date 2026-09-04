import * as GatewayCore from "@frely/gateway-core";
import type { UiSyncQueryPort } from "@frely/ui-application/contracts";
import type { IngressPluginConfigField, IngressPluginSettingView } from "../types";

export const GLOBAL_PLUGIN_SCOPE = "global:" as const;

type RegistryPlugin = {
  id: string;
  desc: string;
  version: number;
  defaultConfig: Record<string, unknown>;
  configUi: readonly IngressPluginConfigField[];
};

export type StoredIngressPluginSetting = {
  id?: string;
  pluginId: string;
  scopeRef: string;
  enabled: boolean | number;
  config?: Record<string, unknown>;
  configJson?: Record<string, unknown> | string;
  updatedAt?: string | Date | null;
  updatedByUserId?: string | null;
};

type IngressPluginSettingsApplicationOperationPort = {
  getIngressPluginSetting(pluginId: string, scopeRef: string): StoredIngressPluginSetting | null | undefined;
  upsertIngressPluginSetting(input: {
    pluginId: string;
    scopeRef: string;
    enabled: boolean;
    config: Record<string, unknown>;
    updatedByUserId: string;
  }): StoredIngressPluginSetting;
};

export function ingressPluginSettingsRepo(repo: UiSyncQueryPort): IngressPluginSettingsApplicationOperationPort {
  const raw = repo as unknown as {
    getIngressPluginSetting(pluginId: string, scopeRef: string): StoredIngressPluginSetting | null | undefined;
    upsertIngressPluginSetting(input: {
      pluginId: string;
      scopeRef: string;
      enabled: boolean;
      configJson: string;
      updatedByUserId: string;
    }): StoredIngressPluginSetting;
  };
  return {
    getIngressPluginSetting: (pluginId, scopeRef) => raw.getIngressPluginSetting(pluginId, scopeRef),
    upsertIngressPluginSetting: (input) => raw.upsertIngressPluginSetting({
      pluginId: input.pluginId,
      scopeRef: input.scopeRef,
      enabled: input.enabled,
      configJson: JSON.stringify(input.config),
      updatedByUserId: input.updatedByUserId
    })
  };
}

export function ingressPluginRegistry(): readonly RegistryPlugin[] {
  const gatewayCore = GatewayCore as typeof GatewayCore & { listIngressPlugins(): readonly RegistryPlugin[] };
  return gatewayCore.listIngressPlugins();
}

export function ingressPluginById(pluginId: string): RegistryPlugin | null {
  return ingressPluginRegistry().find((plugin) => plugin.id === pluginId) ?? null;
}

export function storedPluginConfig(setting: StoredIngressPluginSetting | null | undefined): Record<string, unknown> | null {
  if (!setting) return null;
  if (setting.config && typeof setting.config === "object" && !Array.isArray(setting.config)) return setting.config;
  if (setting.configJson && typeof setting.configJson === "object" && !Array.isArray(setting.configJson)) return setting.configJson;
  if (typeof setting.configJson !== "string") return null;
  try {
    const parsed = JSON.parse(setting.configJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function ingressPluginSettingViews(repo: UiSyncQueryPort, identity: Pick<UiSyncQueryPort, "getUser">): IngressPluginSettingView[] {
  const settingsRepo = ingressPluginSettingsRepo(repo);
  return ingressPluginRegistry().map((plugin) => {
    const setting = settingsRepo.getIngressPluginSetting(plugin.id, GLOBAL_PLUGIN_SCOPE);
    const updatedByUserId = setting?.updatedByUserId ?? null;
    return {
      id: plugin.id,
      desc: plugin.desc,
      version: plugin.version,
      scopeRef: GLOBAL_PLUGIN_SCOPE,
      enabled: setting ? Boolean(setting.enabled) : false,
      config: storedPluginConfig(setting) ?? plugin.defaultConfig,
      configUi: plugin.configUi,
      updatedAt: normalizeDate(setting?.updatedAt),
      updatedBy: updatedByUserId ? identity.getUser(updatedByUserId)?.email ?? updatedByUserId : null
    };
  });
}

function normalizeDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}
