import { RelayError } from "@frely/core";
import type { AccessPointPrice, AsyncApplicationOperationPort, BillableAccessPointPrice, PriceServiceTier, ProviderModelCost } from "@frely/application/runtime";

const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing?latest-pricing=standard";
const OPENAI_PRICING_TIMEOUT_MS = 10_000;
const OPENAI_PRICING_MAX_BODY_BYTES = 2 * 1024 * 1024;
const OPENAI_PRICING_PARSER_VERSION = 4;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface PriceUsageInput {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
  outputTokens: number;
}

export interface BillingPriceInput extends PriceUsageInput {
  accessPointId: string;
  providerId: string;
  providerModelName: string;
  serviceTier?: string;
  requireServiceTier?: boolean;
}

export interface ResolvedBillingPriceInput extends PriceUsageInput {
  accessPointPrice: BillableAccessPointPrice;
  providerModelCost: ProviderModelCost;
  serviceTier?: string;
  requireServiceTier?: boolean;
}

export interface BillingPriceResult {
  billableAmount: number;
  providerCostAmount: number;
  grossMarginAmount: number;
  accessPointPrice: BillableAccessPointPrice | null;
  providerModelCost: ProviderModelCost | null;
}

export type GatewayPriceCalculation = BillingPriceResult & {
  accessPointPrice: SelectedPrice<BillableAccessPointPrice>;
  providerModelCost: SelectedPrice<ProviderModelCost>;
};

export interface SelectedPriceTier {
  serviceTier: PriceServiceTier;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M: number | null;
  outputPer1M: number;
}

export type SelectedPrice<T> = T & {
  selectedServiceTier: PriceServiceTier;
  selectedTierKey: string;
  selectedTier: SelectedPriceTier;
  effectiveTiers: SelectedPriceTier[];
};

export interface OpenAiOfficialPrice {
  source: "openai-official";
  model: string;
  displayName: string;
  inputPerMillion: number;
  cachedInputPerMillion: number | null;
  cacheWritePerMillion: number | null;
  outputPerMillion: number;
  inputPer1M: number;
  cachedInputPer1M: number | null;
  cacheWritePer1M: number | null;
  outputPer1M: number;
  contextPrices?: OpenAiOfficialContextPrice[];
  sourceUrl: string;
  fetchedAt: string;
  parserVersion: number;
}

export interface OpenAiOfficialContextPrice {
  serviceTier: "standard" | "batch" | "flex" | "priority";
  context: "short_context" | "long_context";
  minInputTokens: number;
  maxInputTokens: number | null;
  inputPer1M: number;
  cachedInputPer1M: number | null;
  cacheWritePer1M: number | null;
  outputPer1M: number;
}

export interface OpenAiOfficialPricingReference {
  source: "openai-official-reference";
  sourceUrl: string;
  fetchedAt: string;
  parserVersion: number;
  items: OpenAiOfficialPrice[];
}

/**
 * External pricing lookup. The fixed local cost is read asynchronously and
 * the public reference is fetched outside the database path.
 */
export class AsyncExternalPricingService {
  constructor(readonly repo: Pick<AsyncApplicationOperationPort, "findEnabledProviderModelCost">, readonly fetcher: Fetcher = fetch) {}

  async lookupExternal(providerId: string, providerModelName: string) {
    const fixed = await this.repo.findEnabledProviderModelCost(providerId, providerModelName);
    const reference = await this.lookupOpenAiReferencePrices();
    const openAiOfficial = findOpenAiPrice(reference.items, providerModelName);
    if (!openAiOfficial) throw new RelayError("openai_model_price_not_found", `OpenAI official pricing for ${providerModelName} was not found`, 404);
    return {
      providerId,
      providerModelName,
      candidates: [
        fixed && { source: "fixed-local-provider-cost", inputPer1M: fixed.inputPer1M, cachedInputPer1M: fixed.cachedInputPer1M, cacheWritePer1M: fixed.cacheWritePer1M, outputPer1M: fixed.outputPer1M },
        openAiOfficial
      ].filter(Boolean)
    };
  }

