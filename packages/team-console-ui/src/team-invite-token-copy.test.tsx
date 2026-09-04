// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { TeamInviteTokenCopy } from "./team-invite-token-copy";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Team invitation token copy", () => {
  it("copies the full public registration link when the token is clicked", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<TooltipProvider><TeamInviteTokenCopy inviteToken="til_token/value" publicBaseUrl="https://relay.example/base" /></TooltipProvider>);

    await user.click(screen.getByRole("button", { name: "Copy full invitation link for token til_token/value" }));

    expect(writeText).toHaveBeenCalledWith("https://relay.example/register?token=til_token%2Fvalue");
    expect(await screen.findByRole("button", { name: "Invitation link copied for token til_token/value" })).toBeInTheDocument();
  });

  it("shows a failure state when clipboard access is rejected", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<TooltipProvider><TeamInviteTokenCopy inviteToken="til_token" publicBaseUrl="https://relay.example" /></TooltipProvider>);

    await user.click(screen.getByRole("button", { name: "Copy full invitation link for token til_token" }));

    expect(await screen.findByRole("button", { name: "Invitation link copy failed for token til_token" })).toBeInTheDocument();
  });
});
