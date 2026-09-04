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
const USAGE_INTENT = capabilityToken("usage:measured");
const BILLING_INTENT = capabilityToken("billing:calculation-intent");

export const BILLING_CALCULATION_PORT_PERMISSION = pluginPermission("billing:calculation-port");

export interface BillingCalculationPort {
  calculate(
    requestHandle: unknown,
    selectionIntent: unknown,
    accessIntent: unknown,
    priceIntent: unknown,
    budgetIntent: unknown,
    usageIntent: unknown,
  ): unknown | Promise<unknown>;
}

const strictEmptyConfig = {
  parse(input: unknown): Record<string, never> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
      throw new TypeError("billing-calculation config must be an empty object");
    }
    return Object.freeze({});
  },
};

const manifest: PluginManifest = Object.freeze({
  id: "billing-calculation",
  desc: "Produces an append-only billing intent while leaving all billing and ledger writes to the Kernel.",
  apiVersion: 1,
  behaviorVersion: 1,
  configVersion: 1,
  availability: "required",
  userConfigurable: false,
  userToggleable: false,
  permissions: Object.freeze([BILLING_CALCULATION_PORT_PERMISSION]),
  requires: Object.freeze([ORIGINAL_REQUEST, SELECTION_INTENT, ACCESS_INTENT, PRICE_INTENT, BUDGET_INTENT, USAGE_INTENT]),
  provides: Object.freeze([BILLING_INTENT]),
});

const calculateHook: PipelineHook<Record<string, never>> = {
  id: "calculate",
  phase: "billing.calculate",
  kind: "contribute",
  requires: Object.freeze([ORIGINAL_REQUEST, SELECTION_INTENT, ACCESS_INTENT, PRICE_INTENT, BUDGET_INTENT, USAGE_INTENT]),
  provides: Object.freeze([BILLING_INTENT]),
  readsArtifacts: Object.freeze(["originalRequest", "subscriptionSelection", "accessResolution", "priceQuote", "budgetDecision", "usage"]),
  writesArtifacts: Object.freeze(["billingDraft"]),
  async run({ artifacts, ports }) {
    const port = ports[BILLING_CALCULATION_PORT_PERMISSION] as BillingCalculationPort | undefined;
    if (!port || typeof port.calculate !== "function") throw new Error("Billing calculation port is unavailable");
    const billingIntent = await port.calculate(
      artifacts.get("originalRequest"),
      artifacts.get("subscriptionSelection"),
      artifacts.get("accessResolution"),
      artifacts.get("priceQuote"),
      artifacts.get("budgetDecision"),
      artifacts.get("usage"),
    );
    return { outcome: "applied", artifacts: { billingDraft: billingIntent } };
  },
};

export const billingCalculationPlugin: PipelinePlugin<Record<string, never>> = Object.freeze({
  manifest,
  defaultConfig: Object.freeze({}),
  configSchema: strictEmptyConfig,
  configUi: Object.freeze([]),
  hooks: Object.freeze([calculateHook]),
});
