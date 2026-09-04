import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";

export interface AdminCreditsUrlState {
  query: string;
  page: number;
  pageSize: TablePageSize;
  scopePage: number;
  scopePageSize: TablePageSize;
  configurationPage: number;
  configurationPageSize: TablePageSize;
  topupCursor: string;
  topupPageSize: TablePageSize;
}

export function parseAdminCreditsUrlState(params?: Record<string, string | string[] | undefined>): AdminCreditsUrlState {
  return {
    query: first(params?.q).trim().slice(0, 100),
    page: pageNumber(params?.page),
    pageSize: normalizeTablePageSize(params?.pageSize),
    scopePage: pageNumber(params?.scopePage),
    scopePageSize: normalizeTablePageSize(params?.scopePageSize),
    configurationPage: pageNumber(params?.configurationPage),
    configurationPageSize: normalizeTablePageSize(params?.configurationPageSize),
    topupCursor: first(params?.topupCursor).trim().slice(0, 1000),
    topupPageSize: normalizeTablePageSize(params?.topupPageSize),
  };
}

export function adminCreditsHref(state: AdminCreditsUrlState) {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.page > 1) params.set("page", String(state.page));
  if (state.pageSize !== 20) params.set("pageSize", String(state.pageSize));
  if (state.scopePage > 1) params.set("scopePage", String(state.scopePage));
  if (state.scopePageSize !== 20) params.set("scopePageSize", String(state.scopePageSize));
  if (state.configurationPage > 1) params.set("configurationPage", String(state.configurationPage));
  if (state.configurationPageSize !== 20) params.set("configurationPageSize", String(state.configurationPageSize));
  if (state.topupCursor) params.set("topupCursor", state.topupCursor);
  if (state.topupPageSize !== 20) params.set("topupPageSize", String(state.topupPageSize));
  return `/owner/credits${params.size > 0 ? `?${params}` : ""}`;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function pageNumber(value: string | string[] | undefined) {
  const raw = first(value);
  return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}
