export const PRICE_DIMENSIONS = [
  { key: "inputPer1M", baseKey: "inputPerMillionDisplay", label: "Input" },
  {
    key: "cachedInputPer1M",
    baseKey: "cachedInputPerMillionDisplay",
    label: "Cache read",
  },
  {
    key: "cacheWritePer1M",
    baseKey: "cacheWritePerMillionDisplay",
    label: "Cache write",
  },
  { key: "outputPer1M", baseKey: "outputPerMillionDisplay", label: "Output" },
] as const;

export type PriceDimensionKey = (typeof PRICE_DIMENSIONS)[number]["key"];
export type BasePriceDimensionKey =
  (typeof PRICE_DIMENSIONS)[number]["baseKey"];
export type PriceServiceTier = "standard" | "priority";

export interface PriceTierDraft {
  serviceTier: PriceServiceTier;
  tierKey: string;
  minInputTokensDisplay: string;
  maxInputTokensDisplay: string;
  inputPer1M: string;
  cachedInputPer1M: string;
  cacheWritePer1M: string;
  outputPer1M: string;
}

export interface PriceDraft {
  inputPerMillionDisplay: string;
  cachedInputPerMillionDisplay: string;
  cacheWritePerMillionDisplay: string;
  outputPerMillionDisplay: string;
  tiers: PriceTierDraft[];
}

export interface PriceTierLike {
  serviceTier?: string;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  status?: string;
}

export interface PriceRecordLike {
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  tiers?: PriceTierLike[];
}

export interface ReferenceContextPriceLike {
  serviceTier: string;
  context: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number | null;
  cacheWritePer1M: number | null;
  outputPer1M: number;
}

export interface ReferencePriceLike {
  inputPerMillion: number;
  cachedInputPerMillion: number | null;
  cacheWritePerMillion: number | null;
  outputPerMillion: number;
  contextPrices?: ReferenceContextPriceLike[];
}

export interface NumericPriceTierPayload {
  serviceTier: PriceServiceTier;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
}

export interface NumericPricePayload {
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  tiers?: NumericPriceTierPayload[];
}

export interface PriceDraftValidation {
  payload: NumericPricePayload | null;
  errors: string[];
}

export type PriceTupleDisplay = [string, string, string, string];

export function formatPriceTupleDisplay(values: PriceTupleDisplay): string {
  if (values.every((value) => value.trim() === "")) return "";
  return values.join(", ");
}

export function parsePriceTupleDisplay(value: string): PriceTupleDisplay {
  if (value.trim() === "") return ["", "", "", ""];
  const parts = value.split(",");
  return [
    parts[0]?.trim() ?? "",
    parts[1]?.trim() ?? "",
    parts[2]?.trim() ?? "",
    parts.slice(3).join(",").trim(),
  ];
}

const EMPTY_TIER_PRICES: Pick<PriceTierDraft, PriceDimensionKey> = {
  inputPer1M: "",
  cachedInputPer1M: "",
  cacheWritePer1M: "",
  outputPer1M: "",
};

export function createDefaultPriceDraft(): PriceDraft {
  return {
    inputPerMillionDisplay: "",
    cachedInputPerMillionDisplay: "",
    cacheWritePerMillionDisplay: "",
    outputPerMillionDisplay: "",
    tiers: [createTierDraft("priority", "short_context")],
  };
}

export function createPriceDraftFromEnabled(
  price: PriceRecordLike | null | undefined,
): PriceDraft {
  if (!price) return createDefaultPriceDraft();
  const tiers = enabledTierLikes(price.tiers).map(tierDraftFromPriceTier);
  if (
    !tiers.some(
      (tier) =>
        tier.serviceTier === "priority" && tier.tierKey === "short_context",
    )
  ) {
    tiers.push(createTierDraft("priority", "short_context"));
  }
  return {
    inputPerMillionDisplay: draftNumber(price.inputPer1M),
    cachedInputPerMillionDisplay: draftNumber(price.cachedInputPer1M),
    cacheWritePerMillionDisplay: draftNullablePrice(price.cacheWritePer1M),
    outputPerMillionDisplay: draftNumber(price.outputPer1M),
    tiers: sortDraftTiers(tiers),
  };
}

