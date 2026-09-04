"use client";

import { TablePagination as MuiTablePagination } from "@mui/material";
import type { ReactNode } from "react";
import { SearchSelect } from "./search-select.js";
import {
  parseTablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
  type TablePageSize
} from "./pagination.js";

export interface MaterialTablePaginationProps {
  className?: string;
  nextHref?: string;
  noun?: string;
  onNext?: () => void;
  onPageSizeChange?: (pageSize: TablePageSize) => void;
  onPrevious?: () => void;
  page: number;
  pageParam?: string;
  pageSize: TablePageSize;
  pageSizeParam?: string;
  previousHref?: string;
  rangeEnd?: number;
  rangeStart?: number;
  resetParams?: string[];
  total: number;
  totalMode?: "exact" | "unknown";
  totalPages: number;
  "aria-label"?: string;
}

const TABLE_PAGE_SIZE_SELECT_OPTIONS = TABLE_PAGE_SIZE_OPTIONS.map((option) => ({
  value: String(option),
  label: String(option)
}));

export function MaterialTablePagination({
  className,
  nextHref,
  noun = "records",
  onNext,
  onPageSizeChange,
  onPrevious,
  page,
  pageParam = "page",
  pageSize,
  pageSizeParam = "pageSize",
  previousHref,
  rangeEnd,
  rangeStart,
  resetParams = [],
  total,
  totalMode = "exact",
  totalPages,
  "aria-label": ariaLabel
}: MaterialTablePaginationProps) {
  const range = rangeStart !== undefined && rangeEnd !== undefined ? ` · ${rangeStart}–${rangeEnd}` : "";
  const summary: ReactNode = totalMode === "unknown"
    ? `${total} ${noun} loaded${nextHref || onNext ? " · more available" : ""}`
    : `Page ${page} of ${totalPages} · ${total} ${noun}${range}`;
  const changePageSize = (value: string) => {
    const nextPageSize = parseTablePageSize(value);
    if (nextPageSize === null || nextPageSize === pageSize) return;
    if (onPageSizeChange) {
      onPageSizeChange(nextPageSize);
      return;
    }
    window.location.assign(pageSizeHref(window.location.href, {
      pageParam,
      pageSize: nextPageSize,
      pageSizeParam,
      resetParams
    }));
  };

  return (
    <nav className={["table-pagination", className].filter(Boolean).join(" ")} aria-label={ariaLabel ?? `${noun} pagination`}>
      <div className="table-pagination-page-size">
        <span>Rows per page:</span>
        <SearchSelect
          ariaLabel="Rows per page"
          value={String(pageSize)}
          options={TABLE_PAGE_SIZE_SELECT_OPTIONS}
          allowCustomValue
          clearOnFocus
          onValueChange={changePageSize}
        />
      </div>
      <MuiTablePagination
        component="div"
        count={totalMode === "unknown" ? -1 : total}
        page={page - 1}
        rowsPerPage={pageSize}
        rowsPerPageOptions={[]}
        labelDisplayedRows={() => summary}
        onRowsPerPageChange={() => undefined}
        onPageChange={(_event, nextPageIndex) => {
          if (nextPageIndex < page - 1) {
            if (onPrevious) onPrevious();
            else if (previousHref) window.location.assign(previousHref);
            return;
          }
          if (nextPageIndex > page - 1) {
            if (onNext) onNext();
            else if (nextHref) window.location.assign(nextHref);
          }
        }}
        slotProps={{
          actions: {
            nextButton: { disabled: !nextHref && !onNext },
            previousButton: { disabled: !previousHref && !onPrevious }
          }
        }}
        sx={{
          color: "var(--text)",
          fontFamily: "inherit",
          "& .MuiTablePagination-displayedRows": { color: "var(--muted)", fontFamily: "inherit", margin: 0 },
          "& .MuiTablePagination-spacer": { display: "none" },
          "& .MuiTablePagination-toolbar": { minHeight: 0, padding: 0 },
          "& .MuiTablePagination-actions": { marginLeft: "auto" },
          "& .MuiIconButton-root": { color: "var(--text)" },
          "& .Mui-disabled": { color: "var(--muted)", opacity: 0.5 }
        }}
      />
    </nav>
  );
}

export function pageSizeHref(
  currentHref: string,
  input: {
    pageParam?: string;
    pageSize: TablePageSize;
    pageSizeParam?: string;
    resetParams?: string[];
  }
): string {
  const url = new URL(currentHref);
  const pageParam = input.pageParam ?? "page";
  const pageSizeParam = input.pageSizeParam ?? "pageSize";
  if (input.pageSize === 20) url.searchParams.delete(pageSizeParam);
  else url.searchParams.set(pageSizeParam, String(input.pageSize));
  if (pageParam) url.searchParams.delete(pageParam);
  for (const param of input.resetParams ?? []) url.searchParams.delete(param);
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

export { normalizeTablePageSize, parseTablePageSize, TABLE_PAGE_SIZE_OPTIONS, type TablePageSize } from "./pagination.js";
