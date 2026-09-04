import { describe, expect, test } from "vitest";
import { budgetPoliciesHref, parseBudgetPoliciesUrlState } from "./budget-url-state";

describe("Budget Policies URL state", () => {
  test("allowlists bounded query and page values", () => {
    const state = parseBudgetPoliciesUrlState({
      policyQ: ` ${"p".repeat(120)} `,
      policyPage: "-1",
      assignmentQ: ["key", "ignored"],
      assignmentPage: "not-a-page",
    });
    expect(state).toMatchObject({
      policyPage: 1,
      assignmentQuery: "key",
      assignmentPage: 1,
    });
    expect(state.policyQuery).toHaveLength(100);
  });

  test("preserves independent policy and assignment positions", () => {
    expect(budgetPoliciesHref({
      policyQuery: "tokens",
      policyPage: 2,
      policyPageSize: 20,
      assignmentQuery: "prefix",
      assignmentPage: 3,
      assignmentPageSize: 20,
    })).toBe(
      "/owner/plans-and-budgets/budget-policies?policyQ=tokens&policyPage=2&assignmentQ=prefix&assignmentPage=3",
    );
  });
});
