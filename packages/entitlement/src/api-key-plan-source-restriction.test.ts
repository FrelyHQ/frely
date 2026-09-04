import { describe, expect, test } from "vitest";
import { allApiKeyPlanSources, apiKeyPlanSourceRestrictionWritesEnabled, restrictedApiKeyPlanSources } from "./index.js";

describe("API Key Plan source restriction Decision", () => {
  test("keeps the compatibility all Decision separate from an empty restricted policy", () => {
    expect(allApiKeyPlanSources("key-a")).toMatchObject({ mode: "all", source: "modernization_03_compatibility" });
    expect(restrictedApiKeyPlanSources("key-a", [], [])).toMatchObject({
      mode: "restricted",
      apiKeyId: "key-a",
      sourceKeys: [],
      teamScopeRefs: [],
    });
  });

  test("freezes the selected source snapshot", () => {
    const source = { planId: "plan-a", subscriptionScopeRef: "team:team-a" as const };
    const decision = restrictedApiKeyPlanSources("key-a", [source], ["team:team-b"]);
    source.planId = "plan-mutated";

    expect(decision.sourceKeys).toEqual([{ planId: "plan-a", subscriptionScopeRef: "team:team-a" }]);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.sourceKeys)).toBe(true);
  });

  test("keeps restricted writes closed unless explicitly enabled", () => {
    expect(apiKeyPlanSourceRestrictionWritesEnabled({})).toBe(false);
    expect(apiKeyPlanSourceRestrictionWritesEnabled({ FRIDAY_RELAY_API_KEY_PLAN_SOURCE_RESTRICTION_WRITES_ENABLED: "yes" })).toBe(true);
  });
});
