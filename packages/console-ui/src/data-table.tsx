"use client";

import { Badge } from "@frely/ui/components/badge";
import { Button } from "@frely/ui/components/button";
import type { TableAlignment, TableProps } from "@frely/ui/components/table";
import {
  MaterialReactTable,
  useMaterialReactTable,
  type MRT_ColumnDef,
  type MRT_RowData,
  type MRT_TableOptions
} from "material-react-table";
import {
  type ColumnDef,
  type InitialTableState,
  type OnChangeFn,
  type PaginationState,
  type RowData,
  type RowSelectionState,
  type SortingState,
  type VisibilityState
} from "@tanstack/react-table";
import { useEffect, useMemo, type ReactNode } from "react";
import {
  MaterialTablePagination,
  normalizeTablePageSize,
  type TablePageSize
} from "./material-table-pagination.js";

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: TableAlignment;
    minWidth?: number | string;
    width?: number | string;
  }
}

export interface DataTableSelection {
  bulkAction?: {
    clearLabel?: ReactNode;
    label?: ReactNode;
    onClick: () => void;
  };
  mode?: "single" | "multiple";
  selectedLabel: string;
  strategy?: "current-page" | "cross-page";
}

export interface DataTableState {
  columnVisibility?: VisibilityState;
  pagination?: PaginationState;
  rowSelection?: RowSelectionState;
  sorting?: SortingState;
}

export interface DataTableStateChange {
  columnVisibility?: OnChangeFn<VisibilityState>;
  pagination?: OnChangeFn<PaginationState>;
  rowSelection?: OnChangeFn<RowSelectionState>;
  sorting?: OnChangeFn<SortingState>;
}

export interface DataTableEmptyState {
  action?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}

export interface DataTableProps<TRow extends MRT_RowData> {
  columns: Array<ColumnDef<TRow, unknown>>;
  data: TRow[];
  emptyState?: DataTableEmptyState;
  getRowId: (row: TRow) => string;
  getRowProps?: (row: TRow) => { className?: string; clickable?: boolean; disabled?: boolean } | undefined;
  initialState?: InitialTableState;
  onStateChange?: DataTableStateChange;
  selection?: DataTableSelection;
  serverManaged?: boolean;
  serverManagedSorting?: boolean;
  state?: DataTableState;
  table?: Pick<TableProps, "aria-label" | "className" | "density" | "minWidth" | "stickyHeader" | "wrapperClassName">;
  toolbar?: { actions?: ReactNode; content?: ReactNode };
}

/**
 * A table must not render an unbounded record collection by default. RSC/API
 * backed tables use `serverManaged`; local tables retain the same 20-row page
 * boundary while their owning surface is migrated to a server query.
 */
export const DEFAULT_DATA_TABLE_PAGE_SIZE = 20;