  lookupOpenAiReferencePrices(): Promise<OpenAiOfficialPricingReference> {
    return lookupOpenAiReferencePrices(this.fetcher);
  }
}

async function lookupOpenAiReferencePrices(fetcher: Fetcher): Promise<OpenAiOfficialPricingReference> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_PRICING_TIMEOUT_MS);
  const response = await fetcher(OPENAI_PRICING_URL, {
    signal: controller.signal,
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    }
  }).catch((error: unknown) => {
    clearTimeout(timeout);
    if (controller.signal.aborted) throw new RelayError("openai_pricing_timeout", "OpenAI pricing lookup timed out", 504);
    throw new RelayError("openai_pricing_unavailable", messageFromUnknown(error), 502);
  });
  if (!response.ok) {
    clearTimeout(timeout);
    throw new RelayError("openai_pricing_http_error", `OpenAI pricing page returned HTTP ${response.status}`, 502);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > OPENAI_PRICING_MAX_BODY_BYTES) {
    clearTimeout(timeout);
    throw new RelayError("openai_pricing_body_too_large", "OpenAI pricing response exceeded the size limit", 502);
  }
  const html = await response.text().catch((error: unknown) => {
    if (controller.signal.aborted) throw new RelayError("openai_pricing_timeout", "OpenAI pricing lookup timed out", 504);
    throw new RelayError("openai_pricing_unavailable", messageFromUnknown(error), 502);
  }).finally(() => clearTimeout(timeout));
  if (new TextEncoder().encode(html).byteLength > OPENAI_PRICING_MAX_BODY_BYTES) throw new RelayError("openai_pricing_body_too_large", "OpenAI pricing response exceeded the size limit", 502);
  const reference = parseOpenAiOfficialPricingTableHtml(html, new Date().toISOString());
  if (reference.items.length === 0) throw new RelayError("openai_pricing_schema_unsupported", "OpenAI official pricing schema is unsupported", 502);
  return reference;
}

/** Calculates a quote without consulting a repository. Useful for async adapters after the prices are read. */
export function calculateResolvedPrice(input: ResolvedBillingPriceInput): GatewayPriceCalculation {
  const selectedAccessPointPrice = selectPriceForUsage(input.accessPointPrice, input.inputTokens, input.serviceTier, input.requireServiceTier);
  const selectedProviderModelCost = selectPriceForUsage(input.providerModelCost, input.inputTokens, input.serviceTier, input.requireServiceTier);
  const billableAmount = calculateTokenAmount(selectedAccessPointPrice.selectedTier, input);
  const providerCostAmount = calculateTokenAmount(selectedProviderModelCost.selectedTier, input);
  return {
    billableAmount,
    providerCostAmount,
    grossMarginAmount: billableAmount - providerCostAmount,
    accessPointPrice: selectedAccessPointPrice,
    providerModelCost: selectedProviderModelCost,
  };
}

function calculatePriceFromValues(
  accessPointPrice: BillableAccessPointPrice | null,
  providerModelCost: ProviderModelCost | null,
  input: PriceUsageInput & { serviceTier?: string; requireServiceTier?: boolean },
): BillingPriceResult {
  const selectedAccessPointPrice = accessPointPrice ? selectPriceForUsage(accessPointPrice, input.inputTokens, input.serviceTier, input.requireServiceTier) : null;
  const selectedProviderModelCost = providerModelCost ? selectPriceForUsage(providerModelCost, input.inputTokens, input.serviceTier, input.requireServiceTier) : null;
  const billableAmount = selectedAccessPointPrice ? calculateTokenAmount(selectedAccessPointPrice.selectedTier, input) : 0;
  const providerCostAmount = selectedProviderModelCost ? calculateTokenAmount(selectedProviderModelCost.selectedTier, input) : 0;
  return {
    billableAmount,
    providerCostAmount,
    grossMarginAmount: billableAmount - providerCostAmount,
    accessPointPrice: selectedAccessPointPrice ?? accessPointPrice,
    providerModelCost: selectedProviderModelCost ?? providerModelCost
  };
}

