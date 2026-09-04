// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { DeleteProviderButton } from "./delete-provider-button";
import { ProvidersTable, type ProviderTableRow } from "./providers-table";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  deleteProvider: vi.fn(),
  reconcile: vi.fn(),
  updateProvider: vi.fn(),
}));
vi.mock("@admin/navigation", () => ({
  usePathname: () => "/owner/providers",
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("../api/provider-api", () => ({
  deleteProvider: mocks.deleteProvider,
  reconcileVisibleProviderBindings: mocks.reconcile,
  updateProvider: mocks.updateProvider,
  updateProviderModel: vi.fn(),
}));

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.reconcile.mockResolvedValue({ items: [] });
  mocks.updateProvider.mockResolvedValue({});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Provider retention UI (REQ-GA-015)", () => {
  it("renders the hidden-retained count and persists the explicit URL switch", async () => {
    const user = userEvent.setup();
    render(<ProvidersTable rows={[]} showRetained={false} hiddenRetainedCount={3} />, { wrapper: TestProviders });

    expect(screen.getByText("3 retained by online billing history")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Show retained Providers/u }));
    expect(mocks.replace).toHaveBeenCalledWith("/owner/providers?showRetained=1", { scroll: false });
  });

  it("refreshes only stale visible Provider bindings through the batch command", async () => {
    const row = providerRow({ retained: false });
    row.binding = {
      authMethod: "api-key", credentialOwnership: "cpa-managed", credentialPreview: "key-...", revision: 4,
      syncStatus: "ready", errorCode: null, updatedAt: "2026-01-01T00:00:00.000Z",
    };
    render(<ProvidersTable rows={[row]} showRetained={false} hiddenRetainedCount={0} />, { wrapper: TestProviders });
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith([{ providerId: "prv_retained", expectedRevision: 4 }], expect.anything()));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("surfaces per-Provider refresh outcomes returned in a successful batch response", async () => {
    const row = providerRow({ retained: false });
    row.binding = {
      authMethod: "api-key", credentialOwnership: "cpa-managed", credentialPreview: "key-...", revision: 5,
      syncStatus: "ready", errorCode: null, updatedAt: "2026-01-01T00:00:00.000Z",
    };
    mocks.reconcile.mockResolvedValue({ items: [{ providerId: row.id, result: "transient" }] });
    render(<ProvidersTable rows={[row]} showRetained={false} hiddenRetainedCount={0} />, { wrapper: TestProviders });
    expect(await screen.findByText("1 Provider binding needs attention after refresh.")).toBeInTheDocument();
  });

  it("submits an exact safe Provider payload when bulk-moving scope", async () => {
    const user = userEvent.setup();
    const row = providerRow({ retained: false });
    row.configJson = JSON.stringify({ apiFormat: "openai", timeoutMs: 30_000 });
    row.binding = {
      authMethod: "api-key", credentialOwnership: "cpa-managed", credentialPreview: null, revision: 7,
      syncStatus: "pending", errorCode: null, updatedAt: "2026-01-01T00:00:00.000Z",
    };
    render(<ProvidersTable rows={[row]} showRetained={false} hiddenRetainedCount={0} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("checkbox", { name: "Toggle select row" }));
    await user.click(screen.getByRole("button", { name: "Bulk edit" }));
    const scope = screen.getByRole("combobox", { name: /^Scope/u });
    await user.click(scope);
    await user.type(scope, "team:target");
    await waitFor(() => expect(scope.getAttribute("aria-activedescendant")).toContain("custom"));
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mocks.updateProvider).toHaveBeenCalledWith({
      id: "prv_retained",
      scopeRef: "team:target",
      name: "Retained",
      kind: "openai-codex",
      authMethod: "api-key",
      status: "disabled",
      config: { apiFormat: "openai", timeoutMs: 30_000 },
    }));
    expect(mocks.updateProvider).toHaveBeenCalledTimes(1);
  });

  it("disables deletion and explains billing plus AccessPoint blockers", async () => {
    const user = userEvent.setup();
    render(<DeleteProviderButton provider={{ id: "prv_retained", name: "Retained", status: "disabled" }} deletionState={{ hasAccessPointReferences: true, hasOnlineBillingHistory: true, credentialCleared: true }} />, { wrapper: TestProviders });

    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).toBeDisabled();
    await user.hover(button);
    expect((await screen.findAllByText(/retained by online billing history and still has AccessPoints/u)).length).toBeGreaterThan(0);
  });

  it("labels retained rows when the explicit retained view is open", () => {
    render(<ProvidersTable rows={[providerRow({ retained: true })]} showRetained hiddenRetainedCount={1} />, { wrapper: TestProviders });

    expect(screen.getByText("Retained history")).toBeInTheDocument();
  });

  it("describes archive-before-delete and never claims credential recovery", async () => {
    const user = userEvent.setup();
    render(<DeleteProviderButton provider={{ id: "prv_eligible", name: "Eligible", status: "disabled" }} deletionState={{ hasAccessPointReferences: false, hasOnlineBillingHistory: false, credentialCleared: true }} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/archives the Provider structure for audit and recovery/u)).toBeInTheDocument();
    expect(screen.getByText(/Credentials are never archived/u)).toBeInTheDocument();
  });
});

function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>;
}

function providerRow(deletionState: { retained: boolean }): ProviderTableRow {
  return {
    id: "prv_retained",
    scopeRef: "global:",
    name: "Retained",
    kind: "openai-codex",
    status: "disabled",
    configJson: "{}",
    binding: null,
    modelCount: 0,
    modelNames: [],
    deletionState: {
      hasAccessPointReferences: false,
      hasOnlineBillingHistory: deletionState.retained,
      credentialCleared: true,
      retained: deletionState.retained
    }
  };
}
