// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { WebRegistrationCard } from "./web-registration-card";

const mocks = vi.hoisted(() => ({
  fetchCandidates: vi.fn(),
  updateSetting: vi.fn(),
  refresh: vi.fn()
}));

vi.mock("@admin/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../api/web-registration-api", () => ({
  fetchWebRegistrationTeamCandidates: mocks.fetchCandidates,
  updateWebRegistrationSetting: mocks.updateSetting
}));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.fetchCandidates.mockResolvedValue({ items: [], nextCursor: null });
  mocks.updateSetting.mockResolvedValue({ enabled: false, configured: false, team: null, updatedAt: "2026-08-02T00:00:00.000Z" });
});

afterEach(cleanup);

describe("Web self-registration Owner UI", () => {
  test("disables the configured target through the single setting mutation", async () => {
    const user = userEvent.setup();
    render(
      <WebRegistrationCard
        initial={{
          enabled: true,
          configured: true,
          team: { id: "team_public", name: "Public Team" },
          updatedAt: "2026-08-01T00:00:00.000Z"
        }}
      />,
      { wrapper: TestProviders }
    );

    expect(screen.getByText("Enabled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disable self-registration" }));
    await waitFor(() => expect(mocks.updateSetting).toHaveBeenCalled());
    expect(mocks.updateSetting.mock.calls[0]?.[0]).toBeNull();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});

function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>;
}
