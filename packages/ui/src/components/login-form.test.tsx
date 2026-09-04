// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LoginForm } from "./login-form.js";

const { loginMock } = vi.hoisted(() => ({ loginMock: vi.fn() }));

vi.mock("../lib/login-api.js", () => ({ login: loginMock }));

afterEach(() => {
  cleanup();
  loginMock.mockReset();
});

describe("LoginForm authenticated principal handoff", () => {
  test("keeps invalid visible credentials from reaching the login mutation", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <LoginForm onSuccess={vi.fn()} />
      </QueryClientProvider>
    );

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Email is required")).toBeInTheDocument();
    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(loginMock).not.toHaveBeenCalled();
  });

  test("submits browser-autofilled DOM credentials on the first click", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient();
    loginMock.mockResolvedValue({ id: "user-authenticated" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoginForm onSuccess={vi.fn()} />
      </QueryClientProvider>
    );
    const emailInput = screen.getByLabelText("Email");
    const passwordInput = screen.getByLabelText("Password");
    await user.click(passwordInput);
    setAutofilledValue(emailInput, "autofilled@example.com");
    setAutofilledValue(passwordInput, "autofilled-password");

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledTimes(1));
    expect(loginMock.mock.calls[0]?.[0]).toEqual({
      email: "autofilled@example.com",
      password: "autofilled-password"
    });
  });

  test("clears the previous identity cache before handing off the authenticated user id", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient();
    queryClient.setQueryData(["private", "old-user"], { secret: false });
    const onSuccess = vi.fn();
    loginMock.mockResolvedValue({ id: "user-authenticated" });

    render(
      <QueryClientProvider client={queryClient}>
        <LoginForm onSuccess={onSuccess} />
      </QueryClientProvider>
    );
    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ id: "user-authenticated" }));
    expect(queryClient.getQueryData(["private", "old-user"])).toBeUndefined();
  });

  test("keeps a failed password out of TanStack mutation variables", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient();
    loginMock.mockRejectedValue(new Error("Invalid credentials"));
    render(<QueryClientProvider client={queryClient}><LoginForm onSuccess={vi.fn()} /></QueryClientProvider>);

    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "mutation-cache-secret");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid credentials")).toBeInTheDocument();
    const mutations = queryClient.getMutationCache().getAll();
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every((entry) => entry.state.variables === undefined)).toBe(true);
    expect(JSON.stringify(mutations.map((entry) => entry.state))).not.toContain("mutation-cache-secret");
  });
});

function setAutofilledValue(input: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("HTMLInputElement value setter is unavailable");
  setter.call(input, value);
}