export function createPriceDraftFromProfile(
  price: PriceRecordLike,
  markupPercent: number,
): PriceDraft {
  const multiplier = 1 + markupPercent / 100;
  const adjusted: PriceRecordLike = {
    inputPer1M: price.inputPer1M * multiplier,
    cachedInputPer1M: price.cachedInputPer1M * multiplier,
    cacheWritePer1M: multiplyNullablePrice(price.cacheWritePer1M, multiplier),
    outputPer1M: price.outputPer1M * multiplier,
    tiers: enabledTierLikes(price.tiers).map((tier) => ({
      ...tier,
      inputPer1M: tier.inputPer1M * multiplier,
      cachedInputPer1M: tier.cachedInputPer1M * multiplier,
      cacheWritePer1M: multiplyNullablePrice(tier.cacheWritePer1M, multiplier),
      outputPer1M: tier.outputPer1M * multiplier,
    })),
  };
  return createPriceDraftFromEnabled(adjusted);
}

export function createTierDraft(
  serviceTier: PriceServiceTier,
  tierKey: string,
): PriceTierDraft {
  return {
    serviceTier,
    tierKey,
    minInputTokensDisplay: tierKey === "short_context" ? "0" : "",
    maxInputTokensDisplay: "",
    ...EMPTY_TIER_PRICES,
  };
}

export function addDraftTier(
  draft: PriceDraft,
  serviceTier: PriceServiceTier,
  tierKey: string,
): PriceDraft {
  if (
    draft.tiers.some(
      (tier) => tier.serviceTier === serviceTier && tier.tierKey === tierKey,
    )
  )
    return draft;
  return {
    ...draft,
    tiers: sortDraftTiers([
      ...draft.tiers,
      createTierDraft(serviceTier, tierKey),
    ]),
  };
}

export function removeDraftTier(
  draft: PriceDraft,
  tierIndex: number,
): PriceDraft {
  return {
    ...draft,
    tiers: draft.tiers.filter((_, index) => index !== tierIndex),
  };
}

export function updateDraftTier(
  draft: PriceDraft,
  tierIndex: number,
  patch: Partial<PriceTierDraft>,
): PriceDraft {
  const tier = draft.tiers[tierIndex];
  if (!tier) return draft;
  const tiers = [...draft.tiers];
  tiers[tierIndex] = { ...tier, ...patch };
  return { ...draft, tiers };
}

export function fillDraftFromReference(
  draft: PriceDraft,
  reference: ReferencePriceLike,
  markupPercent: number,
): PriceDraft {
  const multiplier = 1 + markupPercent / 100;
  const candidates = referenceCandidates(reference);
  const base = candidates.find(
    (candidate) =>
      candidate.serviceTier === "standard" &&
      candidate.tierKey === "short_context" &&
      candidate.minInputTokens === 0,
  );
  const next: PriceDraft = base
    ? {
        ...draft,
        inputPerMillionDisplay: priceDisplay(base.inputPer1M, multiplier),
        cachedInputPerMillionDisplay: priceDisplay(
          base.cachedInputPer1M,
          multiplier,
        ),
        cacheWritePerMillionDisplay: cacheWritePriceDisplay(
          base.cacheWritePer1M,
          multiplier,
        ),
        outputPerMillionDisplay: priceDisplay(base.outputPer1M, multiplier),
      }
    : { ...draft };
  next.tiers = draft.tiers.map((tier) => {
    const match = candidates.find(
      (candidate) => stableTierKey(candidate) === stableTierKeyFromDraft(tier),
    );
    if (!match) return tier;
    return {
      ...tier,
      inputPer1M: priceDisplay(match.inputPer1M, multiplier),
      cachedInputPer1M: priceDisplay(match.cachedInputPer1M, multiplier),
      cacheWritePer1M: cacheWritePriceDisplay(match.cacheWritePer1M, multiplier),
      outputPer1M: priceDisplay(match.outputPer1M, multiplier),
    };
  });
  return next;
}

