import {
  capabilityToken,
  pluginPermission,
  type PipelineHook,
  type PipelinePlugin,
  type PluginManifest,
} from "../../contracts.js";

const ORIGINAL_REQUEST = capabilityToken("request:original");
const SELECTION_INTENT = capabilityToken("subscription:selection-intent");
const ACCESS_INTENT = capabilityToken("access:resolution-intent");

export const ACCESS_RESOLUTION_PORT_PERMISSION = pluginPermission("access:resolution-port");

export interface AccessResolutionPort {
  resolve(requestHandle: unknown, selectionIntent: unknown): unknown | Promise<unknown>;
}

const strictEmptyConfig = {
  parse(input: unknown): Record<string, never> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
      throw new TypeError("access-resolution config must be an empty object");
    }
    return Object.freeze({});
  },
};

const manifest: PluginManifest = Object.freeze({
  id: "access-resolution",
  desc: "Produces an Access Resolution intent without credential or Provider connection material.",
  apiVersion: 1,
  behaviorVersion: 1,
  configVersion: 1,
  availability: "required",
  userConfigurable: false,
  userToggleable: false,
  permissions: Object.freeze([ACCESS_RESOLUTION_PORT_PERMISSION]),
  requires: Object.freeze([ORIGINAL_REQUEST, SELECTION_INTENT]),
  provides: Object.freeze([ACCESS_INTENT]),
});

const resolveHook: PipelineHook<Record<string, never>> = {
  id: "resolve",
  phase: "access.select",
  kind: "contribute",
  requires: Object.freeze([ORIGINAL_REQUEST, SELECTION_INTENT]),
  provides: Object.freeze([ACCESS_INTENT]),
  readsArtifacts: Object.freeze(["originalRequest", "subscriptionSelection"]),
  writesArtifacts: Object.freeze(["accessResolution"]),
  async run({ artifacts, ports }) {
    const port = ports[ACCESS_RESOLUTION_PORT_PERMISSION] as AccessResolutionPort | undefined;
    if (!port || typeof port.resolve !== "function") throw new Error("Access Resolution port is unavailable");
    const accessIntent = await port.resolve(
      artifacts.get("originalRequest"),
      artifacts.get("subscriptionSelection"),
    );
    return { outcome: "applied", artifacts: { accessResolution: accessIntent } };
  },
};

export const accessResolutionPlugin: PipelinePlugin<Record<string, never>> = Object.freeze({
  manifest,
  defaultConfig: Object.freeze({}),
  configSchema: strictEmptyConfig,
  configUi: Object.freeze([]),
  hooks: Object.freeze([resolveHook]),
});
