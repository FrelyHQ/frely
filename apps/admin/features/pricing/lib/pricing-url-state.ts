import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import type { PricingWorkbenchState } from "../types";

export type PricingSearchParams = Record<string, string | string[] | undefined>;

export function parsePricingWorkbenchState(params: PricingSearchParams): PricingWorkbenchState {
  return {
    providerPage: positivePage(params.providerPage),
    providerPageSize: normalizeTablePageSize(params.providerPageSize),
    providerId: boundedText(params.provider, 100) || "all",
    providerModelStatus: allowlisted(params.providerStatus, ["all", "enabled", "disabled"], "enabled"),
    providerPrice: allowlisted(params.providerPrice, ["all", "missing", "has-enabled"], "all"),
    providerQuery: boundedText(params.providerQuery, 100),
    accessPointPage: positivePage(params.accessPage),
    accessPointPageSize: normalizeTablePageSize(params.accessPageSize),
    accessPointStatus: allowlisted(params.accessStatus, ["all", "enabled", "disabled"], "enabled"),
    accessPointTargetCost: allowlisted(params.targetCost, ["all", "missing", "has-enabled"], "all"),
    accessPointPrice: allowlisted(params.accessPrice, ["all", "missing", "has-enabled"], "all"),
    accessPointQuery: boundedText(params.accessQuery, 100),
  };
}

export function pricingStateKey(state: PricingWorkbenchState) {
  return JSON.stringify(state);
}

export function pricingWorkbenchHref(currentQuery: string, changes: Record<string, string | null>) {
  const next = new URLSearchParams(currentQuery);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return `/owner/pricing${next.size > 0 ? `?${next}` : ""}`;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function positivePage(value: string | string[] | undefined) {
  const parsed = Number.parseInt(first(value) ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function boundedText(value: string | string[] | undefined, maxLength: number) {
  return (first(value) ?? "").trim().slice(0, maxLength);
}

function allowlisted<T extends string>(value: string | string[] | undefined, allowed: readonly T[], fallback: T): T {
  const candidate = first(value);
  return candidate && allowed.includes(candidate as T) ? candidate as T : fallback;
}