export function fillSupportedDraftFromReference(
  draft: PriceDraft,
  reference: ReferencePriceLike,
  markupPercent: number,
): PriceDraft {
  return fillDraftFromReference(adoptReferenceProfile(draft, reference), reference, markupPercent);
}

export function unsupportedReferenceProfiles(reference: ReferencePriceLike): ReferenceContextPriceLike[] {
  return (reference.contextPrices ?? [])
    .filter((tier) => tier.serviceTier === "batch" || tier.serviceTier === "flex")
    .sort(
      (left, right) =>
        left.serviceTier.localeCompare(right.serviceTier) ||
        left.minInputTokens - right.minInputTokens ||
        left.context.localeCompare(right.context),
    );
}

export function missingReferenceProfileCount(
  draft: PriceDraft,
  reference: ReferencePriceLike,
): number {
  const draftKeys = new Set([
    stableTierKey({
      serviceTier: "standard",
      tierKey: "short_context",
      minInputTokens: 0,
      maxInputTokens: baseMaxInputTokens(reference),
    }),
    ...draft.tiers.map(stableTierKeyFromDraft),
  ]);
  return referenceCandidates(reference).filter(
    (candidate) => candidate.serviceTier === "standard" || candidate.serviceTier === "priority",
  ).filter(
    (candidate) => !draftKeys.has(stableTierKey(candidate)),
  ).length;
}

export function adoptReferenceProfile(
  draft: PriceDraft,
  reference: ReferencePriceLike,
): PriceDraft {
  const existingKeys = new Set(draft.tiers.map(stableTierKeyFromDraft));
  const additions = referenceCandidates(reference)
    .filter(
      (candidate) =>
        !(
          candidate.serviceTier === "standard" &&
          candidate.tierKey === "short_context" &&
          candidate.minInputTokens === 0
        ),
    )
    .filter((candidate) => !existingKeys.has(stableTierKey(candidate)))
    .filter(
      (
        candidate,
      ): candidate is ReferenceCandidate & { serviceTier: PriceServiceTier } =>
        candidate.serviceTier === "standard" ||
        candidate.serviceTier === "priority",
    )
    .map((candidate) => ({
      ...createTierDraft(candidate.serviceTier, candidate.tierKey),
      minInputTokensDisplay: String(candidate.minInputTokens),
      maxInputTokensDisplay:
        candidate.maxInputTokens === null
          ? ""
          : String(candidate.maxInputTokens),
    }));
  return additions.length === 0
    ? draft
    : { ...draft, tiers: sortDraftTiers([...draft.tiers, ...additions]) };
}

export function validatePriceDraft(draft: PriceDraft): PriceDraftValidation {
  const errors: string[] = [];
  const baseValues = PRICE_DIMENSIONS.map((dimension) =>
    parseConfiguredPrice(
      draft[dimension.baseKey],
      `standard / short_context ${dimension.label}`,
      dimension.key === "cacheWritePer1M",
      errors,
    ),
  );
  const payloadTiers: NumericPriceTierPayload[] = [];

  draft.tiers.forEach((tier, tierIndex) => {
    const label = `${tier.serviceTier} / ${tier.tierKey}`;
    const priceDisplays = PRICE_DIMENSIONS.map(
      (dimension) => tier[dimension.key],
    );
    if (priceDisplays.every((value) => value.trim() === "")) return;
    if (priceDisplays.some((value) => value.trim() === "")) {
      errors.push(
        `${label}: fill all four price fields or leave the entire profile empty.`,
      );
      return;
    }
    const prices = PRICE_DIMENSIONS.map((dimension) =>
      parseConfiguredPrice(
        tier[dimension.key],
        `${label} ${dimension.label}`,
        dimension.key === "cacheWritePer1M",
        errors,
      ),
    );
    const minInputTokens = parseRequiredTokenBoundary(
      tier.minInputTokensDisplay,
      `${label} minimum input tokens`,
      errors,
    );
    const maxInputTokens = parseOptionalTokenBoundary(
      tier.maxInputTokensDisplay,
      `${label} maximum input tokens`,
      errors,
    );
    if (
      minInputTokens !== null &&
      maxInputTokens !== null &&
      maxInputTokens < minInputTokens
    ) {
      errors.push(
        `${label}: maximum input tokens must be greater than or equal to the minimum.`,
      );
    }
    if (prices.some((value) => value === undefined) || minInputTokens === null)
      return;
    payloadTiers.push({
      serviceTier: tier.serviceTier,
      tierKey: tier.tierKey,
      minInputTokens,
      maxInputTokens,
      inputPer1M: prices[0]!,
      cachedInputPer1M: prices[1]!,
      cacheWritePer1M: prices[2] ?? null,
      outputPer1M: prices[3]!,
    });
    void tierIndex;
  });

  validateTierRanges(payloadTiers, errors);
  if (errors.length > 0 || baseValues.some((value) => value === undefined))
    return { payload: null, errors };
  return {
    payload: {
      inputPer1M: baseValues[0]!,
      cachedInputPer1M: baseValues[1]!,
      cacheWritePer1M: baseValues[2] ?? null,
      outputPer1M: baseValues[3]!,
      ...(payloadTiers.length > 0 ? { tiers: payloadTiers } : {}),
    },
    errors: [],
  };
}

