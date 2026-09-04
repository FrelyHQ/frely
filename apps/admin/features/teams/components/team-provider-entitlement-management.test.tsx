// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { TeamProviderEntitlementManagement } from "./team-provider-entitlement-management";

const mocks = vi.hoisted(() => ({
  fetchCandidates: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@admin/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../api/team-api", () => ({
  cancelTeamProviderEntitlement: vi.fn(),
  fetchTeamProviderProductCandidates: mocks.fetchCandidates,
  grantTeamProviderEntitlement: vi.fn(),
}));

beforeEach(() => {
  mocks.fetchCandidates.mockReset();
  mocks.fetchCandidates.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 });
  mocks.refresh.mockReset();
});

afterEach(cleanup);

describe("Team custom Provider entitlement dialog composition", () => {
  it("keeps management fields out of Team Details until the dialog opens", async () => {
    const user = userEvent.setup();
    render(<TeamProviderEntitlementManagement
      teamId="team-1"
      state="not_entitled"
      history={[]}
      nextCursor={null}
      olderHref={null}
    />, { wrapper: TestProviders });

    expect(screen.getByText("Team Custom Provider Access")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Authority Product")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancellation reason")).not.toBeInTheDocument();
    expect(mocks.fetchCandidates).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Manage access" }));

    const dialog = screen.getByRole("dialog", { name: "Manage Team Custom Provider Access" });
    expect(within(dialog).getByText("Authority Product")).toBeInTheDocument();
    expect(within(dialog).getByText("Cancellation reason")).toBeInTheDocument();
    expect(within(dialog).getByText("No Team Provider entitlement history.")).toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchCandidates).toHaveBeenCalledWith("", 1, expect.any(AbortSignal)));

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Authority Product")).not.toBeInTheDocument();
  });
});

function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