export function amountForPriceProfile(price: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M?: number | null; outputPer1M: number; tiers?: PriceTierLike[] }, usage: PriceUsageInput, serviceTier?: string, requireServiceTier = false): number {
  return calculateTokenAmount(selectPriceForUsage(price, usage.inputTokens, serviceTier, requireServiceTier).selectedTier, usage);
}

export function selectPriceForUsage<T extends { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M?: number | null; outputPer1M: number; tiers?: PriceTierLike[] }>(price: T, inputTokens: number, serviceTier?: string, requireServiceTier = false): SelectedPrice<T> {
  const requestedServiceTier = normalizeRuntimePriceServiceTier(serviceTier);
  const standardProfile = effectiveServiceTierProfile(price, "standard");
  const requestedProfile = requestedServiceTier === "standard" ? standardProfile : effectiveServiceTierProfile(price, requestedServiceTier, false);
  const requestedTier = findTierForInputTokens(requestedProfile, inputTokens);
  if (requireServiceTier && requestedServiceTier !== "standard" && !requestedTier) {
    throw new RelayError("service_tier_price_not_configured", `No ${requestedServiceTier} price tier is configured for this request`, 500);
  }
  const selectedTier = requestedTier ?? findTierForInputTokens(standardProfile, inputTokens);
  if (!selectedTier) throw new RelayError("price_tier_not_available", "No enabled price tier is available for this request", 500);
  const effectiveTiers = requestedProfile.length > 0 && findTierForInputTokens(requestedProfile, inputTokens) ? requestedProfile : standardProfile;
  return {
    ...price,
    selectedServiceTier: selectedTier.serviceTier,
    selectedTierKey: selectedTier.tierKey,
    selectedTier,
    effectiveTiers
  };
}

export function normalizeRuntimePriceServiceTier(value: string | undefined | null): PriceServiceTier {
  const normalized = String(value ?? "standard").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "priority" || normalized === "fast") return "priority";
  return "standard";
}

function effectiveServiceTierProfile(price: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M?: number | null; outputPer1M: number; tiers?: PriceTierLike[] }, serviceTier: PriceServiceTier, includeImplicitStandard = true): SelectedPriceTier[] {
  const enabledTiers = (price.tiers ?? [])
    .filter((tier) => normalizeStoredPriceServiceTier(tier.serviceTier) === serviceTier && normalizeStatus(tier.status) === "enabled")
    .map((tier) => ({
      serviceTier,
      tierKey: tier.tierKey,
      minInputTokens: tier.minInputTokens,
      maxInputTokens: tier.maxInputTokens ?? null,
      inputPer1M: tier.inputPer1M,
      cachedInputPer1M: tier.cachedInputPer1M,
      cacheWritePer1M: tier.cacheWritePer1M === undefined ? tier.inputPer1M : tier.cacheWritePer1M,
      outputPer1M: tier.outputPer1M
    }))
    .sort((left, right) => left.minInputTokens - right.minInputTokens || left.tierKey.localeCompare(right.tierKey));
  if (serviceTier !== "standard" || !includeImplicitStandard) return enabledTiers;
  const first = enabledTiers[0];
  if (!first) {
    return [implicitStandardTier(price, null)];
  }
  if (first.minInputTokens > 0) {
    return [implicitStandardTier(price, first.minInputTokens - 1), ...enabledTiers];
  }
  return enabledTiers;
}

function implicitStandardTier(price: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M?: number | null; outputPer1M: number }, maxInputTokens: number | null): SelectedPriceTier {
  return {
    serviceTier: "standard",
    tierKey: "short_context",
    minInputTokens: 0,
    maxInputTokens,
    inputPer1M: price.inputPer1M,
    cachedInputPer1M: price.cachedInputPer1M,
    cacheWritePer1M: price.cacheWritePer1M === undefined ? price.inputPer1M : price.cacheWritePer1M,
    outputPer1M: price.outputPer1M
  };
}