export function DataTable<TRow extends MRT_RowData>({
  columns,
  data,
  emptyState = { title: "No records found." },
  getRowId,
  getRowProps,
  initialState,
  onStateChange,
  selection,
  serverManaged = false,
  serverManagedSorting = serverManaged,
  state,
  table: tableProps,
  toolbar
}: DataTableProps<TRow>) {
  const selectionMode = selection?.mode ?? "multiple";
  const materialColumns = useMemo(
    () => columns.map((column) => toMaterialColumn(column)),
    [columns]
  );
  const materialInitialState = {
    pagination: {
      pageIndex: initialState?.pagination?.pageIndex ?? 0,
      pageSize: allowedPageSize(initialState?.pagination?.pageSize)
    },
    ...initialState,
    ...(initialState?.pagination ? {
      pagination: {
        ...initialState.pagination,
        pageSize: allowedPageSize(initialState.pagination.pageSize)
      }
    } : {})
  } as NonNullable<MRT_TableOptions<TRow>["initialState"]>;
  const materialState = {
    ...(state?.sorting !== undefined ? { sorting: state.sorting } : {}),
    ...(state?.rowSelection !== undefined ? { rowSelection: state.rowSelection } : {}),
    ...(state?.columnVisibility !== undefined ? { columnVisibility: state.columnVisibility } : {}),
    ...(state?.pagination !== undefined ? {
      pagination: {
        ...state.pagination,
        pageSize: allowedPageSize(state.pagination.pageSize)
      }
    } : {})
  };

  const instance = useMaterialReactTable({
    columns: materialColumns,
    data,
    getRowId,
    initialState: materialInitialState,
    state: materialState,
    enableColumnActions: false,
    enableColumnFilters: false,
    enableColumnPinning: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    enableGlobalFilter: false,
    enableHiding: false,
    enablePagination: !serverManaged,
    enableRowSelection: Boolean(selection),
    enableMultiRowSelection: selectionMode === "multiple",
    enableStickyHeader: tableProps?.stickyHeader ?? false,
    enableTableFooter: false,
    enableTopToolbar: false,
    enableBottomToolbar: false,
    manualFiltering: serverManaged,
    manualPagination: serverManaged,
    manualSorting: serverManagedSorting,
    ...(onStateChange?.columnVisibility ? { onColumnVisibilityChange: onStateChange.columnVisibility } : {}),
    ...(onStateChange?.pagination ? { onPaginationChange: onStateChange.pagination } : {}),
    ...(onStateChange?.rowSelection ? { onRowSelectionChange: onStateChange.rowSelection } : {}),
    ...(onStateChange?.sorting ? { onSortingChange: onStateChange.sorting } : {}),
    renderEmptyRowsFallback: () => (
      <div className="table-empty-state" role="status">
        <strong>{emptyState.title}</strong>
        {emptyState.description ? <span>{emptyState.description}</span> : null}
        {emptyState.action ? <div className="table-empty-action">{emptyState.action}</div> : null}
      </div>
    ),
    muiTablePaperProps: {
      className: ["table-surface", tableProps?.wrapperClassName].filter(Boolean).join(" "),
      elevation: 0,
      square: true,
      sx: {
        backgroundColor: "var(--surface)",
        backgroundImage: "none",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)"
      }
    },
    ...(tableProps?.stickyHeader ? {
      muiTableContainerProps: {
        className: "data-table-scroll-container",
        sx: {
          maxHeight: "calc(100dvh - var(--console-header-height))",
          "@media (max-width: 900px)": {
            maxHeight: "none"
          }
        }
      }
    } : {}),
    muiTableProps: {
      "aria-label": tableProps?.["aria-label"],
      className: ["table-root", tableProps?.className].filter(Boolean).join(" "),
      sx: {
        backgroundColor: "var(--surface)",
        color: "var(--text)",
        fontFamily: "inherit",
        fontSize: "13px",
        minWidth: tableMinWidth(tableProps?.minWidth ?? "content"),
        tableLayout: "auto"
      }
    },
    muiTableHeadProps: { className: "table-header" },
    muiTableBodyProps: { className: "table-body" },
    muiTableHeadRowProps: { className: "table-row" },
    muiTableBodyRowProps: ({ row }) => {
      const props = getRowProps?.(row.original);
      return {
        className: ["table-row", props?.className].filter(Boolean).join(" "),
        "aria-disabled": props?.disabled || undefined,
        "data-clickable": props?.clickable || undefined,
        "data-disabled": props?.disabled || undefined,
        "data-state": row.getIsSelected() ? "selected" : undefined
      };
    },
    muiTableHeadCellProps: ({ column }) => ({
      ...materialCellProps(column.columnDef.meta),
      className: "table-head",
      sx: {
        ...materialCellProps(column.columnDef.meta).sx,
        backgroundColor: "var(--surface-low)",
        borderBottom: "1px solid var(--border)",
        color: "var(--muted)",
        fontFamily: "inherit",
        fontSize: "11px",
        fontWeight: 700,
        height: tableProps?.density === "compact" ? "40px" : "48px",
        letterSpacing: "0.08em",
        padding: tableProps?.density === "compact" ? "6px 10px" : "9px 12px",
        textTransform: "uppercase",
        verticalAlign: "middle"
      }
    }),
    muiTableBodyCellProps: ({ column }) => ({
      ...materialCellProps(column.columnDef.meta),
      className: "table-cell",
      sx: {
        ...materialCellProps(column.columnDef.meta).sx,
        borderBottom: "1px solid var(--border)",
        color: "var(--text)",
        fontFamily: "inherit",
        fontSize: "13px",
        height: tableProps?.density === "compact" ? "40px" : "48px",
        padding: tableProps?.density === "compact" ? "6px 10px" : "9px 12px",
        verticalAlign: "middle"
      }
    }),
    muiSelectCheckboxProps: {
      sx: {
        color: "var(--muted)",
        "&.Mui-checked, &.MuiCheckbox-indeterminate": { color: "var(--primary)" }
      }
    }
  });

  const visibleRows = instance.getRowModel().rows;
  const selectedCount = Object.values(state?.rowSelection ?? {}).filter(Boolean).length;

  useEffect(() => {
    const rowSelection = state?.rowSelection;
    const changeSelection = onStateChange?.rowSelection;
    if (!selection || !rowSelection || !changeSelection || selection.strategy === "cross-page") return;
    const validIds = new Set(data.map(getRowId));
    const next = Object.fromEntries(Object.entries(rowSelection).filter(([rowId, selected]) => selected && validIds.has(rowId)));
    if (Object.keys(next).length !== Object.keys(rowSelection).length) changeSelection(next);
  }, [data, getRowId, onStateChange?.rowSelection, selection, state?.rowSelection]);

  const showToolbar = Boolean(toolbar?.content || toolbar?.actions || selection?.bulkAction);
  return (
    <div data-ui-page-surface-ready="true">
      {showToolbar ? (
        <div className="data-table-toolbar" aria-label={selection ? `${selection.selectedLabel} table tools` : "Table tools"}>
          <div className="data-table-toolbar-summary">
            {toolbar?.content}
            {selection?.bulkAction && selectedCount > 0 ? <Badge variant="secondary">{selectedCount} selected</Badge> : null}
            {selection?.bulkAction ? <Badge variant="secondary">{visibleRows.length} rows</Badge> : null}
          </div>
          <div className="data-table-toolbar-actions">
            {toolbar?.actions}
            {selection?.bulkAction ? (
              <>
                <Button type="button" variant="secondary" onClick={selection.bulkAction.onClick} disabled={selectedCount === 0}>
                  {selection.bulkAction.label ?? "Bulk edit"}
                </Button>
                <Button type="button" variant="secondary" onClick={() => onStateChange?.rowSelection?.({})} disabled={selectedCount === 0}>
                  {selection.bulkAction.clearLabel ?? "Clear"}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <MaterialReactTable table={instance} />
      {!serverManaged && data.length > 0 ? (
        <MaterialTablePagination
          page={instance.getState().pagination.pageIndex + 1}
          pageSize={allowedPageSize(instance.getState().pagination.pageSize)}
          totalPages={instance.getPageCount()}
          total={data.length}
          noun={selection?.selectedLabel ?? "records"}
          onPageSizeChange={(pageSize) => instance.setPageSize(pageSize)}
          onPrevious={() => instance.previousPage()}
          onNext={() => instance.nextPage()}
        />
      ) : null}
    </div>
  );
}

function toMaterialColumn<TRow extends MRT_RowData>(column: ColumnDef<TRow, unknown>): MRT_ColumnDef<TRow> {
  const source = column as ColumnDef<TRow, unknown> & {
    accessorKey?: string;
    columns?: Array<ColumnDef<TRow, unknown>>;
    header?: ReactNode | ((context: unknown) => ReactNode);
    cell?: (context: unknown) => ReactNode;
  };
  const id = source.id ?? source.accessorKey ?? "column";
  const header = typeof source.header === "string" ? source.header : id;
  return {
    ...source,
    header,
    ...(typeof source.header === "function" ? { Header: source.header } : {}),
    ...(source.cell ? {
      Cell: (context) => source.cell?.({
        cell: context.cell,
        column: context.column,
        getValue: () => context.cell.getValue(),
        renderValue: () => context.cell.renderValue(),
        row: context.row,
        table: context.table
      })
    } : {}),
    ...(source.columns ? { columns: source.columns.map((child) => toMaterialColumn(child)) } : {})
  } as MRT_ColumnDef<TRow>;
}

function materialCellProps(meta: { align?: TableAlignment; minWidth?: number | string; width?: number | string } | undefined) {
  return {
    align: meta?.align,
    sx: {
      ...(meta?.minWidth !== undefined ? { minWidth: cssSize(meta.minWidth) } : {}),
      ...(meta?.width !== undefined ? { width: cssSize(meta.width) } : {})
    }
  };
}

function tableMinWidth(value: TableProps["minWidth"]): string {
  if (typeof value === "number") return `${value}px`;
  if (value === "auto") return "100%";
  if (value === "content" || value === undefined) return "max(100%, 48rem)";
  if (value === "wide") return "max(100%, 64rem)";
  return value;
}

function cssSize(value: number | string): string {
  return typeof value === "number" ? `${value}px` : value;
}

function allowedPageSize(pageSize: number | undefined): TablePageSize {
  return normalizeTablePageSize(pageSize ?? DEFAULT_DATA_TABLE_PAGE_SIZE);
}

export type { ColumnDef, PaginationState, RowSelectionState, SortingState, VisibilityState } from "@tanstack/react-table";
