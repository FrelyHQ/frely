import { describe, expect, it } from "vitest";
import {
  accessPointFormDefaults,
  accessPointTargetValue,
  parseNonNegativeNumber,
  parseTargetValue,
  providerTargetValue,
  targetChangeDefaults,
  toAccessPointInput,
  validateProviderCatalog,
} from "../apps/admin/features/access-points/form/access-point-form-values";
import {
  accessPointRowId,
  bulkAccessPointPreview,
  filterAccessPoints,
  isAllowedScope,
} from "../apps/admin/features/access-points/table/access-point-table-state";
import { accessPointKeys } from "../apps/admin/features/access-points/query/access-point-query-keys";
const row = {
  id: "ap_1",
  ownerId: "user_1",
  scopeRef: "user:user_1",
  name: "Main",
  apiFamily: "openai-compatible",
  exposedModel: "public-model",
  targetModel: "upstream-model",
  targetType: "provider-model" as const,
  targetId: null,
  targetProviderId: "provider_1",
  targetProviderModelName: "upstream-model",
  priority: 100,
  weight: 1,
  fallbackOrder: 100,
  status: "enabled",
};
describe("admin AccessPoints UI model", () => {
  it("uses typed target values without secrets in query keys", () => {
    expect(parseTargetValue(providerTargetValue("provider_1"))).toEqual({
      kind: "provider",
      providerId: "provider_1",
    });
    expect(parseTargetValue(accessPointTargetValue("ap_2"))).toEqual({
      kind: "access-point",
      accessPointId: "ap_2",
    });
    expect(accessPointKeys.modelCandidates("provider_1")).toEqual([
      "owner",
      "access-points",
      "provider-model-candidates",
      "provider_1",
    ]);
  });
  it("builds create DTOs and trims public values", () => {
    const values = accessPointFormDefaults(
      undefined,
      "user:user_1",
      "provider_1",
    );
    values.name = " Main ";
    values.exposedModel = " public-model ";
    values.targetModel = " upstream-model ";
    values.requestOverridesJson = '{"service_tier":"fast"}';
    const result = toAccessPointInput(values);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toMatchObject({
        name: "Main",
        scopeRef: "user:user_1",
        routing: {
          selector: { id: "direct", behaviorVersion: 1, config: {} },
          requestOverrides: { service_tier: "fast" },
          targets: [expect.objectContaining({
            type: "provider-model",
            targetProviderId: "provider_1",
            targetProviderModelName: "upstream-model",
            targetAccessPointId: null,
          })],
        },
      });
  });
  it("rejects malformed request override JSON before submitting", () => {
    const values = accessPointFormDefaults(undefined, "user:user_1", "provider_1");
    values.targetModel = "upstream-model";
    values.requestOverridesJson = "[]";
    expect(toAccessPointInput(values)).toEqual({ ok: false, message: "Request overrides must be a valid JSON object." });
  });
  it("defaults exposed model from target model and access name from exposed model", () => {
    const values = accessPointFormDefaults(
      undefined,
      "user:user_1",
      "provider_1",
    );
    values.targetModel = " upstream-model ";
    const result = toAccessPointInput(values);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toMatchObject({
        name: "upstream-model",
        exposedModel: "upstream-model",
        targetModel: "upstream-model",
        routing: {
          targets: [expect.objectContaining({ targetProviderModelName: "upstream-model" })],
        },
      });
  });
  it("preserves an explicitly unavailable Cache write sale price", () => {
    const values = accessPointFormDefaults(undefined, "user:user_1", "provider_1");
    values.targetModel = "upstream-model";
    values.saleInputPer1M = "1";
    values.saleCachedInputPer1M = "0.5";
    values.saleCacheWritePer1M = "Unavailable";
    values.saleOutputPer1M = "2";
    const result = toAccessPointInput(values);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.salePrice?.cacheWritePer1M).toBeNull();
  });
  it("preserves AccessPoint target semantics", () => {
    const values = accessPointFormDefaults(undefined, "global:", "");
    values.targetValue = accessPointTargetValue("ap_2");
    values.name = "Nested";
    values.exposedModel = "model";
    const result = toAccessPointInput(values);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toMatchObject({
        routing: {
          targets: [expect.objectContaining({
            type: "access-point",
            targetAccessPointId: "ap_2",
            targetProviderId: null,
          })],
        },
      });
  });
  it("rejects invalid non-negative values", () => {
    expect(parseNonNegativeNumber("-1")).toBeNull();
    expect(parseNonNegativeNumber("NaN")).toBeNull();
    expect(parseNonNegativeNumber("0")).toBe(0);
  });
  it("filters rows and uses stable domain row ids", () => {
    expect(filterAccessPoints([row], "user:user_1", "upstream")).toEqual([row]);
    expect(filterAccessPoints([row], "global:", "")).toEqual([]);
    expect(accessPointRowId(row)).toBe("ap_1");
  });
  it("requires an enabled model in the selected Provider catalog", () => {
    const values = accessPointFormDefaults(undefined, "global:", "provider_1");
    values.name = "Main";
    values.exposedModel = "public";
    values.targetModel = "upstream";
    expect(
      validateProviderCatalog(values, [
        {
          id: "m1",
          providerId: "provider_1",
          providerModelName: "upstream",
          displayName: "Upstream",
          status: "disabled",
        },
      ]),
    ).toContain("not enabled");
    expect(validateProviderCatalog(values, [])).toContain("not enabled");
    expect(validateProviderCatalog(values, [], ["upstream"])).toBeUndefined();
    expect(
      validateProviderCatalog(values, [
        {
          id: "m1",
          providerId: "provider_1",
          providerModelName: "upstream",
          displayName: "Upstream",
          status: "enabled",
        },
      ]),
    ).toBeUndefined();
  });
  it("applies target switch defaults", () => {
    const nested = { ...row, id: "ap_2", exposedModel: "nested-model" };
    expect(
      targetChangeDefaults(
        accessPointTargetValue("ap_2"),
        "",
        [nested],
        [],
        [],
      ),
    ).toEqual({ exposedModel: "nested-model", targetModel: "nested-model" });
    expect(
      targetChangeDefaults(
        providerTargetValue("provider_1"),
        "public",
        [],
        [
          {
            id: "provider_1",
            name: "Provider",
            kind: "openai",
            modelsResolver: "literal:list:default-model",
            status: "enabled",
          },
        ],
        [],
      ),
    ).toEqual({ exposedModel: "public", targetModel: "default-model" });
  });
  it("allowlists bulk scopes and renders per-row previews", () => {
    expect(isAllowedScope("team:t1", ["global:", "team:t1"])).toBe(true);
    expect(isAllowedScope("user:unknown", ["global:", "team:t1"])).toBe(false);
    expect(bulkAccessPointPreview(row, "scopeRef", "global:")).toBe(
      "user:user_1 -> global:",
    );
    expect(bulkAccessPointPreview(row, "priority", "50")).toBe(
      "priority 100 -> 50",
    );
  });
});
