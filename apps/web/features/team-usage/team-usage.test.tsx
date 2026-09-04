// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { TeamUsageControls } from "./index";

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("@web/navigation", () => ({ default: "a", useRouter: () => ({ replace: mocks.replace }) }));

beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));

afterAll(() => vi.unstubAllGlobals());

afterEach(() => {
  cleanup();
  mocks.replace.mockReset();
});

describe("REQ-TA-016 Team usage controls", () => {
  test("renders current members, zero usage, committed source, and URL-owned search", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <TooltipProvider>
        <QueryClientProvider client={client}>
          <TeamUsageControls
            teamId="team"
            state={{ subscriptionId: "subscription", query: "", sort: "usage", direction: "desc", page: 1, pageSize: 20 }}
            candidates={{
              items: [candidate],
              page: 1,
              pageSize: 20,
              total: 1,
              totalPages: 1,
            }}
            selected={candidate}
            items={[{
              userId: "member",
              email: "member@example.com",
              roles: ["viewer"],
              status: "disabled",
              requestCount: 0,
              totalTokens: 0,
              billableAmount: 0,
              lastUsedAt: null,
            }]}
            page={1}
            pageSize={50}
            total={1}
            totalPages={1}
          />
        </QueryClientProvider>
      </TooltipProvider>,
    );

    expect(screen.getByRole("combobox", { name: "Active Team Subscription" })).toHaveValue("Team Plan v2");
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
    expect(screen.getByText("viewer · disabled")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "member" } });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(mocks.replace).toHaveBeenCalledWith("/user/team/team/usage?subscriptionId=subscription&q=member");

    view.rerender(
      <TooltipProvider>
        <QueryClientProvider client={client}>
          <TeamUsageControls
            teamId="team"
            state={{ subscriptionId: "subscription", query: "other", sort: "usage", direction: "desc", page: 1, pageSize: 20 }}
            candidates={{ items: [candidate], page: 1, pageSize: 20, total: 1, totalPages: 1 }}
            selected={candidate}
            items={[]}
            page={1}
            pageSize={50}
            total={0}
            totalPages={1}
          />
        </QueryClientProvider>
      </TooltipProvider>,
    );
    expect(screen.getByLabelText("Search members")).toHaveValue("other");
  });

  test("recovers from a stale source without presenting fallback usage as loaded", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <TooltipProvider>
        <QueryClientProvider client={client}>
          <TeamUsageControls
            teamId="team"
            state={{ subscriptionId: "stale-source", query: "member", sort: "tokens", direction: "asc", page: 1, pageSize: 20 }}
            candidates={{ items: [candidate], page: 1, pageSize: 20, total: 1, totalPages: 1 }}
            selected={null}
            items={[]}
            page={1}
            pageSize={50}
            total={0}
            totalPages={1}
            showMemberUsage={false}
          />
        </QueryClientProvider>
      </TooltipProvider>,
    );

    expect(screen.queryByRole("heading", { name: "Member Usage" })).not.toBeInTheDocument();
    const source = screen.getByRole("combobox", { name: "Active Team Subscription" });
    expect(source).toHaveValue("");
    await userEvent.click(source);
    await userEvent.click(screen.getByRole("option", { name: /Team Plan v2/ }));
    expect(mocks.replace).toHaveBeenCalledWith(
      "/user/team/team/usage?subscriptionId=subscription&q=member&sort=tokens&direction=asc",
    );
  });
});

const candidate = {
  id: "subscription",
  planName: "Team Plan",
  planVersion: 2,
  billingMode: "prepaid" as const,
  effectiveStart: "2026-07-30T00:00:00.000Z",
  effectiveEnd: null,
};
