import { reasoningInstructionsGuardPlugin } from "./reasoning-instructions-guard.js";
import type { IngressPlugin } from "./types.js";

function createRegistry(plugins: readonly IngressPlugin<any>[]): readonly IngressPlugin<any>[] {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plugin.id)) throw new Error(`Invalid ingress plugin ID: ${plugin.id}`);
    if (ids.has(plugin.id)) throw new Error(`Duplicate ingress plugin ID: ${plugin.id}`);
    ids.add(plugin.id);
  }
  return Object.freeze([...plugins]);
}

export const ingressPluginRegistry = createRegistry([
  reasoningInstructionsGuardPlugin,
]);

export function listIngressPlugins(): readonly IngressPlugin<any>[] {
  return ingressPluginRegistry;
}

export function getIngressPlugin(id: string): IngressPlugin<any> | undefined {
  return ingressPluginRegistry.find((plugin) => plugin.id === id);
}

export function assertUniqueIngressPluginIds(plugins: readonly IngressPlugin<any>[]): void {
  createRegistry(plugins);
}