export function draftNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(6).replace(/0+$/g, "").replace(/\.$/, "");
}

interface ReferenceCandidate {
  serviceTier: string;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number | null;
  cachedInputPer1M: number | null;
  cacheWritePer1M: number | null;
  outputPer1M: number | null;
}

function referenceCandidates(
  reference: ReferencePriceLike,
): ReferenceCandidate[] {
  const context = (reference.contextPrices ?? []).map((tier) => ({
    serviceTier: tier.serviceTier,
    tierKey: tier.context,
    minInputTokens: tier.minInputTokens,
    maxInputTokens: tier.maxInputTokens,
    inputPer1M: tier.inputPer1M,
    cachedInputPer1M: tier.cachedInputPer1M,
    cacheWritePer1M: tier.cacheWritePer1M,
    outputPer1M: tier.outputPer1M,
  }));
  if (
    !context.some(
      (tier) =>
        tier.serviceTier === "standard" &&
        tier.tierKey === "short_context" &&
        tier.minInputTokens === 0,
    )
  ) {
    context.unshift({
      serviceTier: "standard",
      tierKey: "short_context",
      minInputTokens: 0,
      maxInputTokens: baseMaxInputTokens(reference),
      inputPer1M: reference.inputPerMillion,
      cachedInputPer1M: reference.cachedInputPerMillion,
      cacheWritePer1M: reference.cacheWritePerMillion,
      outputPer1M: reference.outputPerMillion,
    });
  }
  return context;
}

function baseMaxInputTokens(reference: ReferencePriceLike): number | null {
  const explicit = (reference.contextPrices ?? []).find(
    (tier) =>
      tier.serviceTier === "standard" &&
      tier.context === "short_context" &&
      tier.minInputTokens === 0,
  );
  return explicit?.maxInputTokens ?? null;
}

function enabledTierLikes(tiers: PriceTierLike[] | undefined): PriceTierLike[] {
  return (tiers ?? [])
    .filter((tier) => tier.status === undefined || tier.status === "enabled")
    .filter(
      (tier) =>
        !(
          (tier.serviceTier ?? "standard") === "standard" &&
          tier.tierKey === "short_context" &&
          tier.minInputTokens === 0
        ),
    );
}

function tierDraftFromPriceTier(tier: PriceTierLike): PriceTierDraft {
  return {
    serviceTier: tier.serviceTier === "priority" ? "priority" : "standard",
    tierKey: tier.tierKey,
    minInputTokensDisplay: String(tier.minInputTokens),
    maxInputTokensDisplay:
      tier.maxInputTokens === null ? "" : String(tier.maxInputTokens),
    inputPer1M: draftNumber(tier.inputPer1M),
    cachedInputPer1M: draftNumber(tier.cachedInputPer1M),
    cacheWritePer1M: draftNullablePrice(tier.cacheWritePer1M),
    outputPer1M: draftNumber(tier.outputPer1M),
  };
}

