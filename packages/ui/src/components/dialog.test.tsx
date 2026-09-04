import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DialogFooter, DialogHeader } from "./dialog.js";

describe("dialog scroll composition", () => {
  it("keeps opt-in headers and footers visible around scrollable content", () => {
    const header = renderToStaticMarkup(<DialogHeader sticky>Heading</DialogHeader>);
    const footer = renderToStaticMarkup(<DialogFooter sticky feedback={<div role="status">Saved</div>}>Actions</DialogFooter>);

    expect(header).toContain("sticky top-0");
    expect(header).toContain("bg-card");
    expect(footer).toContain("sticky bottom-0");
    expect(footer).toContain("border-t bg-card");
    expect(footer).toContain("role=\"status\"");
    expect(footer.indexOf("Saved")).toBeLessThan(footer.indexOf("Actions"));
  });

  it("does not make short dialog regions sticky by default", () => {
    const header = renderToStaticMarkup(<DialogHeader>Heading</DialogHeader>);
    const footer = renderToStaticMarkup(<DialogFooter>Actions</DialogFooter>);

    expect(header).not.toContain("sticky");
    expect(footer).not.toContain("sticky");
  });
});
