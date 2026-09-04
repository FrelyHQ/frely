// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PasskeyManagement } from "./passkey-management.js";
import type { AccountPasskey } from "../lib/passkey-api.js";

const passkeyApi = vi.hoisted(() => ({
  browserSupportsPasskeys: vi.fn(),
  deletePasskey: vi.fn(),
  listPasskeys: vi.fn(),
  passkeyUserMessage: vi.fn((error: unknown) => error instanceof Error && error.message === "Current password is invalid" ? "Current password is invalid" : "Passkey request failed"),
  registerPasskey: vi.fn(),
  renamePasskey: vi.fn()
}));

vi.mock("../lib/passkey-api.js", () => passkeyApi);

beforeEach(() => {
  passkeyApi.browserSupportsPasskeys.mockReturnValue(true);
  passkeyApi.listPasskeys.mockResolvedValue({ passkeys: [], canAdd: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PasskeyManagement", () => {
  test("lists only the current user's safe Passkey projection and surface availability", async () => {
    passkeyApi.listPasskeys.mockResolvedValue({ passkeys: [passkey({
      name: "Synced security key",
      backedUp: true,
      lastUsedAt: "2026-07-31T01:00:00.000Z",
      availableOn: ["web", "admin"]
    })], canAdd: true });

    renderManagement();

    expect(await screen.findByText("Synced security key")).toBeInTheDocument();
    expect(screen.getByText(/Available on Web and Admin/)).toBeInTheDocument();
    expect(screen.getByText(/Last used/)).toBeInTheDocument();
    expect(passkeyApi.listPasskeys).toHaveBeenCalledOnce();
  });

  test("adds a Passkey with current-password confirmation and refreshes only the safe list query", async () => {
    const user = userEvent.setup();
    let current: AccountPasskey[] = [];
    const created = passkey({ id: "passkey-created", name: "MacBook Touch ID" });
    passkeyApi.listPasskeys.mockImplementation(async () => ({ passkeys: current, canAdd: true }));
    passkeyApi.registerPasskey.mockImplementation(async () => {
      current = [created];
      return created;
    });
    const queryClient = renderManagement();

    await screen.findByText("No Passkeys added yet.");
    await user.type(screen.getByLabelText("Passkey name"), "MacBook Touch ID");
    await user.type(screen.getByLabelText("Current password"), "password-secret");
    await user.click(screen.getByRole("button", { name: "Add Passkey" }));

    await waitFor(() => expect(passkeyApi.registerPasskey).toHaveBeenCalledWith({
      name: "MacBook Touch ID",
      currentPassword: "password-secret"
    }));
    expect(await screen.findByText("Passkey added.")).toBeInTheDocument();
    expect(await screen.findByText("MacBook Touch ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Passkey name")).toHaveValue("");
    expect(screen.getByLabelText("Current password")).toHaveValue("");

    const cachedQueries = queryClient.getQueryCache().getAll();
    expect(cachedQueries.map((query) => query.queryKey)).toEqual([["account", "security", "passkeys"]]);
    expect(JSON.stringify(cachedQueries.map((query) => query.state.data))).not.toContain("password-secret");
    expect(JSON.stringify(cachedQueries.map((query) => query.state.data))).not.toContain("PublicKeyCredential");
  });

  test("renames and deletes one credential, requiring password only for deletion", async () => {
    const user = userEvent.setup();
    let current: AccountPasskey[] = [passkey({ name: "Old name" })];
    passkeyApi.listPasskeys.mockImplementation(async () => ({ passkeys: current, canAdd: true }));
    passkeyApi.renamePasskey.mockImplementation(async (id: string, name: string) => {
      current = current.map((item) => item.id === id ? { ...item, name } : item);
      return current[0]!;
    });
    passkeyApi.deletePasskey.mockImplementation(async (id: string) => {
      current = current.filter((item) => item.id !== id);
    });
    renderManagement();
    await screen.findByText("Old name");
    const passkeySection = within(screen.getByRole("region", { name: "Your Passkeys" }));

    await user.click(passkeySection.getByRole("button", { name: "Rename Old name" }));
    const renameInput = passkeySection.getByRole("textbox", { name: "New name for Old name" });
    await user.clear(renameInput);
    await user.type(renameInput, "New name");
    await user.click(passkeySection.getByRole("button", { name: "Save name for Old name" }));

    await waitFor(() => expect(passkeyApi.renamePasskey).toHaveBeenCalledWith("passkey-1", "New name"));
    expect(await screen.findByText("Passkey renamed.")).toBeInTheDocument();
    expect(await screen.findByText("New name")).toBeInTheDocument();

    const deleteButton = passkeySection.getByRole("button", { name: "Delete New name" });
    await user.click(deleteButton);
    let dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/signs out your other Friday sessions/i);
    const deletePassword = within(dialog).getByLabelText("Current password");
    await waitFor(() => expect(deletePassword).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteButton).toHaveFocus();
    await user.click(deleteButton);
    dialog = screen.getByRole("dialog");
    const reopenedPassword = within(dialog).getByLabelText("Current password");
    const confirm = within(dialog).getByRole("button", { name: "Confirm delete New name" });
    expect(confirm).toBeDisabled();
    await user.type(reopenedPassword, "delete-password");
    await user.click(confirm);

    await waitFor(() => expect(passkeyApi.deletePasskey).toHaveBeenCalledWith("passkey-1", "delete-password"));
    expect(await screen.findByRole("status")).toHaveTextContent("Passkey deleted. Other Friday sessions were signed out.");
    expect(await screen.findByText("No Passkeys added yet.")).toBeInTheDocument();
    expect(passkeyApi.listPasskeys).toHaveBeenCalledTimes(3);
  });

  test("keeps password fallback guidance and safely renders bounded API failures", async () => {
    const user = userEvent.setup();
    passkeyApi.browserSupportsPasskeys.mockReturnValue(false);
    passkeyApi.listPasskeys.mockResolvedValue({ passkeys: [passkey()], canAdd: true });
    passkeyApi.deletePasskey.mockRejectedValue(new Error("Current password is invalid"));
    const queryClient = renderManagement();

    expect(await screen.findByText("Passkeys unavailable in this browser")).toBeInTheDocument();
    expect(screen.getByText(/continue using your password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Passkey" })).toBeDisabled();

    await screen.findByText("Laptop");
    await user.click(screen.getByRole("button", { name: "Delete Laptop" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Current password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Confirm delete Laptop" }));

    expect(await screen.findByText("Unable to update Passkeys")).toBeInTheDocument();
    expect(screen.getByText("Current password is invalid")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Current password")).toHaveValue("");
    const mutations = queryClient.getMutationCache().getAll();
    expect(mutations.every((entry) => entry.state.variables === undefined)).toBe(true);
    expect(JSON.stringify(mutations.map((entry) => entry.state))).not.toContain("wrong-password");
  });
});

function renderManagement(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  render(<QueryClientProvider client={queryClient}><PasskeyManagement /></QueryClientProvider>);
  return queryClient;
}

function passkey(overrides: Partial<AccountPasskey> = {}): AccountPasskey {
  return {
    id: "passkey-1",
    name: "Laptop",
    deviceType: "multiDevice",
    backedUp: false,
    createdAt: "2026-07-31T00:00:00.000Z",
    lastUsedAt: null,
    updatedAt: "2026-07-31T00:00:00.000Z",
    availableOn: ["web"],
    ...overrides
  };
}
