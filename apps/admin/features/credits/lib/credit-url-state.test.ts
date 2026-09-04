import { describe, expect, test } from "vitest";
import { adminCreditsHref, parseAdminCreditsUrlState } from "./credit-url-state";

describe("Admin Credits URL state", () => {
  test("normalizes invalid pages and bounds free text", () => {
    const state = parseAdminCreditsUrlState({
      q: ` ${"a".repeat(120)} `,
      page: "-2",
      scopePage: "invalid",
      topupCursor: ["cursor", "ignored"],
    });
    expect(state).toMatchObject({ page: 1, scopePage: 1, topupCursor: "cursor" });
    expect(state.query).toHaveLength(100);
  });

  test("preserves independent directory and history positions", () => {
    expect(adminCreditsHref({
      query: "member",
      page: 2,
      pageSize: 20,
      scopePage: 3,
      scopePageSize: 20,
      configurationPage: 1,
      configurationPageSize: 20,
      topupCursor: "opaque",
      topupPageSize: 20,
    })).toBe("/owner/credits?q=member&page=2&scopePage=3&topupCursor=opaque");
  });
});
