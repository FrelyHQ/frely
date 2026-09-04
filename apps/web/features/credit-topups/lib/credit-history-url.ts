import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";

export interface CreditHistoryUrlState {
  topupCursor: string;
  topupPageSize: TablePageSize;
  ledgerCursor: string;
  ledgerPageSize: TablePageSize;
  catalogPage: number;
  catalogPageSize: TablePageSize;
}

export function parseCreditHistoryUrlState(params?: Record<string, string | string[] | undefined>): CreditHistoryUrlState {
  return {
    topupCursor: first(params?.topupCursor).trim().slice(0, 1000),
    topupPageSize: normalizeTablePageSize(params?.topupPageSize),
    ledgerCursor: first(params?.ledgerCursor).trim().slice(0, 1000),
    ledgerPageSize: normalizeTablePageSize(params?.ledgerPageSize),
    catalogPage: pageNumber(first(params?.catalogPage)),
    catalogPageSize: normalizeTablePageSize(params?.catalogPageSize),
  };
}

export function userCreditsHref(state: CreditHistoryUrlState) {
  const params = new URLSearchParams();
  if (state.topupCursor) params.set("topupCursor", state.topupCursor);
  if (state.topupPageSize !== 20) params.set("topupPageSize", String(state.topupPageSize));
  if (state.ledgerCursor) params.set("ledgerCursor", state.ledgerCursor);
  if (state.ledgerPageSize !== 20) params.set("ledgerPageSize", String(state.ledgerPageSize));
  if (state.catalogPage > 1) params.set("catalogPage", String(state.catalogPage));
  if (state.catalogPageSize !== 20) params.set("catalogPageSize", String(state.catalogPageSize));
  return `/user/credits${params.size > 0 ? `?${params}` : ""}`;
}

function pageNumber(value: string) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 1;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
