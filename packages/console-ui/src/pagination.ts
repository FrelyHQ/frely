export const TABLE_PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const;
export const DEFAULT_TABLE_PAGE_SIZE = 20;
export const MIN_TABLE_PAGE_SIZE = 1;
export const MAX_TABLE_PAGE_SIZE = 200;

export type TablePageSize = number;

export function parseTablePageSize(
  value: number | string | string[] | null | undefined
): TablePageSize | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === "string" && !/^\d+$/.test(raw.trim())) return null;
  const parsed = typeof raw === "number" ? raw : Number(raw ?? "");
  return Number.isInteger(parsed) && parsed >= MIN_TABLE_PAGE_SIZE && parsed <= MAX_TABLE_PAGE_SIZE
    ? parsed
    : null;
}

export function normalizeTablePageSize(
  value: number | string | string[] | null | undefined,
  fallback: TablePageSize = DEFAULT_TABLE_PAGE_SIZE
): TablePageSize {
  return parseTablePageSize(value) ?? parseTablePageSize(fallback) ?? DEFAULT_TABLE_PAGE_SIZE;
}
