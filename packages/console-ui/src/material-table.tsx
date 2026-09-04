"use client";

import type { TableAlignment, TableProps } from "@frely/ui/components/table";
import { useMemo, type ReactNode } from "react";
import { DataTable, type ColumnDef, type DataTableEmptyState } from "./data-table.js";

export interface MaterialTableColumn {
  align?: TableAlignment;
  header: ReactNode;
  minWidth?: number | string;
  width?: number | string;
}

export interface MaterialTableRow {
  cells: ReactNode[];
  className?: string;
  clickable?: boolean;
  disabled?: boolean;
  id: string;
}

export interface MaterialTableProps {
  columns: MaterialTableColumn[];
  emptyState?: DataTableEmptyState;
  rows: MaterialTableRow[];
  table?: DataTableTableProps;
}

type DataTableTableProps = Pick<TableProps, "aria-label" | "className" | "density" | "minWidth" | "stickyHeader" | "wrapperClassName">;

/**
 * Material React Table adapter for server-rendered and fixed-detail tables.
 * React nodes remain owned by the calling RSC while the client boundary owns
 * the MRT column definitions and rendering behavior.
 */
export function MaterialTable({ columns, emptyState, rows, table }: MaterialTableProps) {
  const definitions = useMemo<Array<ColumnDef<MaterialTableRow, unknown>>>(
    () => columns.map((column, index) => ({
      id: `column-${index}`,
      accessorFn: (row) => row.cells[index],
      header: () => column.header,
      cell: ({ row }) => row.original.cells[index],
      enableSorting: false,
      meta: {
        ...(column.align ? { align: column.align } : {}),
        ...(column.minWidth !== undefined ? { minWidth: column.minWidth } : {}),
        ...(column.width !== undefined ? { width: column.width } : {})
      }
    })),
    [columns]
  );

  return (
    <DataTable
      columns={definitions}
      data={rows}
      {...(emptyState ? { emptyState } : {})}
      getRowId={(row) => row.id}
      getRowProps={(row) => ({
        ...(row.className ? { className: row.className } : {}),
        ...(row.clickable !== undefined ? { clickable: row.clickable } : {}),
        ...(row.disabled !== undefined ? { disabled: row.disabled } : {})
      })}
      serverManaged
      {...(table ? { table } : {})}
    />
  );
}
