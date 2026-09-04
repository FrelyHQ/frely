import { describe, expect, test } from "vitest";
import { parsePricingWorkbenchState, pricingWorkbenchHref } from "./pricing-url-state";

describe("Pricing workbench URL state", () => {
  test("normalizes invalid pages and enum filters to bounded defaults", () => {
    expect(parsePricingWorkbenchState({
      providerPage: "-4",
      providerStatus: "pending",
      providerPrice: "unknown",
      accessPage: "not-a-page",
      accessStatus: "pending",
      targetCost: "unknown",
      accessPrice: "unknown",
    })).toMatchObject({
      providerPage: 1,
      providerModelStatus: "enabled",
      providerPrice: "all",
      accessPointPage: 1,
      accessPointStatus: "enabled",
      accessPointTargetCost: "all",
      accessPointPrice: "all",
    });
  });

  test("uses only the first value and bounds free-text URL inputs", () => {
    const state = parsePricingWorkbenchState({
      providerPage: ["2", "99"],
      provider: ["provider-1", "provider-2"],
      providerQuery: `  ${"a".repeat(120)}  `,
      accessQuery: `  ${"b".repeat(120)}  `,
    });
    expect(state.providerPage).toBe(2);
    expect(state.providerId).toBe("provider-1");
    expect(state.providerQuery).toHaveLength(100);
    expect(state.accessPointQuery).toHaveLength(100);
  });

  test("keeps the other workbench state while a filter resets only its own page", () => {
    expect(pricingWorkbenchHref(
      "providerPage=3&accessPage=2&accessStatus=disabled",
      { provider: "provider-1", providerPage: null },
    )).toBe("/owner/pricing?accessPage=2&accessStatus=disabled&provider=provider-1");
  });
});
