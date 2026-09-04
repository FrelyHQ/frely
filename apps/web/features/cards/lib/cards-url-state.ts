import { normalizeTablePageSize, parseTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";

export type CardInventoryStatus = "available" | "all";
export interface CardsUrlState {
  inventoryStatus: CardInventoryStatus;
  page: number;
  pageSize: TablePageSize;
  transferPage: number;
  transferPageSize: TablePageSize;
}

export function parseCardsUrlState(searchParams: Pick<URLSearchParams, "get">): CardsUrlState {
  return {
    inventoryStatus: inventoryStatus(searchParams.get("status")),
    page: positivePage(searchParams.get("page")),
    pageSize: normalizeTablePageSize(searchParams.get("pageSize")),
    transferPage: positivePage(searchParams.get("transferPage")),
    transferPageSize: normalizeTablePageSize(searchParams.get("transferPageSize")),
  };
}

export function cardsPageHref(
  searchParams: Pick<URLSearchParams, "toString">,
  key: "page" | "transferPage",
  page: number,
) {
  const state = parseCardsUrlState(new URLSearchParams(searchParams.toString()));
  state[key] = Math.min(10_000, Math.max(1, Math.trunc(page)));
  return cardsHref(state);
}

export function cardsInventoryStatusHref(
  searchParams: Pick<URLSearchParams, "toString">,
  inventoryStatus: CardInventoryStatus,
) {
  const state = parseCardsUrlState(new URLSearchParams(searchParams.toString()));
  state.inventoryStatus = inventoryStatus;
  state.page = 1;
  return cardsHref(state);
}

export function parseCardInventoryApiState(searchParams: URLSearchParams): Pick<CardsUrlState, "inventoryStatus" | "page" | "pageSize"> | null {
  const unsupported = Array.from(searchParams.keys()).find((key) => !["status", "page", "pageSize"].includes(key));
  const rawStatus = searchParams.get("status");
  const rawPage = searchParams.get("page");
  const rawPageSize = searchParams.get("pageSize");
  if (unsupported || (rawStatus !== null && rawStatus !== "available" && rawStatus !== "all")) return null;
  if (rawPage !== null && (!/^[1-9]\d*$/.test(rawPage) || Number(rawPage) > 10_000)) return null;
  if (rawPageSize !== null && parseTablePageSize(rawPageSize) === null) return null;
  return {
    inventoryStatus: inventoryStatus(rawStatus),
    page: rawPage ? Number(rawPage) : 1,
    pageSize: normalizeTablePageSize(rawPageSize),
  };
}

function cardsHref(state: CardsUrlState) {
  const next = new URLSearchParams();
  if (state.inventoryStatus !== "available") next.set("status", state.inventoryStatus);
  if (state.page > 1) next.set("page", String(state.page));
  if (state.pageSize !== 20) next.set("pageSize", String(state.pageSize));
  if (state.transferPage > 1) next.set("transferPage", String(state.transferPage));
  if (state.transferPageSize !== 20) next.set("transferPageSize", String(state.transferPageSize));
  return `/user/cards${next.size ? `?${next}` : ""}`;
}

function inventoryStatus(value: string | null): CardInventoryStatus {
  return value === "all" ? "all" : "available";
}

function positivePage(value: string | null) {
  return value && /^[1-9]\d*$/.test(value) ? Math.min(10_000, Number(value)) : 1;
}
