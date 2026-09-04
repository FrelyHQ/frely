import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Table, TableBody, TableCell, TableEmptyRow, TableHead, TableHeader, TablePagination, TableRow } from "./table.js";

describe("shared Table", () => {
  it("renders density, sticky header, width, alignment, and selected row state", () => {
    const markup = renderToStaticMarkup(createElement(Table, { density: "compact", stickyHeader: true, minWidth: 980, "aria-label": "Example" },
      createElement(TableHeader, null, createElement(TableRow, null, createElement(TableHead, { align: "right", width: 120 }, "Amount"))),
      createElement(TableBody, null, createElement(TableRow, { selected: true, clickable: true }, createElement(TableCell, { align: "right", width: 120 }, "42")))
    ));
    expect(markup).toContain('data-table-density="compact"');
    expect(markup).toContain('data-sticky-header="true"');
    expect(markup).toContain('--table-min-width:980px');
    expect(markup).toContain('data-align="right"');
    expect(markup).toContain('data-state="selected"');
    expect(markup).toContain('data-clickable="true"');
  });

  it("renders the structured empty state with the correct span", () => {
    const markup = renderToStaticMarkup(createElement(Table, null,
      createElement(TableBody, null, createElement(TableEmptyRow, { colSpan: 4, title: "No records", description: "Try another filter." }))
    ));
    expect(markup).toContain('colSpan="4"');
    expect(markup).toContain('data-empty="true"');
    expect(markup).toContain("No records");
    expect(markup).toContain("Try another filter.");
  });

  it("renders accessible link-driven pagination", () => {
    const markup = renderToStaticMarkup(createElement(TablePagination, { page: 2, totalPages: 4, total: 75, noun: "requests", previousHref: "?page=1", nextHref: "?page=3" }));
    expect(markup).toContain('aria-label="requests pagination"');
    expect(markup).toContain('rel="prev"');
    expect(markup).toContain('rel="next"');
    expect(markup).toContain("Page 2 of 4");
  });
});
