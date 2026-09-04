/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeyActionDialog } from "./api-key-action-dialog.js";
import type { ConsoleUser } from "./index.js";

afterEach(cleanup);

describe("API key create action port", () => {
  it("shows the raw key once and notifies the host only after the user finishes", async () => {
    const user = userEvent.setup();
    const createApiKey = vi.fn(async () => ({ id: "key-created", rawKey: "fr-secret-created-once" }));
    let finishCreated!: () => void;
    const createdFinished = new Promise<void>((resolve) => {
      finishCreated = resolve;
    });
    const onCreated = vi.fn(() => createdFinished);
    const { client } = renderWithQuery(<ApiKeyActionDialog
      user={USER}
      actionPort={{ createApiKey, onCreated }}
    />);

    await user.click(screen.getByRole("button", { name: "Create API Key" }));
    fireEvent.change(screen.getByLabelText("Key Name"), {
      target: { value: "  Work key  " },
    });
    await user.click(screen.getByRole("button", { name: "Create API Key" }));

    expect(createApiKey).toHaveBeenCalledWith({
      userId: "user-1",
      name: "Work key",
      expiresAt: null,
    });
    expect((await screen.findByText("fr-secret-created-once")).getAttribute("data-clarity-mask")).toBe("true");
    expect(screen.getByText(/will not be available after you leave/i)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(client.getMutationCache().getAll()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onCreated).toHaveBeenCalledWith({ id: "key-created", rawKey: "fr-secret-created-once" });
    await waitFor(() => expect(screen.queryByText("fr-secret-created-once")).not.toBeInTheDocument());
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
    expect(screen.getByRole("dialog", { name: "API Key Created" })).toBeInTheDocument();

    finishCreated();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "API Key Created" })).not.toBeInTheDocument());
  });

  it("uses the injected message resolver for host locale copy", () => {
    renderWithQuery(<ApiKeyActionDialog
      user={USER}
      actionPort={{ createApiKey: vi.fn(), onCreated: vi.fn() }}
      messageResolver={(key, context) => key === "api_key.create" ? "创建 API Key" : context.defaultMessage}
    />);

    expect(screen.getByRole("button", { name: "创建 API Key" })).toBeTruthy();
  });

  it("returns focus to the exact trigger after Escape closes the dialog", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ApiKeyActionDialog
      user={USER}
      actionPort={{ createApiKey: vi.fn(), onCreated: vi.fn() }}
    />);

    const trigger = screen.getByRole("button", { name: "Create API Key" });
    await user.click(trigger);

    expect(screen.getByRole("dialog", { name: "Create API Key" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create API Key" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the exact trigger after Cancel and resets form and mutation state when reopened", async () => {
    const user = userEvent.setup();
    const createApiKey = vi.fn(async () => {
      throw new Error("create failed");
    });
    renderWithQuery(<ApiKeyActionDialog
      user={USER}
      actionPort={{ createApiKey, onCreated: vi.fn() }}
    />);

    const trigger = screen.getByRole("button", { name: "Create API Key" });
    await user.click(trigger);
    await user.type(screen.getByLabelText("Key Name"), "stale draft");
    await user.click(screen.getByRole("button", { name: "Create API Key" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create API Key" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(screen.getByLabelText("Key Name")).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

function renderWithQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(<QueryClientProvider client={client}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>),
    client,
  };
}

const USER: ConsoleUser = {
  id: "user-1",
  teamId: "team-1",
  name: "User One",
  email: "user@example.com",
  role: "User",
  status: "Active",
  apiKeyLimit: 5,
  apiKeys: "0",
  lastSeen: "Never",
  lastSeenAt: null,
  createdAt: "2026-07-27",
  createdAtIso: "2026-07-27T00:00:00.000Z",
};
