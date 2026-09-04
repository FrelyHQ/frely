import {
  capabilityToken,
  pluginPermission,
  type PipelineHook,
  type PipelinePlugin,
  type PluginManifest,
} from "../../contracts.js";

const ORIGINAL_REQUEST = capabilityToken("request:original");
const SELECTION_INTENT = capabilityToken("subscription:selection-intent");

export const PLAN_SUBSCRIPTION_SELECTION_PORT_PERMISSION = pluginPermission("subscription:selection-port");

export interface PlanSubscriptionSelectionPort {
  select(requestHandle: unknown): unknown | Promise<unknown>;
}

const strictEmptyConfig = {
  parse(input: unknown): Record<string, never> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
      throw new TypeError("plan-subscription-selection config must be an empty object");
    }
    return Object.freeze({});
  },
};

const manifest: PluginManifest = Object.freeze({
  id: "plan-subscription-selection",
  desc: "Produces a request-bound Plan subscription selection intent for Kernel validation.",
  apiVersion: 1,
  behaviorVersion: 1,
  configVersion: 1,
  availability: "required",
  userConfigurable: false,
  userToggleable: false,
  permissions: Object.freeze([PLAN_SUBSCRIPTION_SELECTION_PORT_PERMISSION]),
  requires: Object.freeze([ORIGINAL_REQUEST]),
  provides: Object.freeze([SELECTION_INTENT]),
});

const selectHook: PipelineHook<Record<string, never>> = {
  id: "select",
  phase: "access.candidates",
  kind: "contribute",
  requires: Object.freeze([ORIGINAL_REQUEST]),
  provides: Object.freeze([SELECTION_INTENT]),
  readsArtifacts: Object.freeze(["originalRequest"]),
  writesArtifacts: Object.freeze(["subscriptionSelection"]),
  async run({ artifacts, ports }) {
    const port = ports[PLAN_SUBSCRIPTION_SELECTION_PORT_PERMISSION] as PlanSubscriptionSelectionPort | undefined;
    if (!port || typeof port.select !== "function") throw new Error("Plan subscription selection port is unavailable");
    const selectionIntent = await port.select(artifacts.get("originalRequest"));
    return { outcome: "applied", artifacts: { subscriptionSelection: selectionIntent } };
  },
};

export const planSubscriptionSelectionPlugin: PipelinePlugin<Record<string, never>> = Object.freeze({
  manifest,
  defaultConfig: Object.freeze({}),
  configSchema: strictEmptyConfig,
  configUi: Object.freeze([]),
  hooks: Object.freeze([selectHook]),
});
