// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { InviteEmailDomainTestControl } from "./team-invite-management";

const mocks = vi.hoisted(() => ({
  testRule: vi.fn(),
}));

vi.mock("@admin/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../api/team-api", () => ({
  addTeamMember: vi.fn(),
  changeTeamOwner: vi.fn(),
  removeTeamMember: vi.fn(),
  createAdminTeamInvite: vi.fn(),
  disableAdminTeamInvite: vi.fn(),
  testInviteEmailDomainRule: mocks.testRule,
  updateAdminTeamInviteSettings: vi.fn(),
}));

beforeEach(() => {
  mocks.testRule.mockReset();
});

afterEach(cleanup);

describe("Invitation email domain rule dialog", () => {
  it("tests the current exact domain rule without changing it", async () => {
    const user = userEvent.setup();
    mocks.testRule.mockResolvedValue({ allowed: true, domain: "allowed.example" });
    render(<InviteEmailDomainTestControl teamId="team-1" pattern="allowed.example" />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Test email domain rule" }));
    fireEvent.change(screen.getByLabelText("Test invitation email"), { target: { value: "Person@ALLOWED.EXAMPLE" } });
    await user.click(screen.getByRole("button", { name: "Test" }));

    expect(mocks.testRule).toHaveBeenCalledWith("team-1", "Person@ALLOWED.EXAMPLE", "allowed.example");
    expect(await screen.findByText("Person@ALLOWED.EXAMPLE is accepted.")).toBeInTheDocument();
  });

  it("shows a rejected test result", async () => {
    const user = userEvent.setup();
    mocks.testRule.mockResolvedValue({ allowed: false, domain: "denied.example" });
    render(<InviteEmailDomainTestControl teamId="team-1" pattern="allowed.example" />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Test email domain rule" }));
    fireEvent.change(screen.getByLabelText("Test invitation email"), { target: { value: "person@denied.example" } });
    await user.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText("person@denied.example is not accepted.")).toBeInTheDocument();
  });
});

function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
