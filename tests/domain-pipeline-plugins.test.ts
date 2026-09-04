import { describe, expect, test } from "vitest";
import {
  ACCESS_RESOLUTION_PORT_PERMISSION,
  BILLING_CALCULATION_PORT_PERMISSION,
  BUDGET_ENFORCEMENT_PORT_PERMISSION,
  PIPELINE_PHASES,
  PLAN_SUBSCRIPTION_SELECTION_PORT_PERMISSION,
  PRICING_QUOTE_PORT_PERMISSION,
  PipelineRequestSession,
  capabilityToken,
  compileExecutionPlan,
  listGatewayPolicyPipelinePlugins,
  type AccessResolutionPort,
  type BillingCalculationPort,
  type BudgetEnforcementPort,
  type PipelineArtifactName,
  type PipelinePhase,
  type PipelinePlugin,
  type PipelinePluginSetting,
  type PluginPermission,
  type PlanSubscriptionSelectionPort,
  type PricingQuotePort,
} from "@frely/gateway-core";

const pluginContract = [
  {
    id: "plan-subscription-selection",
    permission: PLAN_SUBSCRIPTION_SELECTION_PORT_PERMISSION,
    hook: {
      id: "select",
      phase: "access.candidates",
      kind: "contribute",
      readsArtifacts: ["originalRequest"],
      writesArtifacts: ["subscriptionSelection"],
    },
  },
  {
    id: "access-resolution",
    permission: ACCESS_RESOLUTION_PORT_PERMISSION,
    hook: {
      id: "resolve",
      phase: "access.select",
      kind: "contribute",
      readsArtifacts: ["originalRequest", "subscriptionSelection"],
      writesArtifacts: ["accessResolution"],
    },
  },
  {
    id: "pricing-quote",
    permission: PRICING_QUOTE_PORT_PERMISSION,
    hook: {
      id: "quote",
      phase: "pricing.quote",
      kind: "contribute",
      readsArtifacts: ["originalRequest", "subscriptionSelection", "accessResolution"],
      writesArtifacts: ["priceQuote"],
    },
  },
  {
    id: "budget-enforcement",
    permission: BUDGET_ENFORCEMENT_PORT_PERMISSION,
    hook: {
      id: "enforce",
      phase: "pricing.quote",
      kind: "guard",
      readsArtifacts: ["originalRequest", "subscriptionSelection", "accessResolution", "priceQuote"],
      writesArtifacts: ["budgetDecision"],
    },
  },
  {
    id: "billing-calculation",
    permission: BILLING_CALCULATION_PORT_PERMISSION,
    hook: {
      id: "calculate",
      phase: "billing.calculate",
      kind: "contribute",
      readsArtifacts: ["originalRequest", "subscriptionSelection", "accessResolution", "priceQuote", "budgetDecision", "usage"],
      writesArtifacts: ["billingDraft"],
    },
  },
] as const satisfies readonly {
  id: string;
  permission: PluginPermission;
  hook: {
    id: string;
    phase: PipelinePhase;
    kind: "contribute" | "guard";
    readsArtifacts: readonly PipelineArtifactName[];
    writesArtifacts: readonly PipelineArtifactName[];
  };
}[];

function compilerInput(
  plugins: readonly PipelinePlugin<unknown>[],
  availablePorts: ReadonlyMap<PluginPermission, unknown>,
  settings: readonly PipelinePluginSetting[] = [],
) {
  return {
    kernelApiVersion: 1,
    plugins,
    settings: Object.freeze({ revision: "domain-settings-v1", settings: Object.freeze([...settings]) }),
    applicability: Object.freeze({ cacheKey: "gateway-domain-v1", facts: Object.freeze({ executionLayer: "gateway" }) }),
    availableCapabilities: Object.freeze([
      capabilityToken("request:original"),
      capabilityToken("usage:measured"),
    ]),
    availablePorts,
  };
}

