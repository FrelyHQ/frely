// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { AccessPointDescription } from "./access-point-description.js";

afterEach(cleanup);

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

describe("AccessPointDescription", () => {
  it("renders an empty marker without creating a tooltip", () => {
    render(<TooltipProvider><AccessPointDescription description={null} /></TooltipProvider>);

    expect(screen.getByText("—")).toHaveClass("access-point-description-empty");
    expect(document.querySelector('[data-slot="tooltip"]')).toBeNull();
  });

  it("supports keyboard focus and preserves newlines in the tooltip", async () => {
    render(<TooltipProvider><AccessPointDescription description={"First line\nSecond line"} /></TooltipProvider>);

    const trigger = document.querySelector('[data-slot="tooltip-trigger"]') as HTMLElement;
    expect(trigger.textContent).toBe("First line\nSecond line");
    expect(trigger).toHaveAttribute("tabindex", "0");
    fireEvent.focus(trigger);

    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("First line\nSecond line"));
  });
});