function findTierForInputTokens(tiers: SelectedPriceTier[], inputTokens: number): SelectedPriceTier | null {
  const normalizedInputTokens = Math.max(0, Math.floor(inputTokens));
  return tiers.find((tier) => normalizedInputTokens >= tier.minInputTokens && (tier.maxInputTokens === null || normalizedInputTokens <= tier.maxInputTokens)) ?? null;
}

interface PriceTierLike {
  serviceTier?: string | null;
  tierKey: string;
  minInputTokens: number;
  maxInputTokens?: number | null;
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M?: number | null;
  outputPer1M: number;
  status?: string | null;
}

function normalizeStoredPriceServiceTier(value: string | undefined | null): PriceServiceTier {
  const normalized = String(value ?? "standard").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "priority") return "priority";
  if (normalized === "batch") return "batch";
  if (normalized === "flex") return "flex";
  return "standard";
}

function normalizeStatus(value: string | undefined | null): "enabled" | "disabled" {
  return value === "disabled" || value === "inactive" || value === "archived" || value === "paused" ? "disabled" : "enabled";
}

export function calculateTokenAmount(price: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number }, input: PriceUsageInput): number {
  const inputTokens = finiteNonNegativeInteger(input.inputTokens);
  const cachedInputTokens = Math.min(finiteNonNegativeInteger(input.cachedInputTokens), inputTokens);
  const cacheWriteTokens = Math.min(finiteNonNegativeInteger(input.cacheWriteTokens ?? 0), inputTokens - cachedInputTokens);
  const outputTokens = finiteNonNegativeInteger(input.outputTokens);
  const inputPer1M = finiteNonNegativePrice(price.inputPer1M, "inputPer1M");
  const cachedInputPer1M = finiteNonNegativePrice(price.cachedInputPer1M, "cachedInputPer1M");
  const cacheWritePer1M = price.cacheWritePer1M === null ? null : finiteNonNegativePrice(price.cacheWritePer1M, "cacheWritePer1M");
  const outputPer1M = finiteNonNegativePrice(price.outputPer1M, "outputPer1M");
  if (cacheWriteTokens > 0 && price.cacheWritePer1M === null) {
    throw new RelayError("unexpected_cache_write_usage", "The provider returned Cache write usage for a price tier configured as Unavailable", 500);
  }
  const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteTokens;
  const amount = (uncachedInputTokens / 1_000_000) * inputPer1M
    + (cachedInputTokens / 1_000_000) * cachedInputPer1M
    + (cacheWriteTokens / 1_000_000) * (cacheWritePer1M ?? 0)
    + (outputTokens / 1_000_000) * outputPer1M;
  if (!Number.isFinite(amount)) throw new RelayError("invalid_price_profile", "Calculated token amount must be finite", 500);
  return amount;
}

function finiteNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finiteNonNegativePrice(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RelayError("invalid_price_profile", `Selected price profile field ${field} must be a finite non-negative number`, 500);
  }
  return value;
}

export function parseOpenAiOfficialPricingHtml(html: string, providerModelName: string, fetchedAt = new Date().toISOString()): OpenAiOfficialPrice | null {
  return findOpenAiPrice(parseOpenAiOfficialPricingTableHtml(html, fetchedAt).items, providerModelName);
}

