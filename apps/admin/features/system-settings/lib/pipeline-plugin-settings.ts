import * as GatewayCore from "@frely/gateway-core";
import type { UiQueryPort, UiSyncQueryPort } from "@frely/ui-application/contracts";
import type { IdentityQueries } from "@frely/identity/server";
import type { IngressPluginConfigField, PipelinePluginSettingView } from "../types";

export const GLOBAL_PIPELINE_PLUGIN_SCOPE = "global:" as const;

type PipelinePluginDefinition = {
  manifest: {
    id: string;
    desc: string;
    apiVersion: number;
    behaviorVersion: number;
    configVersion: number;
    availability: "required" | "optional";
    userConfigurable: boolean;
    userToggleable: boolean;
  };
  defaultConfig: unknown;
  configSchema: { parse(input: unknown): unknown };
  configUi: readonly IngressPluginConfigField[];
  hooks: readonly { phase: string }[];
};

type StoredPipelinePluginSetting = {
  id: string;
  pluginId: string;
  scopeRef: string;
  enabled: boolean | number;
  configJson: string;
  settingRevision: number;
  configRevision: number;
  updatedAt: string | Date | null;
  updatedByUserId: string | null;
};

export function pipelinePluginRegistry(): readonly PipelinePluginDefinition[] {
  const ingress = GatewayCore.listIngressPlugins().map((plugin) => GatewayCore.adaptIngressPlugin(plugin) as PipelinePluginDefinition);
  const gatewayPolicy = GatewayCore.listGatewayPolicyPipelinePlugins() as readonly PipelinePluginDefinition[];
  return Object.freeze([...ingress, ...gatewayPolicy].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)));
}

export function pipelinePluginById(pluginId: string): PipelinePluginDefinition | null {
  return pipelinePluginRegistry().find((plugin) => plugin.manifest.id === pluginId) ?? null;
}

export function validatePipelinePluginConfig(pluginId: string, input: unknown): Record<string, unknown> {
  const plugin = pipelinePluginById(pluginId);
  if (!plugin) throw new TypeError(`Unknown pipeline plugin: ${pluginId}`);
  const parsed = plugin.configSchema.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Pipeline plugin config must be an object");
  return parsed as Record<string, unknown>;
}

export function pipelinePluginSettingViews(repo: UiSyncQueryPort, identity: Pick<UiSyncQueryPort, "getUser">): PipelinePluginSettingView[] {
  return pipelinePluginRegistry().map((plugin) => {
    const setting = repo.getPipelinePluginSetting(plugin.manifest.id, GLOBAL_PIPELINE_PLUGIN_SCOPE) as StoredPipelinePluginSetting | undefined;
    const required = plugin.manifest.availability === "required" || !plugin.manifest.userToggleable;
    const updatedByUserId = setting?.updatedByUserId ?? null;
    return {
      id: plugin.manifest.id,
      desc: plugin.manifest.desc,
      apiVersion: plugin.manifest.apiVersion,
      behaviorVersion: plugin.manifest.behaviorVersion,
      configVersion: plugin.manifest.configVersion,
      availability: plugin.manifest.availability,
      userConfigurable: plugin.manifest.userConfigurable,
      userToggleable: plugin.manifest.userToggleable,
      phases: Object.freeze([...new Set(plugin.hooks.map((hook) => hook.phase))]),
      scopeRef: GLOBAL_PIPELINE_PLUGIN_SCOPE,
      enabled: required ? true : Boolean(setting?.enabled),
      config: setting ? parseConfig(setting.configJson) : objectConfig(plugin.defaultConfig),
      configUi: plugin.configUi,
      settingRevision: setting?.settingRevision ?? null,
      updatedAt: normalizeDate(setting?.updatedAt),
      updatedBy: updatedByUserId ? identity.getUser(updatedByUserId)?.email ?? updatedByUserId : null,
    };
  });
}

export async function pipelinePluginSettingViewsAsync(
  repo: Pick<UiQueryPort, "getPipelinePluginSetting">,
  identity: Pick<IdentityQueries, "getUser">,
): Promise<PipelinePluginSettingView[]> {
  return Promise.all(pipelinePluginRegistry().map(async (plugin) => {
    const setting = await repo.getPipelinePluginSetting(plugin.manifest.id, GLOBAL_PIPELINE_PLUGIN_SCOPE) as StoredPipelinePluginSetting | undefined;
    const required = plugin.manifest.availability === "required" || !plugin.manifest.userToggleable;
    const updatedByUserId = setting?.updatedByUserId ?? null;
    return {
      id: plugin.manifest.id,
      desc: plugin.manifest.desc,
      apiVersion: plugin.manifest.apiVersion,
      behaviorVersion: plugin.manifest.behaviorVersion,
      configVersion: plugin.manifest.configVersion,
      availability: plugin.manifest.availability,
      userConfigurable: plugin.manifest.userConfigurable,
      userToggleable: plugin.manifest.userToggleable,
      phases: Object.freeze([...new Set(plugin.hooks.map((hook) => hook.phase))]),
      scopeRef: GLOBAL_PIPELINE_PLUGIN_SCOPE,
      enabled: required ? true : Boolean(setting?.enabled),
      config: setting ? parseConfig(setting.configJson) : objectConfig(plugin.defaultConfig),
      configUi: plugin.configUi,
      settingRevision: setting?.settingRevision ?? null,
      updatedAt: normalizeDate(setting?.updatedAt),
      updatedBy: updatedByUserId ? (await identity.getUser(updatedByUserId))?.email ?? updatedByUserId : null,
    } satisfies PipelinePluginSettingView;
  }));
}

function objectConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseConfig(value: string): Record<string, unknown> {
  try { return objectConfig(JSON.parse(value) as unknown); }
  catch { return {}; }
}

function normalizeDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}