describe("Phase 5 Gateway domain pipeline plugins", () => {
  test("publish a required, non-toggleable, non-configurable v1 contract with exact hooks and permissions", () => {
    const plugins = listGatewayPolicyPipelinePlugins();

    expect(plugins.map((plugin) => plugin.manifest.id)).toEqual(pluginContract.map((entry) => entry.id));
    for (const expected of pluginContract) {
      const plugin = plugins.find((candidate) => candidate.manifest.id === expected.id)!;
      expect(plugin.manifest).toMatchObject({
        id: expected.id,
        apiVersion: 1,
        behaviorVersion: 1,
        configVersion: 1,
        availability: "required",
        userToggleable: false,
        userConfigurable: false,
      });
      expect(plugin.manifest.permissions).toEqual([expected.permission]);
      expect(plugin.defaultConfig).toEqual({});
      expect(plugin.configSchema.parse({})).toEqual({});
      expect(() => plugin.configSchema.parse({ unexpected: true })).toThrow();
      expect(plugin.configUi).toEqual([]);
      expect(plugin.hooks).toHaveLength(1);
      expect(plugin.hooks[0]).toMatchObject(expected.hook);
      expect(plugin.hooks[0]?.readsArtifacts).toEqual(expected.hook.readsArtifacts);
      expect(plugin.hooks[0]?.writesArtifacts).toEqual(expected.hook.writesArtifacts);
    }
  });

  test("execute the complete fixed plan through request-bound ports and publish six authoritative intents", async () => {
    const order: string[] = [];
    const requestHandle = Object.freeze({ kind: "gateway-domain-request", prompt: "secret-prompt-value" });
    const selectionIntent = { kind: "selection-intent", config: "secret-config-value" };
    const accessIntent = { kind: "access-intent", internalMarker: "private-access-marker" };
    const priceIntent = { kind: "price-intent", price: "999.123-price-value" };
    const budgetIntent = { kind: "budget-intent", allowed: true };
    const trustedUsage = { kind: "trusted-usage", inputTokens: 7, outputTokens: 3 };
    const billingIntent = { kind: "billing-intent", operationCount: 1 };

    const selectionPort: PlanSubscriptionSelectionPort = {
      select(request) {
        order.push("plan-subscription-selection/select");
        expect(request).toBe(requestHandle);
        return selectionIntent;
      },
    };
    const accessPort: AccessResolutionPort = {
      resolve(request, selection) {
        order.push("access-resolution/resolve");
        expect(request).toBe(requestHandle);
        expect(selection).toBe(selectionIntent);
        return accessIntent;
      },
    };
    const pricingPort: PricingQuotePort = {
      quote(request, selection, access) {
        order.push("pricing-quote/quote");
        expect(request).toBe(requestHandle);
        expect(selection).toBe(selectionIntent);
        expect(access).toBe(accessIntent);
        return priceIntent;
      },
    };
    const budgetPort: BudgetEnforcementPort = {
      enforce(request, selection, access, price) {
        order.push("budget-enforcement/enforce");
        expect(request).toBe(requestHandle);
        expect(selection).toBe(selectionIntent);
        expect(access).toBe(accessIntent);
        expect(price).toBe(priceIntent);
        return budgetIntent;
      },
    };
    const billingPort: BillingCalculationPort = {
      calculate(request, selection, access, price, budget, usage) {
        order.push("billing-calculation/calculate");
        expect(request).toBe(requestHandle);
        expect(selection).toBe(selectionIntent);
        expect(access).toBe(accessIntent);
        expect(price).toBe(priceIntent);
        expect(budget).toBe(budgetIntent);
        expect(usage).toBe(trustedUsage);
        return billingIntent;
      },
    };
    const ports = new Map<PluginPermission, unknown>([
      [PLAN_SUBSCRIPTION_SELECTION_PORT_PERMISSION, selectionPort],
      [ACCESS_RESOLUTION_PORT_PERMISSION, accessPort],
      [PRICING_QUOTE_PORT_PERMISSION, pricingPort],
      [BUDGET_ENFORCEMENT_PORT_PERMISSION, budgetPort],
      [BILLING_CALCULATION_PORT_PERMISSION, billingPort],
    ]);
    const plan = compileExecutionPlan(compilerInput(listGatewayPolicyPipelinePlugins(), ports));
    const session = new PipelineRequestSession(plan, Object.freeze({ originalRequest: requestHandle }));

    for (const phase of PIPELINE_PHASES) {
      if (phase === "billing.calculate") session.publishTrustedArtifacts({ usage: trustedUsage });
      await session.executePhase(phase);
    }

    expect(order).toEqual([
      "plan-subscription-selection/select",
      "access-resolution/resolve",
      "pricing-quote/quote",
      "budget-enforcement/enforce",
      "billing-calculation/calculate",
    ]);
    const artifacts = session.context.artifactReader();
    expect({
      subscriptionSelection: artifacts.get("subscriptionSelection"),
      accessResolution: artifacts.get("accessResolution"),
      priceQuote: artifacts.get("priceQuote"),
      budgetDecision: artifacts.get("budgetDecision"),
      usage: artifacts.get("usage"),
      billingDraft: artifacts.get("billingDraft"),
    }).toEqual({
      subscriptionSelection: selectionIntent,
      accessResolution: accessIntent,
      priceQuote: priceIntent,
      budgetDecision: budgetIntent,
      usage: trustedUsage,
      billingDraft: billingIntent,
    });

    const snapshotJson = JSON.stringify(session.invocationSnapshot());
    expect(snapshotJson).not.toContain("secret-prompt-value");
    expect(snapshotJson).not.toContain("secret-config-value");
    expect(snapshotJson).not.toContain("999.123-price-value");
    expect(snapshotJson).not.toContain("private-access-marker");
    expect(snapshotJson).not.toContain('"prompt"');
    expect(snapshotJson).not.toContain('"config"');
    expect(snapshotJson).not.toContain('"price"');
    expect(snapshotJson).not.toContain('"credential"');
    session.finish();
  });

  test("reject disabling every required domain plugin", () => {
    const emptyPorts = new Map<PluginPermission, unknown>();
    for (const plugin of listGatewayPolicyPipelinePlugins()) {
      expect(() => compileExecutionPlan(compilerInput(
        listGatewayPolicyPipelinePlugins(),
        emptyPorts,
        [{ pluginId: plugin.manifest.id, enabled: false, instanceRevision: `pir-${plugin.manifest.id}` }],
      ))).toThrow(`Pipeline plugin ${plugin.manifest.id} cannot be disabled`);
    }
  });
});
