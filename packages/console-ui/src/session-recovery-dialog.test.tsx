// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { SessionRecoverySurface } from "./session-recovery-dialog.js";

const { loginFormProps } = vi.hoisted(() => ({ loginFormProps: vi.fn() }));

vi.mock("@frely/ui/components/login-form", () => ({
  LoginForm: ({ onSuccess }: { onSuccess: (user: { id: string }) => void }) => {
    loginFormProps({});
    return <div>
      <button onClick={() => onSuccess({ id: "user-original" })}>Complete password sign-in</button>
    </div>;
  }
}));
vi.mock("./console-dialog.js", () => ({
  ConsoleDialog: ({ children, title, description }: { children: React.ReactNode; title: React.ReactNode; description: React.ReactNode }) => <div role="dialog" aria-label={String(title)}><p>{description}</p>{children}</div>
}));

afterEach(() => {
  cleanup();
  loginFormProps.mockClear();
});

describe("SessionRecoverySurface", () => {
  test("keeps an unsaved business draft mounted while sign-in is required", async () => {
    const user = userEvent.setup();
    const onRecovered = vi.fn();
    const view = (active: boolean) => (
      <SessionRecoverySurface active={active} onRecovered={onRecovered}>
        <label>Draft reason<input aria-label="Draft reason" /></label>
      </SessionRecoverySurface>
    );
    const rendered = render(view(false));

    await user.type(screen.getByLabelText("Draft reason"), "keep this unsaved value");
    rendered.rerender(view(true));

    expect(screen.getByRole("dialog", { name: "Sign in again" })).toBeInTheDocument();
    expect(screen.getByText(/same account to keep unsaved changes/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Draft reason")).toHaveValue("keep this unsaved value");
    await user.click(screen.getByRole("button", { name: "Complete password sign-in" }));
    expect(onRecovered).toHaveBeenCalledWith({ id: "user-original" });

    rendered.rerender(view(false));
    expect(screen.queryByRole("dialog", { name: "Sign in again" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Draft reason")).toHaveValue("keep this unsaved value");
  });

  test("uses the password sign-in form for session recovery", async () => {
    const onRecovered = vi.fn();
    render(<SessionRecoverySurface active onRecovered={onRecovered}><p>Protected console</p></SessionRecoverySurface>);

    expect(loginFormProps).toHaveBeenLastCalledWith({});
    expect(screen.getByRole("button", { name: "Complete password sign-in" })).toBeInTheDocument();
  });
});
