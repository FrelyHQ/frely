import type { PriceTierDraft } from "../form/price-draft";
import type { AccessPointPrice, OpenAiReferencePrice, PriceTierSummary, ProviderModelCost } from "../types";

function formatMoneyPerMillion(valuePer1M: number) {
  return `$${valuePer1M.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

export function referencePriceProfile(price: OpenAiReferencePrice) {
  const tiers = referencePriceTiers(price);
  return (
    <PriceProfileDisplay
      base={{
        serviceTier: "standard",
        tierKey: "short_context",
        label: "standard / short",
        range: baseStandardRange(tiers),
        inputPer1M: price.inputPerMillion,
        cachedInputPer1M: price.cachedInputPerMillion,
        cacheWritePer1M: price.cacheWritePerMillion,
        outputPer1M: price.outputPerMillion,
      }}
      tiers={priceProfileRowsFromTiers(tiers)}
    />
  );
}

export function referencePriceProfileRows(price: OpenAiReferencePrice, includeUnsupported = true): PriceProfileDisplayRow[] {
  const tiers = referencePriceTiers(price).filter(
    (tier) => includeUnsupported || (tier.serviceTier !== "batch" && tier.serviceTier !== "flex"),
  );
  return [{
    serviceTier: "standard",
    tierKey: "short_context",
    label: "standard / short",
    range: baseStandardRange(tiers),
    inputPer1M: price.inputPerMillion,
    cachedInputPer1M: price.cachedInputPerMillion,
    cacheWritePer1M: price.cacheWritePerMillion,
    outputPer1M: price.outputPerMillion,
  }, ...priceProfileRowsFromTiers(tiers)];
}

export function enabledPriceProfileRows(
  price: Pick<ProviderModelCost | AccessPointPrice, "inputPer1M" | "cachedInputPer1M" | "cacheWritePer1M" | "outputPer1M" | "tiers">,
): PriceProfileDisplayRow[] {
  const tiers = enabledPriceTiers(price);
  return [{
    serviceTier: "standard",
    tierKey: "short_context",
    label: "standard / short",
    range: baseStandardRange(tiers),
    inputPer1M: price.inputPer1M,
    cachedInputPer1M: price.cachedInputPer1M,
    cacheWritePer1M: price.cacheWritePer1M,
    outputPer1M: price.outputPer1M,
  }, ...priceProfileRowsFromTiers(tiers)];
}

export function priceTripletFromPer1M(
  price: Pick<ProviderModelCost | AccessPointPrice, "inputPer1M" | "cachedInputPer1M" | "cacheWritePer1M" | "outputPer1M" | "tiers">,
) {
  const enabledTiers = enabledPriceTiers(price);
  return (
    <PriceProfileDisplay
      base={{
        serviceTier: "standard",
        tierKey: "short_context",
        label: "standard / short",
        range: baseStandardRange(enabledTiers),
        inputPer1M: price.inputPer1M,
        cachedInputPer1M: price.cachedInputPer1M,
        cacheWritePer1M: price.cacheWritePer1M,
        outputPer1M: price.outputPer1M,
      }}
      tiers={priceProfileRowsFromTiers(enabledTiers)}
    />
  );
}

function PriceProfileDisplay({ base, tiers }: { base: PriceProfileDisplayRow; tiers: PriceProfileDisplayRow[] }) {
  return (
    <div className="price-profile-display">
      <div className="price-profile-header" aria-hidden="true">
        <span>Tier</span>
        <span>Input</span>
        <span>Cache read</span>
        <span>Cache write</span>
        <span>Output</span>
      </div>
      {[base, ...tiers].map((tier) => (
        <div className="price-profile-row" key={`${tier.label}:${tier.range}`}>
          <span className="price-profile-tier">
            <strong>{tier.label}</strong>
            <small>{tier.range}</small>
          </span>
          <span>{formatMoneyPerMillion(tier.inputPer1M)}</span>
          <span>{tier.cachedInputPer1M === null ? "Unavailable" : formatMoneyPerMillion(tier.cachedInputPer1M)}</span>
          <span>{tier.cacheWritePer1M === null ? "Unavailable" : formatMoneyPerMillion(tier.cacheWritePer1M)}</span>
          <span>{formatMoneyPerMillion(tier.outputPer1M)}</span>
        </div>
      ))}
    </div>
  );
}

export interface PriceProfileDisplayRow {
  serviceTier: string;
  tierKey: string;
  label: string;
  range: string;
  inputPer1M: number;
  cachedInputPer1M: number | null;
  cacheWritePer1M: number | null;
  outputPer1M: number;
}

function baseStandardRange(tiers: Array<Pick<PriceTierSummary, "serviceTier" | "minInputTokens">>) {
  const firstStandardTier = tiers
    .filter((tier) => (tier.serviceTier ?? "standard") === "standard" && tier.minInputTokens > 0)
    .sort((left, right) => left.minInputTokens - right.minInputTokens)[0];
  return firstStandardTier
    ? formatTokenRange({
        minInputTokens: 0,
        maxInputTokens: firstStandardTier.minInputTokens - 1,
      })
    : "flat";
}

function priceProfileRowsFromTiers(
  tiers: Array<
    Pick<
      PriceTierSummary,
      "serviceTier" | "tierKey" | "minInputTokens" | "maxInputTokens" | "inputPer1M" | "cachedInputPer1M" | "cacheWritePer1M" | "outputPer1M"
    >
  >,
): PriceProfileDisplayRow[] {
  return tiers.map((tier) => ({
    serviceTier: tier.serviceTier ?? "standard",
    tierKey: tier.tierKey,
    label: formatPriceTierLabel(tier.serviceTier, tier.tierKey),
    range: formatTokenRange(tier),
    inputPer1M: tier.inputPer1M,
    cachedInputPer1M: tier.cachedInputPer1M,
    cacheWritePer1M: tier.cacheWritePer1M,
    outputPer1M: tier.outputPer1M,
  }));
}

export function formatPriceTierLabel(serviceTier: string | null | undefined, tierKey: string) {
  const displayTierKey = tierKey === "short_context" ? "short" : tierKey === "long_context" ? "long" : tierKey;
  return `${serviceTier ?? "standard"} / ${displayTierKey}`;
}

function referencePriceTiers(price: OpenAiReferencePrice): Array<Omit<PriceTierSummary, "status">> {
  return (price.contextPrices ?? [])
    .filter((tier) => !(tier.serviceTier === "standard" && tier.context === "short_context"))
    .map((tier) => ({
      serviceTier: tier.serviceTier,
      tierKey: tier.context,
      minInputTokens: tier.minInputTokens,
      maxInputTokens: tier.maxInputTokens,
      inputPer1M: tier.inputPer1M,
      cachedInputPer1M: tier.cachedInputPer1M ?? Number.NaN,
      cacheWritePer1M: tier.cacheWritePer1M,
      outputPer1M: tier.outputPer1M,
    }));
}

function enabledPriceTiers(price: Pick<ProviderModelCost | AccessPointPrice, "tiers">) {
  return (price.tiers ?? [])
    .filter((tier) => tier.status === "enabled" && !(tier.serviceTier === "standard" && tier.tierKey === "short_context"))
    .sort(
      (left, right) =>
        String(left.serviceTier ?? "standard").localeCompare(String(right.serviceTier ?? "standard")) ||
        left.minInputTokens - right.minInputTokens ||
        left.tierKey.localeCompare(right.tierKey),
    );
}

export function referencePriceEqualsCurrent(referencePrice: OpenAiReferencePrice, currentPrice: ProviderModelCost) {
  if (
    referencePrice.cachedInputPerMillion === null ||
    !numbersEqual(referencePrice.inputPerMillion, currentPrice.inputPer1M) ||
    !numbersEqual(referencePrice.cachedInputPerMillion, currentPrice.cachedInputPer1M) ||
    !nullableNumbersEqual(referencePrice.cacheWritePerMillion, currentPrice.cacheWritePer1M) ||
    !numbersEqual(referencePrice.outputPerMillion, currentPrice.outputPer1M)
  )
    return false;
  const referenceTiers = referencePriceTiers(referencePrice);
  const currentTiers = enabledPriceTiers(currentPrice);
  if (referenceTiers.length !== currentTiers.length) return false;
  return referenceTiers.every((referenceTier, index) => {
    const currentTier = currentTiers[index]!;
    return (
      String(referenceTier.serviceTier ?? "standard") === String(currentTier.serviceTier ?? "standard") &&
      String(referenceTier.tierKey ?? "") === currentTier.tierKey &&
      referenceTier.minInputTokens === currentTier.minInputTokens &&
      referenceTier.maxInputTokens === currentTier.maxInputTokens &&
      numbersEqual(referenceTier.inputPer1M, currentTier.inputPer1M) &&
      numbersEqual(referenceTier.cachedInputPer1M, currentTier.cachedInputPer1M) &&
      nullableNumbersEqual(referenceTier.cacheWritePer1M, currentTier.cacheWritePer1M) &&
      numbersEqual(referenceTier.outputPer1M, currentTier.outputPer1M)
    );
  });
}

function numbersEqual(left: number, right: number) {
  return Math.abs(left - right) < 0.0000001;
}

function nullableNumbersEqual(left: number | null, right: number | null) {
  return left === null || right === null ? left === right : numbersEqual(left, right);
}

function formatTokenRange(tier: Pick<PriceTierSummary, "minInputTokens" | "maxInputTokens">) {
  const min = tier.minInputTokens.toLocaleString();
  const max = tier.maxInputTokens === null ? "unbounded" : tier.maxInputTokens.toLocaleString();
  return `${min}-${max}`;
}

export function formatDraftTokenRange(tier: Pick<PriceTierDraft, "minInputTokensDisplay" | "maxInputTokensDisplay">) {
  const min = tier.minInputTokensDisplay.trim() || "?";
  const max = tier.maxInputTokensDisplay.trim() || "unbounded";
  return `${min}-${max}`;
}

export function formatPricePerMillion(value: number) {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}
