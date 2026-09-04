import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";

export interface PlansUrlState {
  query: string;
  status: "all" | "enabled" | "closed" | "disabled";
  page: number;
  pageSize: TablePageSize;
}

export function parsePlansUrlState(
  params?: Record<string, string | string[] | undefined>,
): PlansUrlState {
  const status = first(params?.status);
  return {
    query: first(params?.q).trim().slice(0, 100),
    status: status === "enabled" || status === "closed" || status === "disabled" ? status : "all",
    page: pageNumber(params?.page),
    pageSize: normalizeTablePageSize(params?.pageSize),
  };
}

export function plansHref(state: PlansUrlState) {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.status !== "all") params.set("status", state.status);
  if (state.page > 1) params.set("page", String(state.page));
  if (state.pageSize !== 20) params.set("pageSize", String(state.pageSize));
  return `/owner/plans-and-budgets/plans${params.size > 0 ? `?${params}` : ""}`;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function pageNumber(value: string | string[] | undefined) {
  const raw = first(value);
  return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}
