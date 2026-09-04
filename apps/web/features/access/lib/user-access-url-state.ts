import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";

export type UserAccessDirectoryKind = "available-models" | "access-points";

export interface UserAccessDirectoryState {
  query: string;
  page: number;
  pageSize: TablePageSize;
}

export function userAccessDirectoryState(
  params: Record<string, string | string[] | undefined> | undefined
): UserAccessDirectoryState {
  return {
    query: singleValue(params?.q).trim().slice(0, 100),
    page: boundedPage(singleValue(params?.page)),
    pageSize: normalizeTablePageSize(params?.pageSize),
  };
}

export function parseUserAccessDirectoryApiState(searchParams: URLSearchParams): UserAccessDirectoryState | null {
  const unsupported = Array.from(searchParams.keys()).find((key) => key !== "q" && key !== "page" && key !== "pageSize");
  const rawQuery = searchParams.get("q") ?? "";
  const rawPage = searchParams.get("page") ?? "";
  if (unsupported || rawQuery.length > 100 || (rawPage && (!/^[1-9]\d*$/.test(rawPage) || Number(rawPage) > 10_000))) {
    return null;
  }
  const pageSize = searchParams.get("pageSize") ?? "";
  if (pageSize && normalizeTablePageSize(pageSize) !== Number(pageSize)) return null;
  return userAccessDirectoryState({ q: rawQuery, page: rawPage, pageSize });
}

export function userAccessDirectoryHref(kind: UserAccessDirectoryKind, state: UserAccessDirectoryState): string {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.page > 1) params.set("page", String(state.page));
  if (state.pageSize !== 20) params.set("pageSize", String(state.pageSize));
  const query = params.toString();
  const pathname = `/user/access/${kind}`;
  return query ? `${pathname}?${query}` : pathname;
}

function singleValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function boundedPage(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) return 1;
  return Math.min(10_000, Number(value));
}
