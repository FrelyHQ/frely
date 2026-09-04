// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { PublicHostsPanel } from "./public-hosts-panel";

const mocks = vi.hoisted(() => ({
  createPublicHost: vi.fn(),
  deletePublicHost: vi.fn(),
  refresh: vi.fn(),
  setPublicHostEnabled: vi.fn(),
}));

vi.mock("@admin/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("../api/public-host-api", () => ({
  createPublicHost: mocks.createPublicHost,
  deletePublicHost: mocks.deletePublicHost,
  setPublicHostEnabled: mocks.setPublicHostEnabled,
}));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.createPublicHost.mockResolvedValue({ id: "new", hostname: "new.example.test", enabled: false });
  mocks.setPublicHostEnabled.mockResolvedValue({ id: "alias", hostname: "alias.example.test", enabled: true });
  mocks.deletePublicHost.mockResolvedValue(undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Public Hosts Owner UI", () => {
  test("keeps Default read-only and refreshes RSC data after create, status, and delete mutations", async () => {
    const user = userEvent.setup();
    render(
      <PublicHostsPanel
        defaultHost={{ hostname: "relay.example.test", origin: "https://relay.example.test" }}
        aliases={{
          items: [{
            id: "alias",
            hostname: "alias.example.test",
            enabled: false,
            createdByUserId: "owner",
            updatedByUserId: "owner",
            createdAt: "2026-07-30T00:00:00.000Z",
            updatedAt: "2026-07-30T00:00:00.000Z",
          }],
          page: 1,
          pageSize: 50,
          total: 1,
          totalPages: 1,
        }}
      />,
      { wrapper: TestProviders },
    );

    expect(screen.getByText("Canonical default")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Enable" }));
    const statusDialog = screen.getByRole("dialog");
    await user.click(within(statusDialog).getByRole("button", { name: "Enable Host" }));
    await waitFor(() => expect(mocks.setPublicHostEnabled).toHaveBeenCalled());
    expect(mocks.setPublicHostEnabled.mock.calls[0]?.[0]).toEqual({ id: "alias", enabled: true });

    await user.click(screen.getByRole("button", { name: "Add Host" }));
    const createDialog = screen.getByRole("dialog");
    await user.type(within(createDialog).getByLabelText("Public Host hostname"), "new.example.test");
    await user.click(within(createDialog).getByRole("button", { name: "Create Disabled Host" }));
    await waitFor(() => expect(mocks.createPublicHost).toHaveBeenCalled());
    expect(mocks.createPublicHost.mock.calls[0]?.[0]).toBe("new.example.test");

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const deleteDialog = screen.getByRole("dialog");
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete Host" }));
    await waitFor(() => expect(mocks.deletePublicHost).toHaveBeenCalled());
    expect(mocks.deletePublicHost.mock.calls[0]?.[0]).toBe("alias");
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
  });
});

function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  return <QueryClientProvider client={client}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>;
}