export function parseOpenAiOfficialPricingTableHtml(html: string, fetchedAt = new Date().toISOString()): OpenAiOfficialPricingReference {
  const tableItems = parseOpenAiOfficialPricingHtmlTables(html, fetchedAt);
  if (tableItems.length > 0) return { source: "openai-official-reference", sourceUrl: OPENAI_PRICING_URL, fetchedAt, parserVersion: OPENAI_PRICING_PARSER_VERSION, items: tableItems };

  const items: OpenAiOfficialPrice[] = [];
  const seen = new Set<string>();
  const lines = htmlToTextLines(html);
  for (let index = 0; index < lines.length; index += 1) {
    const displayName = lines[index]!;
    if (!looksLikeOpenAiModelHeading(displayName)) continue;
    const block = lines.slice(index + 1, index + 10).join(" ");
    const match = block.match(/Input:\s*\$([0-9,.]+)\s*\/\s*1M\s+tokens\s*Cached input:\s*(\$[0-9,.]+|-)\s*\/\s*1M\s+tokens(?:\s*Cache writes?:\s*(\$[0-9,.]+|-)\s*\/\s*1M\s+tokens)?\s*Output:\s*\$([0-9,.]+)\s*\/\s*1M\s+tokens/i);
    if (!match) continue;
    const inputPerMillion = parseMoney(match[1]);
    const cachedInputPerMillion = parseMoney(match[2]);
    const cacheWritePerMillion = parseMoney(match[3]);
    const outputPerMillion = parseMoney(match[4]);
    if ([inputPerMillion, outputPerMillion].some((value) => value === null)) continue;
    const normalized = normalizeOpenAiModelName(displayName);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push({
      source: "openai-official",
      model: modelNameFromDisplayName(displayName),
      displayName,
      inputPerMillion: inputPerMillion!,
      cachedInputPerMillion,
      cacheWritePerMillion,
      outputPerMillion: outputPerMillion!,
      inputPer1M: inputPerMillion!,
      cachedInputPer1M: cachedInputPerMillion,
      cacheWritePer1M: cacheWritePerMillion,
      outputPer1M: outputPerMillion!,
      sourceUrl: OPENAI_PRICING_URL,
      fetchedAt,
      parserVersion: OPENAI_PRICING_PARSER_VERSION
    });
  }
  return { source: "openai-official-reference", sourceUrl: OPENAI_PRICING_URL, fetchedAt, parserVersion: OPENAI_PRICING_PARSER_VERSION, items };
}

function parseOpenAiOfficialPricingHtmlTables(html: string, fetchedAt: string): OpenAiOfficialPrice[] {
  const itemsByModel = new Map<string, OpenAiOfficialPrice>();
  const longContextThreshold = extractOpenAiLongContextThreshold(html);
  for (const tableMatch of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const tableHtml = tableMatch[0];
    const rows = htmlTableRows(tableHtml);
    if (rows.length < 2) continue;
    let headings = rows[0]!;
    let dataRows = rows.slice(1);
    if (!headings.some((heading) => normalizeOpenAiModelName(heading) === "model") && normalizeOpenAiModelName(dataRows[0]?.[0] ?? "") === "model") {
      headings = dataRows[0]!;
      dataRows = dataRows.slice(1);
    }
    const normalizedHeadings = headings.map(normalizeOpenAiModelName);
    if (normalizedHeadings.includes("training")) continue;
    const modelIndex = normalizedHeadings.indexOf("model");
    const inputIndex = normalizedHeadings.indexOf("input");
    const cachedInputIndex = normalizedHeadings.indexOf("cached-input");
    const cacheWriteIndex = normalizedHeadings.findIndex((heading) => heading === "cache-writes" || heading === "cache-write");
    const outputIndex = normalizedHeadings.findIndex((heading) => heading === "output" || heading.startsWith("output-"));
    if ([modelIndex, inputIndex, outputIndex].some((index) => index < 0)) {
      continue;
    }

    for (const originalRow of dataRows) {
      const row = normalizedHeadings[0] === "category" && originalRow.length === headings.length - 1 ? ["", ...originalRow] : originalRow;
      const displayName = row[modelIndex] ?? "";
      if (!looksLikeOpenAiModelHeading(displayName)) continue;
      const inputPerMillion = parseMoney(row[inputIndex]);
      const outputPerMillion = parseMoney(row[outputIndex]);
      if ([inputPerMillion, outputPerMillion].some((value) => value === null)) continue;
      const cachedInputPerMillion = parseMoney(row[cachedInputIndex]);
      const normalized = normalizeOpenAiModelName(displayName);
      if (!normalized) continue;
      const serviceTier = openAiTableServiceTier(html, tableHtml, tableMatch.index ?? 0);
      if (!serviceTier) continue;
      const contextPrices = contextPricesFromOpenAiTableRow(row, normalizedHeadings, serviceTier, longContextThreshold);
      const existing = itemsByModel.get(normalized);
      if (!existing) {
        itemsByModel.set(normalized, openAiOfficialPriceFromValues(displayName, inputPerMillion!, cachedInputPerMillion, cacheWriteIndex < 0 ? null : parseMoney(row[cacheWriteIndex]), outputPerMillion!, fetchedAt, contextPrices));
        continue;
      }
      existing.contextPrices = mergeOpenAiContextPrices(existing.contextPrices ?? [], contextPrices);
    }
  }
  return Array.from(itemsByModel.values());
}

