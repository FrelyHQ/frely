// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PasswordChangeForm, type PasswordChangeActionPort } from "./password-change";
import { createConsoleQueryClient } from "./query-client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PasswordChangeForm", () => {
  test("owns accessible password fields, browser autocomplete, visibility, policy, and confirmation validation", async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    renderForm({ changePassword: action });
    const current = screen.getByLabelText("Current password") as HTMLInputElement;
    const next = screen.getByLabelText("New password") as HTMLInputElement;
    const confirm = screen.getByLabelText("Confirm new password") as HTMLInputElement;

    expect(current).toHaveAttribute("autocomplete", "current-password");
    expect(next).toHaveAttribute("autocomplete", "new-password");
    expect(confirm).toHaveAttribute("autocomplete", "new-password");
    expect(current).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show current password" }));
    expect(current).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide current password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show new password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show confirm new password" })).toBeInTheDocument();

    await user.type(current, "current-password");
    await user.type(next, "short");
    await user.type(confirm, "different");
    expect(screen.getByText("Password must contain at least 12 characters")).toBeInTheDocument();
    expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
    expect(action).not.toHaveBeenCalled();
  });

  test("clears the current password, retains correctable new values, and focuses the failed field", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValue(Object.assign(new Error("invalid"), {
      status: 400,
      code: "current_password_invalid"
    }));
    renderForm({ changePassword: action });
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Change password" }));

    await screen.findByRole("alert");
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("valid-new-password");
    expect(screen.getByLabelText("Confirm new password")).toHaveValue("valid-new-password");
    expect(screen.getByLabelText("Current password")).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("The current password is incorrect.");
  });

  test("retains new values on rate limiting and displays Retry-After", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValue(Object.assign(new Error("limited"), {
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 37
    }));
    renderForm({ changePassword: action });
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in 37 seconds.");
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("valid-new-password");
    expect(screen.getByLabelText("Confirm new password")).toHaveValue("valid-new-password");
  });

  test("clears all fields on 401 without replaying the mutation", async () => {
    const user = userEvent.setup();
    const onUnauthorized = vi.fn();
    const action = vi.fn().mockRejectedValue(Object.assign(new Error("expired"), {
      status: 401,
      code: "unauthorized"
    }));
    renderForm({ changePassword: action }, onUnauthorized);
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your session expired.");
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("");
    expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
    expect(action).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test("retains correctable new values and focuses the new password for an unchanged-password failure", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValue(Object.assign(new Error("unchanged"), {
      status: 400,
      code: "password_unchanged"
    }));
    renderForm({ changePassword: action });
    await user.type(screen.getByLabelText("Current password"), "valid-new-password");
    await user.type(screen.getByLabelText("New password"), "valid-new-password");
    await user.type(screen.getByLabelText("Confirm new password"), "valid-new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("differs from the current password");
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("valid-new-password");
    expect(screen.getByLabelText("Confirm new password")).toHaveValue("valid-new-password");
    expect(screen.getByLabelText("New password")).toHaveFocus();
  });

  test("clears all password values for an unknown internal error", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValue(Object.assign(new Error("internal"), {
      status: 500,
      code: "internal_error"
    }));
    renderForm({ changePassword: action });
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Password change failed");
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("");
    expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
  });

  test("prevents duplicate submission and clears all fields on success", async () => {
    const user = userEvent.setup();
    let resolve!: (value: { changed: true; otherSessionsRevoked: true }) => void;
    const action = vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }));
    renderForm({ changePassword: action });
    await fillValidForm(user);
    const submit = screen.getByRole("button", { name: "Change password" });
    await user.click(submit);
    expect(screen.getByRole("button", { name: "Changing password..." })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Changing password..." }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith({
      currentPassword: "current-password",
      newPassword: "valid-new-password"
    });

    resolve({ changed: true, otherSessionsRevoked: true });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Other Friday sessions have been signed out."));
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("");
    expect(screen.getByLabelText("Confirm new password")).toHaveValue("");
  });
});

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Current password"), "current-password");
  await user.type(screen.getByLabelText("New password"), "valid-new-password");
  await user.type(screen.getByLabelText("Confirm new password"), "valid-new-password");
}

function renderForm(actionPort: PasswordChangeActionPort, onUnauthorized?: () => void) {
  const queryClient = onUnauthorized
    ? createConsoleQueryClient({ onUnauthorized })
    : new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false }
      }
    });
  return render(
    <QueryClientProvider client={queryClient}>
      <PasswordChangeForm actionPort={actionPort} />
    </QueryClientProvider>
  );
}
