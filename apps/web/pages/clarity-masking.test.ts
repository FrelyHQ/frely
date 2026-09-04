import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Clarity masking boundary", () => {
  it("does not explicitly mask the whole body", () => {
    const source = readFileSync(new URL("../src/root-shell.tsx", import.meta.url), "utf8");

    expect(source).toContain("<body>");
    expect(source).not.toMatch(/<body[^>]*data-clarity-mask/);
    expect(source).not.toContain('data-clarity-mask="false"');
  });
});