function sortDraftTiers(tiers: PriceTierDraft[]): PriceTierDraft[] {
  const serviceOrder = { standard: 0, priority: 1 } as const;
  return [...tiers].sort(
    (left, right) =>
      serviceOrder[left.serviceTier] - serviceOrder[right.serviceTier] ||
      boundarySortValue(left.minInputTokensDisplay) -
        boundarySortValue(right.minInputTokensDisplay) ||
      left.tierKey.localeCompare(right.tierKey),
  );
}

function boundarySortValue(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : Number.MAX_SAFE_INTEGER;
}

function stableTierKey(
  tier: Pick<
    ReferenceCandidate,
    "serviceTier" | "tierKey" | "minInputTokens" | "maxInputTokens"
  >,
): string {
  return `${tier.serviceTier}:${tier.tierKey}:${tier.minInputTokens}:${tier.maxInputTokens ?? "max"}`;
}

function stableTierKeyFromDraft(tier: PriceTierDraft): string {
  const min = parseBoundaryForKey(tier.minInputTokensDisplay);
  const max =
    tier.maxInputTokensDisplay.trim() === ""
      ? null
      : parseBoundaryForKey(tier.maxInputTokensDisplay);
  return `${tier.serviceTier}:${tier.tierKey}:${min}:${max ?? "max"}`;
}

function parseBoundaryForKey(value: string): number | string {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : `invalid:${value}`;
}

function priceDisplay(value: number | null, multiplier: number): string {
  return value === null ? "" : draftNumber(value * multiplier);
}

function cacheWritePriceDisplay(value: number | null, multiplier: number): string {
  return value === null ? "Unavailable" : draftNumber(value * multiplier);
}

function parseConfiguredPrice(
  value: string,
  label: string,
  allowUnavailable: boolean,
  errors: string[],
): number | null | undefined {
  if (value.trim() === "") {
    errors.push(`${label} is required.`);
    return undefined;
  }
  if (allowUnavailable && value.trim().toLowerCase() === "unavailable") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    errors.push(`${label} must be a non-negative number${allowUnavailable ? " or Unavailable" : ""}.`);
    return undefined;
  }
  return parsed;
}

function draftNullablePrice(value: number | null): string {
  return value === null ? "Unavailable" : draftNumber(value);
}

function multiplyNullablePrice(value: number | null, multiplier: number): number | null {
  return value === null ? null : value * multiplier;
}

function parseRequiredTokenBoundary(
  value: string,
  label: string,
  errors: string[],
): number | null {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    errors.push(`${label} must be a non-negative integer.`);
    return null;
  }
  return parsed;
}

function parseOptionalTokenBoundary(
  value: string,
  label: string,
  errors: string[],
): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    errors.push(
      `${label} must be a non-negative integer or blank for no upper bound.`,
    );
    return null;
  }
  return parsed;
}

function validateTierRanges(
  tiers: NumericPriceTierPayload[],
  errors: string[],
) {
  for (const serviceTier of ["standard", "priority"] as const) {
    const serviceTiers = tiers
      .filter((tier) => tier.serviceTier === serviceTier)
      .sort((left, right) => left.minInputTokens - right.minInputTokens);
    for (let index = 1; index < serviceTiers.length; index += 1) {
      const previous = serviceTiers[index - 1]!;
      const current = serviceTiers[index]!;
      if (
        previous.maxInputTokens === null ||
        current.minInputTokens <= previous.maxInputTokens
      ) {
        errors.push(`${serviceTier} profiles overlap at ${current.tierKey}.`);
      } else if (current.minInputTokens !== previous.maxInputTokens + 1) {
        errors.push(
          `${serviceTier} profiles have a gap before ${current.tierKey}.`,
        );
      }
    }
    if (
      serviceTier === "standard" &&
      serviceTiers.length > 0 &&
      serviceTiers.at(-1)?.maxInputTokens !== null
    ) {
      errors.push("standard profiles must cover the terminal unbounded range.");
    }
  }
}
