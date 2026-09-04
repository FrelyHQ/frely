import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";

export interface ServiceProductDirectoryState {
  query: string;
  page: number;
  pageSize: TablePageSize;
}

export function parseServiceProductDirectoryApiState(searchParams: URLSearchParams): ServiceProductDirectoryState | null {
  const unsupported = Array.from(searchParams.keys()).find((key) => key !== "q" && key !== "page" && key !== "pageSize");
  const query = searchParams.get("q") ?? "";
  const rawPage = searchParams.get("page") ?? "";
  if (unsupported || query.length > 100 || (rawPage && (!/^[1-9]\d*$/.test(rawPage) || Number(rawPage) > 10_000))) {
    return null;
  }
  const rawPageSize = searchParams.get("pageSize") ?? "";
  if (rawPageSize && normalizeTablePageSize(rawPageSize) !== Number(rawPageSize)) return null;
  return {
    query: query.trim().slice(0, 100),
    page: rawPage ? Number(rawPage) : 1,
    pageSize: normalizeTablePageSize(rawPageSize),
  };
}
