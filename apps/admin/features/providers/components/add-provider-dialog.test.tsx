// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { providerOnboardingUiCapabilities } from "@frely/providers";
import { AddProviderDialog } from "./add-provider-dialog";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  fetchDialog: vi.fn(),
  fetchUsers: vi.fn(),
  fetchApiKeys: vi.fn()
}));

vi.mock("@admin/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../api/provider-api", () => ({
  createProvider: vi.fn(),
  fetchProviderApiKeyCandidates: mocks.fetchApiKeys,
  fetchProviderOAuthStatus: vi.fn(),
  fetchProviderUserCandidates: mocks.fetchUsers,
  importProviderCredential: vi.fn(),
  saveProviderCredential: vi.fn(),
  startProviderOAuth: vi.fn(),
  submitProviderOAuthCallback: vi.fn(),
  syncProviderModels: vi.fn(),
  updateProvider: vi.fn()
}));
vi.mock("../query/provider-query-options", () => ({
  providerDialogQueryOptions: (enabled: boolean) => ({ queryKey: ["provider-dialog"], queryFn: mocks.fetchDialog, enabled })
}));

beforeEach(() => {
  mocks.fetchDialog.mockResolvedValue({ teams: [], session: { userId: "owner-a" } });
  mocks.fetchUsers.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 });
  mocks.fetchApiKeys.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CPA Provider onboarding capability UI", () => {
  it("discovers compatible kinds, generic flows, optional Base URL, and explicit blocked capabilities", async () => {
    const user = userEvent.setup();
    render(<AddProviderDialog capabilities={providerOnboardingUiCapabilities()} />, { wrapper: TestProviders });
    await user.click(screen.getByRole("button", { name: "Add Provider" }));

    expect(screen.getByText("Gemini Interactions API Key")).toBeInTheDocument();
    expect(screen.getByText(/does not expose a public Interactions Gateway path/)).toBeInTheDocument();

    const kindInput = screen.getByLabelText("Provider Kind");
    await user.click(kindInput);
    expect(screen.getByText("Gemini / Gemini-compatible")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("option", { name: "Claude / Anthropic-compatible" }));

    expect(kindInput).toHaveValue("Claude / Anthropic-compatible");
    const authInput = screen.getByLabelText("Auth Method");
    fireEvent.focus(authInput);
    fireEvent.keyDown(authInput, { key: "ArrowDown" });
    fireEvent.keyDown(authInput, { key: "Enter" });
    expect(authInput).toHaveValue("API Key");
    expect(screen.getByPlaceholderText("https://api.example.com/v1")).not.toBeRequired();

    await user.click(screen.getByLabelText("Provider Kind"));
    fireEvent.mouseDown(screen.getByRole("option", { name: "Vertex / Vertex-compatible" }));
    fireEvent.focus(authInput);
    fireEvent.keyDown(authInput, { key: "ArrowDown" });
    fireEvent.keyDown(authInput, { key: "Enter" });
    expect(authInput).toHaveValue("Service Account Import");
    expect(screen.getByLabelText(/Service Account JSON/)).toHaveAttribute("type", "file");
    expect(screen.getByLabelText("Vertex Location")).toBeRequired();
  });
});

function TestProviders({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
}
