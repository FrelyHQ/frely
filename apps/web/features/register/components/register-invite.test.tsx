// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RegisterInvite } from "./register-invite";

const { acceptInviteMock, acceptLandingInviteMock } = vi.hoisted(() => ({
  acceptInviteMock: vi.fn(),
  acceptLandingInviteMock: vi.fn()
}));

vi.mock("../api/register-api", () => ({
  acceptInvite: acceptInviteMock,
  acceptLandingInvite: acceptLandingInviteMock
}));

afterEach(() => {
  cleanup();
  acceptInviteMock.mockReset();
  acceptLandingInviteMock.mockReset();
});

describe("RegisterInvite existing-account acceptance", () => {
  test("requires matching password entries before submitting registration credentials", async () => {
    const user = userEvent.setup();
    renderInvite();

    await user.type(screen.getByLabelText("Email"), "existing@example.local");
    await user.type(screen.getByLabelText("Password", { selector: "#register-password" }), "correct-password");
    await user.type(screen.getByLabelText("Confirm password"), "different-password");

    expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue and join Target Team" })).toBeDisabled();
    expect(acceptInviteMock).not.toHaveBeenCalled();
  });

  test("uses matching credentials and reports that the existing account joined the Team", async () => {
    const user = userEvent.setup();
    acceptInviteMock.mockResolvedValue({
      outcome: "joined",
      accountOutcome: "already_registered"
    });
    renderInvite();

    await user.type(screen.getByLabelText("Email"), "existing@example.local");
    await user.type(screen.getByLabelText("Password", { selector: "#register-password" }), "legacy1");
    await user.type(screen.getByLabelText("Confirm password"), "legacy1");
    await user.click(screen.getByRole("button", { name: "Continue and join Target Team" }));

    await waitFor(() => expect(acceptInviteMock).toHaveBeenCalledWith({
      inviteToken: "invite_target",
      email: "existing@example.local",
      password: "legacy1"
    }));
    expect(screen.getByRole("status")).toHaveTextContent("Your account was already registered, and you joined Target Team.");
    expect(screen.getByRole("status")).toHaveTextContent("We used your existing account; no new account was created.");
  });
});

function renderInvite() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RegisterInvite
        inviteToken="invite_target"
        teamName="Target Team"
        memberInvitesEnabled={false}
        inviteEmailDomainRestricted={false}
        currentUserEmail={null}
      />
    </QueryClientProvider>
  );
}
