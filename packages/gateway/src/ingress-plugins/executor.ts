import { getIngressPlugin, ingressPluginRegistry } from "./registry.js";
import type {
  IngressPlugin,
  IngressPluginContext,
  IngressPluginExecution,
  InvokedIngressPlugin,
  ResolvedIngressPluginSetting,
} from "./types.js";

export class IngressPluginExecutionError extends Error {
  readonly invokedPlugins: readonly InvokedIngressPlugin[];

  constructor(pluginId: string, invokedPlugins: readonly InvokedIngressPlugin[], options: ErrorOptions) {
    super(`Ingress plugin execution failed: ${pluginId}`, options);
    this.name = "IngressPluginExecutionError";
    this.invokedPlugins = Object.freeze([...invokedPlugins]);
  }
}

export function validateIngressPluginConfig(pluginId: string, input: unknown): unknown {
  const plugin = getIngressPlugin(pluginId);
  if (!plugin) throw new TypeError(`Unknown ingress plugin ID: ${pluginId}`);
  return plugin.configSchema.parse(input);
}

export function executeIngressPlugins(
  context: IngressPluginContext,
  payload: Readonly<Record<string, unknown>>,
  settings: readonly ResolvedIngressPluginSetting[],
  plugins: readonly IngressPlugin<any>[] = ingressPluginRegistry,
): IngressPluginExecution {
  const settingsById = new Map(settings.map((setting) => [setting.id, setting]));
  let effectivePayload: Record<string, unknown> = { ...payload };
  const invokedPlugins: InvokedIngressPlugin[] = [];

  for (const plugin of plugins) {
    const setting = settingsById.get(plugin.id);
    if (!setting?.enabled) continue;
    const config = plugin.configSchema.parse(setting.config);
    if (!plugin.isApplicable(context, effectivePayload, config)) continue;
    try {
      const result = plugin.transformIngressRequest(context, effectivePayload, config);
      effectivePayload = { ...result.payload };
      invokedPlugins.push(Object.freeze({ id: plugin.id, version: plugin.version, success: result.matched ? true : null }));
    } catch (cause) {
      invokedPlugins.push(Object.freeze({ id: plugin.id, version: plugin.version, success: false }));
      throw new IngressPluginExecutionError(plugin.id, invokedPlugins, { cause });
    }
  }

  return Object.freeze({ payload: effectivePayload, invokedPlugins: Object.freeze(invokedPlugins) });
}
