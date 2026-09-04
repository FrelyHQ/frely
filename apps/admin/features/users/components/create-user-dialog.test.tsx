// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { CreateUserDialog } from "./create-user-dialog";

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@admin/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../api/user-api", () => ({ createOwnerUser: mocks.createUser }));

beforeEach(() => {
  mocks.createUser.mockReset();
  mocks.refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Create User initial password", () => {
  it("generates a fresh non-empty password in the browser whenever the dialog opens", async () => {
    const user = userEvent.setup();
    let randomValue = 0;
    const getRandomValues = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      randomValue += 1;
      (array as Uint8Array).fill(randomValue);
      return array;
    });
    render(<CreateUserDialog teams={[{ id: "team-a", name: "Team A" }]} />, { wrapper: TestProviders });

    await user.click(screen.getByRole("button", { name: "Create User" }));

    const firstDialog = screen.getByRole("dialog");
    const firstPassword = (within(firstDialog).getByLabelText(/Temporary Password/u) as HTMLInputElement).value;
    expect(firstPassword).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    expect(firstPassword).not.toBe("change-me-123456");

    await user.click(within(firstDialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Create User" }));

    const secondPassword = (within(screen.getByRole("dialog")).getByLabelText(/Temporary Password/u) as HTMLInputElement).value;
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    expect(secondPassword).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    expect(secondPassword).not.toBe(firstPassword);
  });
});

function TestProviders({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