function htmlTableRows(tableHtml: string): string[][] {
  return Array.from(tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi))
    .map((rowMatch) => Array.from(rowMatch[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)).map((cellMatch) => htmlCellText(cellMatch[1] ?? "")))
    .filter((row) => row.length > 0);
}

function htmlCellText(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function openAiOfficialPriceFromValues(displayName: string, inputPerMillion: number, cachedInputPerMillion: number | null, cacheWritePerMillion: number | null, outputPerMillion: number, fetchedAt: string, contextPrices: OpenAiOfficialContextPrice[] = []): OpenAiOfficialPrice {
  return {
    source: "openai-official",
    model: modelNameFromDisplayName(displayName),
    displayName,
    inputPerMillion,
    cachedInputPerMillion,
    cacheWritePerMillion,
    outputPerMillion,
    inputPer1M: inputPerMillion,
    cachedInputPer1M: cachedInputPerMillion,
    cacheWritePer1M: cacheWritePerMillion,
    outputPer1M: outputPerMillion,
    ...(contextPrices.length > 0 ? { contextPrices } : {}),
    sourceUrl: OPENAI_PRICING_URL,
    fetchedAt,
    parserVersion: OPENAI_PRICING_PARSER_VERSION
  };
}

function contextPricesFromOpenAiTableRow(row: string[], headings: string[], serviceTier: OpenAiOfficialContextPrice["serviceTier"], longContextThreshold: number | null): OpenAiOfficialContextPrice[] {
  const inputIndices = semanticColumnIndices(headings, "input");
  const cachedIndices = semanticColumnIndices(headings, "cached-input");
  const cacheWriteIndices = headings.flatMap((heading, index) => heading === "cache-writes" || heading === "cache-write" ? [index] : []);
  const outputIndices = headings.flatMap((heading, index) => heading === "output" || heading.startsWith("output-") ? [index] : []);
  const shortInput = parseMoney(row[inputIndices[0] ?? -1]);
  const shortOutput = parseMoney(row[outputIndices[0] ?? -1]);
  if (shortInput === null || shortOutput === null) return [];
  const shortCached = parseMoney(row[cachedIndices[0] ?? -1]);
  const shortCacheWrite = parseMoney(row[cacheWriteIndices[0] ?? -1]);
  const hasLongContextColumns = inputIndices.length > 1 && outputIndices.length > 1;
  if (hasLongContextColumns && longContextThreshold === null) {
    throw new RelayError("openai_pricing_schema_unsupported", "OpenAI long-context pricing threshold was not found", 502);
  }
  const prices: OpenAiOfficialContextPrice[] = [{
    serviceTier,
    context: "short_context",
    minInputTokens: 0,
    maxInputTokens: hasLongContextColumns ? longContextThreshold! : null,
    inputPer1M: shortInput,
    cachedInputPer1M: shortCached,
    cacheWritePer1M: shortCacheWrite,
    outputPer1M: shortOutput
  }];
  const longInput = parseMoney(row[inputIndices[1] ?? -1]);
  const longCached = parseMoney(row[cachedIndices[1] ?? -1]);
  const longCacheWrite = parseMoney(row[cacheWriteIndices[1] ?? -1]);
  const longOutput = parseMoney(row[outputIndices[1] ?? -1]);
  if (hasLongContextColumns && longInput !== null && longOutput !== null) {
    prices.push({
      serviceTier,
      context: "long_context",
      minInputTokens: longContextThreshold! + 1,
      maxInputTokens: null,
      inputPer1M: longInput,
      cachedInputPer1M: longCached,
      cacheWritePer1M: longCacheWrite,
      outputPer1M: longOutput
    });
  }
  return serviceTier === "standard" && prices.length === 1 ? [] : prices;
}

function semanticColumnIndices(headings: string[], semantic: string): number[] {
  return headings.flatMap((heading, index) => heading === semantic ? [index] : []);
}

function mergeOpenAiContextPrices(left: OpenAiOfficialContextPrice[], right: OpenAiOfficialContextPrice[]): OpenAiOfficialContextPrice[] {
  const merged = new Map<string, OpenAiOfficialContextPrice>();
  for (const price of [...left, ...right]) {
    const key = `${price.serviceTier}:${price.context}`;
    if (merged.has(key)) throw new RelayError("openai_pricing_schema_unsupported", `Duplicate OpenAI pricing candidate ${key}`, 502);
    merged.set(key, price);
  }
  return Array.from(merged.values()).sort((a, b) => a.serviceTier.localeCompare(b.serviceTier) || a.minInputTokens - b.minInputTokens || a.context.localeCompare(b.context));
}

function openAiTableServiceTier(html: string, tableHtml: string, tableIndex: number): OpenAiOfficialContextPrice["serviceTier"] | null {
  const paneStart = html.lastIndexOf("data-content-switcher-pane", tableIndex);
  if (paneStart >= 0) {
    const paneOpen = html.slice(paneStart, tableIndex);
    const paneMatch = paneOpen.match(/data-value="([^"]+)"/);
    const paneValue = paneMatch?.[1]?.trim().toLowerCase();
    if (paneValue === "standard" || paneValue === "priority" || paneValue === "batch" || paneValue === "flex") return paneValue;
  }
  const tableText = htmlToTextLines(tableHtml).join(" ");
  const nearbyText = htmlToTextLines(html.slice(Math.max(0, tableIndex - 1200), tableIndex)).slice(-20).join(" ");
  return /\bpriority\b/i.test(`${nearbyText} ${tableText}`) ? "priority" : "standard";
}

