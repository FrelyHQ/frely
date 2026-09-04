import type { PipelinePlugin } from "../contracts.js";
import { accessResolutionPlugin } from "./access-resolution/index.js";
import { billingCalculationPlugin } from "./billing-calculation/index.js";
import { budgetEnforcementPlugin } from "./budget-enforcement/index.js";
import { planSubscriptionSelectionPlugin } from "./plan-subscription-selection/index.js";
import { pricingQuotePlugin } from "./pricing-quote/index.js";

export const gatewayPolicyPipelinePluginRegistry: readonly PipelinePlugin<Record<string, never>>[] = Object.freeze([
  planSubscriptionSelectionPlugin,
  accessResolutionPlugin,
  pricingQuotePlugin,
  budgetEnforcementPlugin,
  billingCalculationPlugin,
]);

export function listGatewayPolicyPipelinePlugins(): readonly PipelinePlugin<Record<string, never>>[] {
  return gatewayPolicyPipelinePluginRegistry;
}
