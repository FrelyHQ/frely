/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren, ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { TeamAccessPointRow, TeamPlanRow, TeamUserRow } from "./index.js";
import { TeamAccessPointsTable, TeamMembersTable, TeamPlansTable } from "./team-detail-tables.js";

afterEach(cleanup);

describe("Team Detail record table sorting", () => {
  it("sorts Users from the shared header interaction", async () => {
    const user = userEvent.setup();
    renderTable(<TeamMembersTable rows={[member("user-b", "Beta"), member("user-a", "Alpha")]} showActions={false} />);

    expect(bodyRowText(0)).toContain("Alpha");
    expect(screen.getByText("alpha@example.com").parentElement?.getAttribute("data-clarity-mask")).toBe("true");
    expect(screen.getByRole("columnheader", { name: /^User\b/ }).getAttribute("aria-sort")).toBe("ascending");

    await user.click(screen.getByRole("button", { name: /^(?:Sorted by|Sort by) User\b/ }));

    expect(bodyRowText(0)).toContain("Beta");
    expect(screen.getByRole("columnheader", { name: /^User\b/ }).getAttribute("aria-sort")).toBe("descending");
  });

  it("exposes sorting on every Team Detail data column and not on Actions", () => {
    const plans = renderTable(<TeamPlansTable rows={[plan()]} />);
    expect(sortButtonNames(plans.container)).toEqual(["Plan", "Terms", "Access & Budget", "Effective", "State"]);
    expect(within(plans.container).getByText("Plan enabled")).toBeTruthy();
    expect(within(plans.container).getByText("Subscription active")).toBeTruthy();
    cleanup();

    const accessPoints = renderTable(<TeamAccessPointsTable rows={[accessPoint()]} />);
    expect(sortButtonNames(accessPoints.container)).toEqual(["AccessPoint", "Exposed Model", "Target", "Order", "Price", "Status"]);
  });

  it("explains that closed and disabled Plans are available through the filter", () => {
    renderTable(<TeamPlansTable rows={[]} planStatusFilter="enabled" />);

    expect(screen.getByText("No enabled Team Plan subscriptions.")).toBeTruthy();
    expect(screen.getByText("Choose another Plan status to view closed or disabled subscriptions.")).toBeTruthy();
  });
});

function bodyRowText(index: number) {
  return screen.getAllByRole("row").slice(1)[index]?.textContent ?? "";
}

function renderTable(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Providers({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>;
  }
  return render(element, { wrapper: Providers });
}

function sortButtonNames(container: HTMLElement) {
  return within(container).getAllByRole("columnheader").flatMap((header) => {
    const button = within(header).queryByRole("button");
    const label = button?.getAttribute("aria-label") ?? "";
    const match = label.match(/^(?:Sorted by|Sort by) (.+?) (?:ascending|descending)$/);
    return match?.[1] ? [match[1]] : [];
  });
}

function member(id: string, name: string): { user: TeamUserRow } {
  return { user: { id, teamId: "team-1", name, email: `${name.toLowerCase()}@example.com`, role: "User", status: "Active", apiKeys: "2", apiKeyLimit: 5, lastSeen: "Never", lastSeenAt: null, createdAt: "2026-07-01", createdAtIso: "2026-07-01T00:00:00.000Z" } };
}

function plan(): TeamPlanRow {
  return { id: "sub-1", planTemplateId: "plan-1", templateName: "Starter", billingMode: "prepaid", planStatus: "enabled", status: "active", priority: 10, effectiveStart: "2026-07-01T00:00:00.000Z", effectiveEnd: null, duration: "30 days", price: "$10.00", budgetSummary: "No limit", includedAccessPoints: "2 APs" };
}

function accessPoint(): TeamAccessPointRow {
  return { id: "ap-1", name: "Default", description: null, apiFamily: "openai", exposedModel: "model-a", targetModel: "model-b", targetType: "Provider", targetLabel: "Provider A", status: "enabled", priority: 10, fallbackOrder: 0, price: "$0.01" };
}
