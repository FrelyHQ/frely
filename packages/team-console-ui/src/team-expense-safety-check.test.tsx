/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TeamDetailView, type ExpenseSafetyCheckGroup } from "./index.js";

afterEach(cleanup);

describe("Team expense safety checks", () => {
  it("does not render a card when the server returned no checks", () => {
    renderDetail([]);

    expect(screen.queryByRole("heading", { name: "Expense & safety checks" })).toBeNull();
  });

  it("renders warning groups without exposing subscription identifiers", () => {
    const checks: ExpenseSafetyCheckGroup[] = [
      { perspective: "teamOwner", checks: [{ code: "team_prepaid_member_access", level: "warning", affectedSubscriptionCount: 2, earliestEffectiveEnd: "2026-08-01T00:00:00.000Z" }] },
      { perspective: "member", checks: [{ code: "team_paygo_member_charge", level: "warning", affectedSubscriptionCount: 1, earliestEffectiveEnd: null }] }
    ];
    renderDetail(checks);

    expect(screen.getByRole("heading", { name: "Expense & safety checks" })).toBeTruthy();
    expect(screen.getByText("Team Owner view")).toBeTruthy();
    expect(screen.getByText("Member view")).toBeTruthy();
    expect(screen.getByText("Affected subscriptions: 2", { exact: false })).toBeTruthy();
    expect(screen.queryByText("plan_sub_private")).toBeNull();
  });
});

function renderDetail(expenseSafetyChecks: ExpenseSafetyCheckGroup[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Providers({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>;
  }
  return render(<TeamDetailView
    accessLevel="user"
    team={{
      initials: "ES", name: "Expense Safety", id: "team_1", ownerId: "owner_1", status: "Active", members: "Restricted", usage: 0,
      planName: "Restricted", planState: "Restricted", planWindow: "No permission", planEffectiveStart: null, planEffectiveEnd: null,
      budget: "Hidden", budgetState: "Restricted", accessCoverage: "Owner only", canManageMemberApiKeyLimit: false,
      canManageMemberCredit: false, teamOwnerCanCreateCustomProvider: false, teamOwnerCanCreateAccessPoint: false,
      createdAt: "Jul 1, 2026", createdAtIso: "2026-07-01T00:00:00.000Z"
    }}
    users={[]}
    expenseSafetyChecks={expenseSafetyChecks}
  />, { wrapper: Providers });
}
