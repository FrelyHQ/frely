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

export const PRICING_QUOTE_PORT_PERMISSION = pluginPermission("pricing:quote-port");

export interface PricingQuotePort {
  quote(requestHandle: unknown, selectionIntent: unknown, accessIntent: unknown): unknown | Promise<unknown>;
}

const strictEmptyConfig = {
  parse(input: unknown): Record<string, never> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
      throw new TypeError("pricing-quote config must be an empty object");
    }
    return Object.freeze({});
  },
};

const manifest: PluginManifest = Object.freeze({
  id: "pricing-quote",
  desc: "Produces a request-bound price quote intent from Kernel-approved selection and access intents.",
  apiVersion: 1,
  behaviorVersion: 1,
  configVersion: 1,
  availability: "required",
  userConfigurable: false,
  userToggleable: false,
  permissions: Object.freeze([PRICING_QUOTE_PORT_PERMISSION]),
  requires: Object.freeze([ORIGINAL_REQUEST, SELECTION_INTENT, ACCESS_INTENT]),
  provides: Object.freeze([PRICE_INTENT]),
});

const quoteHook: PipelineHook<Record<string, never>> = {
  id: "quote",
  phase: "pricing.quote",
  kind: "contribute",
  requires: Object.freeze([ORIGINAL_REQUEST, SELECTION_INTENT, ACCESS_INTENT]),
  provides: Object.freeze([PRICE_INTENT]),
  readsArtifacts: Object.freeze(["originalRequest", "subscriptionSelection", "accessResolution"]),
  writesArtifacts: Object.freeze(["priceQuote"]),
  async run({ artifacts, ports }) {
    const port = ports[PRICING_QUOTE_PORT_PERMISSION] as PricingQuotePort | undefined;
    if (!port || typeof port.quote !== "function") throw new Error("Pricing quote port is unavailable");
    const priceIntent = await port.quote(
      artifacts.get("originalRequest"),
      artifacts.get("subscriptionSelection"),
      artifacts.get("accessResolution"),
    );
    return { outcome: "applied", artifacts: { priceQuote: priceIntent } };
  },
};

export const pricingQuotePlugin: PipelinePlugin<Record<string, never>> = Object.freeze({
  manifest,
  defaultConfig: Object.freeze({}),
  configSchema: strictEmptyConfig,
  configUi: Object.freeze([]),
  hooks: Object.freeze([quoteHook]),
});
