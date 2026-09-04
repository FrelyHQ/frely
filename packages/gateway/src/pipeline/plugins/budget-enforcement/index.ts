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
const PRICE_INTENT = capabilityToken("pricing:quote-intent");
const BUDGET_INTENT = capabilityToken("budget:enforcement-intent");

export const BUDGET_ENFORCEMENT_PORT_PERMISSION = pluginPermission("budget:enforcement-port");

export interface BudgetEnforcementPort {
  enforce(
    requestHandle: unknown,
    selectionIntent: unknown,
    accessIntent: unknown,
    priceIntent: unknown,
  ): unknown | Promise<unknown>;
}

const strictEmptyConfig = {
  parse(input: unknown): Record<string, never> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
      throw new TypeError("budget-enforcement config must be an empty object");
    }
    return Object.freeze({});
  },
};

const manifest: PluginManifest = Object.freeze({
  id: "budget-enforcement",
  desc: "Produces a budget enforcement intent after pricing without exposing balance or policy storage.",
  apiVersion: 1,
  behaviorVersion: 1,
  configVersion: 1,
  availability: "required",
  userConfigurable: false,
  userToggleable: false,
  permissions: Object.freeze([BUDGET_ENFORCEMENT_PORT_PERMISSION]),
  requires: Object.freeze([ORIGINAL_REQUEST, SELECTION_INTENT, ACCESS_INTENT, PRICE_INTENT]),
  provides: Object.freeze([BUDGET_INTENT]),
});

const enforceHook: PipelineHook<Record<string, never>> = {
  id: "enforce",
  phase: "pricing.quote",
  kind: "guard",
  requires: Object.freeze([ORIGINAL_REQUEST, SELECTION_INTENT, ACCESS_INTENT, PRICE_INTENT]),
  provides: Object.freeze([BUDGET_INTENT]),
  readsArtifacts: Object.freeze(["originalRequest", "subscriptionSelection", "accessResolution", "priceQuote"]),
  writesArtifacts: Object.freeze(["budgetDecision"]),
  after: Object.freeze(["pricing-quote/quote"]),
  async run({ artifacts, ports }) {
    const port = ports[BUDGET_ENFORCEMENT_PORT_PERMISSION] as BudgetEnforcementPort | undefined;
    if (!port || typeof port.enforce !== "function") throw new Error("Budget enforcement port is unavailable");
    const budgetIntent = await port.enforce(
      artifacts.get("originalRequest"),
      artifacts.get("subscriptionSelection"),
      artifacts.get("accessResolution"),
      artifacts.get("priceQuote"),
    );
    return { outcome: "applied", artifacts: { budgetDecision: budgetIntent } };
  },
};

export const budgetEnforcementPlugin: PipelinePlugin<Record<string, never>> = Object.freeze({
  manifest,
  defaultConfig: Object.freeze({}),
  configSchema: strictEmptyConfig,
  configUi: Object.freeze([]),
  hooks: Object.freeze([enforceHook]),
});
