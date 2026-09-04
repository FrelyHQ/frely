import { describe, expect, test } from "vitest";
import {
  addDraftTier,
  adoptReferenceProfile,
  createDefaultPriceDraft,
  createPriceDraftFromEnabled,
  createPriceDraftFromProfile,
  fillDraftFromReference,
  fillSupportedDraftFromReference,
  formatPriceTupleDisplay,
  missingReferenceProfileCount,
  parsePriceTupleDisplay,
  removeDraftTier,
  updateDraftTier,
  unsupportedReferenceProfiles,
  validatePriceDraft,
  type PriceDraft,
  type ReferencePriceLike
} from "../apps/admin/features/pricing/form/price-draft";

const flatPrices = {
  inputPer1M: 2,
  cachedInputPer1M: 0.5,
  cacheWritePer1M: 3,
  outputPer1M: 8
};

const reference: ReferencePriceLike = {
  inputPerMillion: 1,
  cachedInputPerMillion: null,
  cacheWritePerMillion: null,
  outputPerMillion: 4,
  contextPrices: [
    { serviceTier: "standard", context: "short_context", minInputTokens: 0, maxInputTokens: 100, inputPer1M: 1, cachedInputPer1M: null, cacheWritePer1M: null, outputPer1M: 4 },
    { serviceTier: "standard", context: "long_context", minInputTokens: 101, maxInputTokens: null, inputPer1M: 2, cachedInputPer1M: 0.25, cacheWritePer1M: 3, outputPer1M: 8 },
    { serviceTier: "priority", context: "short_context", minInputTokens: 0, maxInputTokens: 100, inputPer1M: 4, cachedInputPer1M: 1, cacheWritePer1M: 5, outputPer1M: 16 }
  ]
};

function validFlatDraft(): PriceDraft {
  return createPriceDraftFromEnabled(flatPrices);
}

