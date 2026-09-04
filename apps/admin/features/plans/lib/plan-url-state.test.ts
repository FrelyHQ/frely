import { describe, expect, test } from "vitest";
import { parsePlansUrlState, plansHref } from "./plan-url-state";

describe("Plans URL state", () => {
  test("allowlists status, bounds search, and normalizes pages", () => {
    const state = parsePlansUrlState({
      q: ` ${"p".repeat(120)} `,
      status: "unknown",
      page: "-1",
    });
    expect(state).toMatchObject({ status: "all", page: 1 });
    expect(state.query).toHaveLength(100);
  });

  test("builds a stable directory URL", () => {
    expect(plansHref({ query: "pro", status: "closed", page: 2, pageSize: 20 }))
      .toBe("/owner/plans-and-budgets/plans?q=pro&status=closed&page=2");
  });
});
