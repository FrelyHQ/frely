export const DIRECTORY_PAGE_SIZES = [20, 50, 100, 200] as const;
export const DEFAULT_DIRECTORY_PAGE_SIZE = 20;
export const MIN_DIRECTORY_PAGE_SIZE = 1;
export const MAX_DIRECTORY_PAGE_SIZE = 200;

export type DirectoryPageSize = number;
export type SortDirection = "asc" | "desc";

export interface PageRequest<TSort extends string, TFilter = undefined> {
  page: number;
  pageSize: DirectoryPageSize;
  query?: string;
  sort: TSort;
  direction: SortDirection;
  filters: TFilter;
}

export interface PageResult<T> {
  items: T[];
  page: number;
  pageSize: DirectoryPageSize;
  total: number;
  totalPages: number;
}

export interface CursorPageResult<T> {
  items: T[];
  pageSize: DirectoryPageSize;
  nextCursor: string | null;
  hasMore: boolean;
}

export function normalizeDirectoryPageSize(
  value: number | undefined,
  fallback: DirectoryPageSize = DEFAULT_DIRECTORY_PAGE_SIZE
): DirectoryPageSize {
  const normalizedFallback = Number.isInteger(fallback) && fallback >= MIN_DIRECTORY_PAGE_SIZE && fallback <= MAX_DIRECTORY_PAGE_SIZE
    ? fallback
    : DEFAULT_DIRECTORY_PAGE_SIZE;
  return Number.isInteger(value) && value !== undefined && value >= MIN_DIRECTORY_PAGE_SIZE && value <= MAX_DIRECTORY_PAGE_SIZE
    ? value
    : normalizedFallback;
}

export function normalizeDirectoryPage(value: number | undefined, totalPages = 1): number {
  const requested = Number.isFinite(value) ? Math.trunc(value ?? 1) : 1;
  return Math.min(Math.max(1, requested), Math.max(1, totalPages));
}

export function pageResult<T>(items: T[], total: number, pageSize: DirectoryPageSize, requestedPage: number): PageResult<T> {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { items, total, page: normalizeDirectoryPage(requestedPage, totalPages), pageSize, totalPages };
}