describe("pricing editor local draft", () => {
  test("parses and formats the compact four-dimensional price input", () => {
    expect(parsePriceTupleDisplay("2, 0.5, 3, 8")).toEqual(["2", "0.5", "3", "8"]);
    expect(parsePriceTupleDisplay("2, 0.5")).toEqual(["2", "0.5", "", ""]);
    expect(parsePriceTupleDisplay("2, 0.5, 3, 8, 9")).toEqual(["2", "0.5", "3", "8, 9"]);
    expect(formatPriceTupleDisplay(["2", "0.5", "3", "8"])).toBe("2, 0.5, 3, 8");
    expect(formatPriceTupleDisplay(["", "", "", ""])).toBe("");
  });

  test("creates independent blank drafts with an optional priority short profile", () => {
    const left = createDefaultPriceDraft();
    const right = createDefaultPriceDraft();
    left.tiers[0]!.inputPer1M = "9";
    expect(right.inputPerMillionDisplay).toBe("");
    expect(right.tiers).toEqual([expect.objectContaining({ serviceTier: "priority", tierKey: "short_context", inputPer1M: "" })]);
  });

  test("restores flat enabled values without making the optional priority profile required", () => {
    const draft = validFlatDraft();
    expect(draft).toEqual(expect.objectContaining({ inputPerMillionDisplay: "2", cachedInputPerMillionDisplay: "0.5", cacheWritePerMillionDisplay: "3", outputPerMillionDisplay: "8" }));
    expect(validatePriceDraft(draft)).toEqual({ payload: flatPrices, errors: [] });
  });

  test("restores complete tier values and inclusive boundaries", () => {
    const draft = createPriceDraftFromEnabled({
      ...flatPrices,
      tiers: [
        { serviceTier: "standard", tierKey: "long_context", minInputTokens: 101, maxInputTokens: null, ...flatPrices },
        { serviceTier: "priority", tierKey: "short_context", minInputTokens: 0, maxInputTokens: 100, ...flatPrices }
      ]
    });
    expect(validatePriceDraft(draft).payload?.tiers).toEqual([
      expect.objectContaining({ serviceTier: "standard", tierKey: "long_context", minInputTokens: 101, maxInputTokens: null }),
      expect.objectContaining({ serviceTier: "priority", tierKey: "short_context", minInputTokens: 0, maxInputTokens: 100 })
    ]);
  });

  test("distinguishes zero, blank optional profiles, and partial invalid profiles", () => {
    const zero = validFlatDraft();
    zero.inputPerMillionDisplay = "0";
    expect(validatePriceDraft(zero).payload?.inputPer1M).toBe(0);
    expect(validatePriceDraft(zero).payload).not.toHaveProperty("tiers");

    const partial = updateDraftTier(zero, 0, { inputPer1M: "1" });
    expect(validatePriceDraft(partial)).toEqual(expect.objectContaining({ payload: null, errors: expect.arrayContaining([expect.stringContaining("fill all four")]) }));
  });

  test("adds and removes profile structures without mutating another draft", () => {
    const original = validFlatDraft();
    const added = addDraftTier(original, "standard", "long_context");
    const edited = updateDraftTier(added, 0, { maxInputTokensDisplay: "100" });
    expect(original.tiers).toHaveLength(1);
    expect(edited.tiers).toHaveLength(2);
    expect(removeDraftTier(edited, 1).tiers).toHaveLength(1);
  });

  test("fills only matching existing profiles and preserves Cache write Unavailable", () => {
    const draft = updateDraftTier(validFlatDraft(), 0, { maxInputTokensDisplay: "100" });
    const filled = fillDraftFromReference(draft, reference, 0);
    expect(filled.tiers).toHaveLength(draft.tiers.length);
    expect(filled.cachedInputPerMillionDisplay).toBe("");
    expect(filled.cacheWritePerMillionDisplay).toBe("Unavailable");
    expect(validatePriceDraft({ ...filled, cachedInputPerMillionDisplay: "0" }).payload?.cacheWritePer1M).toBeNull();
    expect(filled.tiers[0]).toEqual(expect.objectContaining({ inputPer1M: "4", cachedInputPer1M: "1", cacheWritePer1M: "5", outputPer1M: "16" }));
  });

  test("round-trips Cache write Unavailable through enabled base and tier prices", () => {
    const draft = createPriceDraftFromEnabled({
      ...flatPrices,
      cacheWritePer1M: null,
      tiers: [{ serviceTier: "standard", tierKey: "long_context", minInputTokens: 101, maxInputTokens: null, ...flatPrices, cacheWritePer1M: null }]
    });
    expect(draft.cacheWritePerMillionDisplay).toBe("Unavailable");
    expect(draft.tiers.find((tier) => tier.tierKey === "long_context")?.cacheWritePer1M).toBe("Unavailable");
    expect(validatePriceDraft(draft).payload).toEqual(expect.objectContaining({
      cacheWritePer1M: null,
      tiers: [expect.objectContaining({ tierKey: "long_context", cacheWritePer1M: null })]
    }));
  });

  test("fills supported reference profiles while exposing batch and flex as read-only candidates", () => {
    const extendedReference: ReferencePriceLike = {
      ...reference,
      contextPrices: [
        ...(reference.contextPrices ?? []),
        { serviceTier: "batch", context: "short_context", minInputTokens: 0, maxInputTokens: 100, inputPer1M: 0.5, cachedInputPer1M: 0.05, cacheWritePer1M: 0.625, outputPer1M: 2 },
        { serviceTier: "flex", context: "long_context", minInputTokens: 101, maxInputTokens: null, inputPer1M: 1, cachedInputPer1M: 0.1, cacheWritePer1M: 1.25, outputPer1M: 4 },
      ],
    };
    const filled = fillSupportedDraftFromReference(validFlatDraft(), extendedReference, 0);
    expect(filled.tiers.find((tier) => tier.serviceTier === "standard" && tier.tierKey === "long_context")).toEqual(
      expect.objectContaining({ inputPer1M: "2", cachedInputPer1M: "0.25", cacheWritePer1M: "3", outputPer1M: "8" }),
    );
    expect(filled.tiers.every((tier) => tier.serviceTier === "standard" || tier.serviceTier === "priority")).toBe(true);
    expect(unsupportedReferenceProfiles(extendedReference).map((tier) => tier.serviceTier)).toEqual(["batch", "flex"]);
    expect(missingReferenceProfileCount(filled, extendedReference)).toBe(0);
  });

  test("adopts missing reference structure without overwriting manual prices", () => {
    const draft = updateDraftTier(validFlatDraft(), 0, { maxInputTokensDisplay: "100", inputPer1M: "99" });
    const adopted = adoptReferenceProfile(draft, reference);
    expect(adopted.tiers).toHaveLength(2);
    expect(adopted.tiers.find((tier) => tier.serviceTier === "priority")?.inputPer1M).toBe("99");
    expect(adopted.tiers.find((tier) => tier.serviceTier === "standard")).toEqual(expect.objectContaining({ tierKey: "long_context", minInputTokensDisplay: "101", maxInputTokensDisplay: "", inputPer1M: "" }));
  });

  test("suggest copies the full provider profile with markup", () => {
    const suggested = createPriceDraftFromProfile({
      ...flatPrices,
      tiers: [{ serviceTier: "standard", tierKey: "long_context", minInputTokens: 101, maxInputTokens: null, ...flatPrices }]
    }, 25);
    expect(suggested.inputPerMillionDisplay).toBe("2.5");
    expect(suggested.tiers.find((tier) => tier.serviceTier === "standard")).toEqual(expect.objectContaining({ minInputTokensDisplay: "101", maxInputTokensDisplay: "", inputPer1M: "2.5", outputPer1M: "10" }));
  });

  test("rejects finite terminal standard coverage while allowing finite priority fallback", () => {
    let draft = addDraftTier(validFlatDraft(), "standard", "long_context");
    draft = updateDraftTier(draft, 0, { minInputTokensDisplay: "101", maxInputTokensDisplay: "200", inputPer1M: "2", cachedInputPer1M: "2", cacheWritePer1M: "2", outputPer1M: "2" });
    draft = updateDraftTier(draft, 1, { maxInputTokensDisplay: "100", inputPer1M: "1", cachedInputPer1M: "1", cacheWritePer1M: "1", outputPer1M: "1" });
    expect(validatePriceDraft(draft).errors).toContain("standard profiles must cover the terminal unbounded range.");
  });
});
