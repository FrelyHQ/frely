import type { ApplicationCommands, ApplicationQueries } from "./application-capabilities.js";

const GATEWAY_QUERY_METHODS = [
  "isRequestCaptureEnabled",
  "listPipelinePluginSettings",
  "listEffectiveUserModelPlanSourceModels",
  "pageOrderedPlanSourcesForUser",
  "findFirstOrderedPlanSourceForUser",
  "listAccessPointTargets",
  "getAccessPoint",
  "getAccessPoints",
  "listAccessPointsVisibleAtScope",
  "listAccessPointTargetsByIds",
  "getProvider",
  "getProviders",
  "getApiKey",
  "findEnabledProviderModelCost",
  "findEnabledProviderModelCosts",
  "findEnabledAccessPointPrice",
  "findEnabledAccessPointPrices",
  "findEffectivePlanAccessPointPrices",
  "findEffectivePlanAccessPointPrice",
  "listPlanBudgetLimitsForPlans",
  "findCreditAccountForScope",
  "getCreditAccountBalanceUnits",
  "getCreditAccountBalance",
  "listScopeBudgetPolicyAssignments",
  "listScopeGovernanceBudgetPolicyAssignments",
  "listScopeRateLimitPolicyAssignments",
  "usageForSubscription",
  "usageForSubscriptionUser",
  "usageForScope",
  "listPlanSubscriptionBudgetUsage",
  "summarizeScopeBudgetUsageWindows",
  "listActiveSubscriptionsForUser",
  "findActivePlanSubscriptions",
  "getRequestLog",
  "inspectAbuseRateLimit",
  "resolveEnabledPublicHost",
  "resolveActiveDomainBinding",
] as const satisfies readonly (keyof ApplicationQueries)[];

const GATEWAY_COMMAND_METHODS = [
  "createRequestLog",
  "enrichRequestLogResolution",
  "finishRequestLog",
  "finalizeRequestPipelineSnapshot",
  "settleProviderUsage",
  "consumeAbuseRateLimit",
  "deleteExpiredAbuseRateLimits",
] as const satisfies readonly (keyof ApplicationCommands)[];

export interface GatewayQueries extends Pick<ApplicationQueries, (typeof GATEWAY_QUERY_METHODS)[number]> {}
export interface GatewayCommands extends Pick<ApplicationCommands, (typeof GATEWAY_COMMAND_METHODS)[number]> {}

type AssertNever<Value extends never> = Value;
type _GatewayCapabilitiesDoNotOverlap = AssertNever<Extract<keyof GatewayQueries, keyof GatewayCommands>>;
type _GatewayCapabilitiesDoNotExposeInfrastructure = AssertNever<Extract<
  keyof GatewayQueries | keyof GatewayCommands,
  "withTransaction" | "withRetriedTransaction" | "transaction" | "contextTransactions" | "prisma" | "repository"
>>;

function bindGatewayCapability<Source extends object, const Keys extends readonly (keyof Source)[]>(
  source: Source,
  keys: Keys,
): Pick<Source, Keys[number]> {
  const capability = Object.create(null) as Pick<Source, Keys[number]>;
  for (const key of keys) {
    const method = source[key];
    if (typeof method !== "function") throw new Error(`gateway_capability_method_missing:${String(key)}`);
    Object.defineProperty(capability, key, {
      configurable: false,
      enumerable: true,
      value: method.bind(source),
      writable: false,
    });
  }
  return Object.freeze(capability);
}

export function createGatewayQueries(source: ApplicationQueries): GatewayQueries {
  return bindGatewayCapability(source, GATEWAY_QUERY_METHODS);
}

export function createGatewayCommands(source: ApplicationCommands): GatewayCommands {
  return bindGatewayCapability(source, GATEWAY_COMMAND_METHODS);
}
