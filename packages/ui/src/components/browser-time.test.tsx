// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { TooltipProvider } from "./tooltip.js";
import { BrowserTime } from "./browser-time.js";

afterEach(cleanup);
beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterAll(() => vi.unstubAllGlobals());

describe("BrowserTime", () => {
  test("renders in the browser time zone and keeps zone details in the tooltip", async () => {
    const actualResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const resolvedOptions = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...actualResolvedOptions.call(this), timeZone: "Asia/Shanghai" };
    });
    const user = userEvent.setup();
    render(<TooltipProvider><BrowserTime value="2026-07-10T06:10:11.000Z" seconds /></TooltipProvider>);

    await waitFor(() => expect(screen.getByText("2026-07-10, 14:10:11")).toBeInTheDocument());
    const time = screen.getByText("2026-07-10, 14:10:11");
    expect(time).toHaveAttribute("datetime", "2026-07-10T06:10:11.000Z");
    expect(time).toHaveClass("whitespace-nowrap");
    expect(time).not.toHaveTextContent("Asia/Shanghai");

    await user.hover(time);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Time zone: Asia/Shanghai (GMT+08:00)");
    resolvedOptions.mockRestore();
  });
});
