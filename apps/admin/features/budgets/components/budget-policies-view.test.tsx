import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { BudgetPoliciesView } from "./budget-policies-view";

vi.mock("@admin/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.stubGlobal("React", React);

describe("BudgetPoliciesView", () => {
  test("server-renders amount policies without direct assignments", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <QueryClientProvider client={new QueryClient()}>
          <BudgetPoliciesView
            state={{
              policyQuery: "",
              policyPage: 1,
              policyPageSize: 20,
              assignmentQuery: "",
              assignmentPage: 1,
              assignmentPageSize: 20,
            }}
            policies={{
              items: [{
                id: "policy_amount",
                metric: "amount",
                limitValue: 10,
                windowType: "cumulative",
                windowSeconds: null,
                status: "enabled",
                createdAt: "2026-07-31T00:00:00.000Z",
                updatedAt: "2026-07-31T00:00:00.000Z",
              }],
              page: 1,
              pageSize: 20,
              total: 1,
              totalPages: 1,
            }}
            directAssignments={{
              items: [],
              page: 1,
              pageSize: 20,
              total: 0,
              totalPages: 1,
            }}
          />
        </QueryClientProvider>
      </TooltipProvider>,
    );

    expect(markup).toContain("Budget Policies");
    expect(markup).toContain("$10.00");
    expect(markup).toContain("No direct key limits");
  });
});
