// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ApiKeyLifecycleActions } from "./api-key-lifecycle-actions.js";
import type { ConsoleApiKey } from "./index.js";

const API_KEY: ConsoleApiKey = {
  id: "key_test",
  userId: "usr_test",
  name: "Test key",
  prefix: "fr_test",
  status: "Active",
  scope: "key:key_test",
  planUsage: 0,
  budget: "No limit",
  lastUsed: "Never",
  lastUsedAt: null,
  createdAt: "Today",
  createdAtIso: "2026-07-27T00:00:00.000Z"
};

function rect({ height, left, top, width }: { height: number; left: number; top: number; width: number }): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
afterAll(() => vi.unstubAllGlobals());

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

describe("API key action menu", () => {
  it("portals only Copy and Delete outside a clipping table container", async () => {
    const user = userEvent.setup();
    const runApiKeyAction = vi.fn(async () => undefined);
    const onDeleted = vi.fn();
    render(
      <div className="data-table-scroll-container">
        <ApiKeyLifecycleActions
          apiKey={API_KEY}
          actionPort={{
            runApiKeyAction,
            onDeleted,
          }}
        />
      </div>,
      { wrapper: Providers }
    );

    const trigger = screen.getByRole("button", { name: "API key actions" });
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === trigger) return rect({ height: 32, left: 1360, top: 300, width: 34 });
      if (this.getAttribute("role") === "menu") {
        return this.style.position === "fixed"
          ? rect({ height: 80, left: 0, top: 0, width: 132 })
          : rect({ height: 80, left: 0, top: 0, width: window.innerWidth });
      }
      return rect({ height: 0, left: 0, top: 0, width: 0 });
    });
    await user.click(trigger);

    const menu = screen.getByRole("menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ position: "fixed", visibility: "visible" });
    expect(menu).toHaveStyle({ left: "1262px", top: "338px" });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy", "Delete"]);
    expect(screen.getByRole("menuitem", { name: "Copy" })).toHaveFocus();

    await user.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(runApiKeyAction).toHaveBeenCalledWith({
      apiKeyId: "key_test",
      action: "copy",
    });
    expect(onDeleted).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("API key copied");

    await user.click(trigger);
    expect(screen.getByRole("menu")).toHaveStyle({ left: "1262px", top: "338px" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(runApiKeyAction).toHaveBeenCalledWith({
      apiKeyId: "key_test",
      action: "delete",
    });
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});
