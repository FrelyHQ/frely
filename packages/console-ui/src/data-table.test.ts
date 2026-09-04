import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable, type ColumnDef } from "./data-table.js";

interface Row { id: string; name: string }

const columns: Array<ColumnDef<Row, unknown>> = [
  { accessorKey: "name", header: "Name", meta: { minWidth: 180 } }
];

describe("DataTable", () => {
  it("uses the Material React Table surface, structured empty row, and selection column", () => {
    const markup = renderToStaticMarkup(createElement(DataTable<Row>, {
      columns,
      data: [],
      emptyState: { title: "No rows", description: "Change the filters." },
      getRowId: (row) => row.id,
      onStateChange: { rowSelection: () => undefined },
      selection: { selectedLabel: "rows" },
      state: { rowSelection: {} }
    }));
    expect(markup).toContain("table-surface");
    expect(markup).toContain("MuiCheckbox-root");
    expect(markup).toContain('colSpan="2"');
    expect(markup).toContain("No rows");
    expect(markup).toContain("Change the filters.");
  });

  it("renders sortable headers with aria-sort and column metadata", () => {
    const markup = renderToStaticMarkup(createElement(DataTable<Row>, {
      columns,
      data: [{ id: "1", name: "Alpha" }],
      getRowId: (row) => row.id,
      initialState: { sorting: [{ id: "name", desc: false }] }
    }));
    expect(markup).toContain('aria-sort="ascending"');
    expect(markup).toContain('min-width:180px');
    expect(markup).toContain("Alpha");
  });

  it("adapts TanStack cell getValue callbacks to Material React Table", () => {
    const valueColumns: Array<ColumnDef<Row, unknown>> = [{
      accessorKey: "name",
      header: "Name",
      cell: ({ getValue }) => createElement("strong", null, String(getValue())),
    }];
    const markup = renderToStaticMarkup(createElement(DataTable<Row>, {
      columns: valueColumns,
      data: [{ id: "1", name: "Alpha" }],
      getRowId: (row) => row.id,
    }));

    expect(markup).toContain("<strong>Alpha</strong>");
  });

  it("defaults local pagination to 20 rows", () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({ id: String(index), name: `Row-${index}` }));
    const markup = renderToStaticMarkup(createElement(DataTable<Row>, {
      columns,
      data: rows,
      getRowId: (row) => row.id,
      initialState: { pagination: { pageIndex: 0, pageSize: 20 } }
    }));

    expect(markup).toContain("Row-19");
    expect(markup).not.toContain("Row-20");

    const customMarkup = renderToStaticMarkup(createElement(DataTable<Row>, {
      columns,
      data: rows,
      getRowId: (row) => row.id,
      initialState: { pagination: { pageIndex: 0, pageSize: 13 } }
    }));
    expect(customMarkup).toContain("Row-12");
    expect(customMarkup).not.toContain("Row-13");
  });

  it("bounds sticky tables to the console workspace instead of the root viewport", () => {
    const markup = renderToStaticMarkup(createElement(DataTable<Row>, {
      columns,
      data: [{ id: "1", name: "Alpha" }],
      getRowId: (row) => row.id,
      table: { stickyHeader: true }
    }));

    expect(markup).toContain("data-table-scroll-container");
    expect(markup).toContain("calc(100dvh - var(--console-header-height))");
    expect(markup).toContain("@media (max-width: 900px)");
    expect(markup).toContain("max-height:none");
  });

  it("does not create a vertical table scroll owner without a sticky header", () => {
    const markup = renderToStaticMarkup(createElement(DataTable<Row>, {
      columns,
      data: [{ id: "1", name: "Alpha" }],
      getRowId: (row) => row.id
    }));

    expect(markup).not.toContain("data-table-scroll-container");
    expect(markup).not.toContain("calc(100dvh - var(--console-header-height))");
  });
});