function extractOpenAiLongContextThreshold(html: string): number | null {
  const text = htmlToTextLines(html).join(" ");
  const match = text.match(/(?:>|over|more than|greater than)\s*([0-9][0-9,.]*)\s*k?\s+input\s+tokens/i)
    ?? text.match(/input\s+tokens\s*(?:>|over|more than|greater than)\s*([0-9][0-9,.]*)\s*k?/i)
    ?? decodeHtmlEntities(html).match(/(?:<|<=|≤|under|less than|up to)\s*([0-9][0-9,.]*)\s*k?\s+context(?:\s+(?:length|window))?/i);
  if (!match) return null;
  const raw = match[1]?.replace(/,/g, "");
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return /k\b/i.test(match[0]) ? Math.trunc(parsed * 1000) : Math.trunc(parsed);
}

function findOpenAiPrice(items: OpenAiOfficialPrice[], providerModelName: string): OpenAiOfficialPrice | null {
  const target = normalizeOpenAiModelName(providerModelName);
  if (!target) return null;
  return items.find((item) => normalizeOpenAiModelName(item.model) === target || normalizeOpenAiModelName(item.displayName) === target) ?? null;
}

function htmlToTextLines(html: string): string[] {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeOpenAiModelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function looksLikeOpenAiModelHeading(value: string): boolean {
  const normalized = normalizeOpenAiModelName(value);
  return normalized.startsWith("gpt-") || /^o[0-9]/.test(normalized) || normalized.startsWith("chatgpt-");
}

function modelNameFromDisplayName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "")
    .replace(/^-+|-+$/g, "");
}

function parseMoney(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\$?[0-9,.]+$/.test(trimmed)) return null;
  const parsed = Number(trimmed.replace(/^\$/, "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "OpenAI pricing page is unavailable";
}
