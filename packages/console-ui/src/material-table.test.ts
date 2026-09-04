import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MaterialTable } from "./material-table.js";

describe("MaterialTable", () => {
  it("renders server-safe cells through Material React Table", () => {
    const markup = renderToStaticMarkup(createElement(MaterialTable, {
      columns: [{ header: "Name" }, { header: "Status" }],
      rows: [{ id: "row-1", cells: ["Alpha", "Enabled"] }],
      table: { "aria-label": "Example records" }
    }));

    expect(markup).toContain('aria-label="Example records"');
    expect(markup).toContain("Alpha");
    expect(markup).toContain("Enabled");
  });
});
