// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import type { ReactElement, ReactNode } from "react";
import { PipelinePluginChips, pipelinePluginTone, type PipelinePluginChipItem } from "./pipeline-plugin-chips.js";

afterEach(cleanup);
beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterAll(() => vi.unstubAllGlobals());

function TestProviders({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

function renderWithProviders(ui: ReactElement) {
  return render(ui, { wrapper: TestProviders });
}

describe("PipelinePluginChips (REQ-GA-007)", () => {
  const plugin: PipelinePluginChipItem = {
    id: "plan-subscription-selection",
    abbreviation: "PSS",
    behaviorVersion: 1,
    hook: "access.candidates",
    outcome: "applied"
  };

  test("maps execution outcomes to semantic chip tones", () => {
    expect(pipelinePluginTone("applied")).toBe("good");
    expect(pipelinePluginTone("fallback")).toBe("warn");
    expect(pipelinePluginTone("failed")).toBe("bad");
    expect(pipelinePluginTone("denied")).toBe("bad");
    expect(pipelinePluginTone("noop")).toBe("neutral");
  });

  test("shows the full plugin identity from the abbreviation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PipelinePluginChips plugins={[plugin]} />);

    const nameTrigger = screen.getByLabelText("Plugin plan-subscription-selection");
    expect(nameTrigger).toHaveTextContent("PSS");
    expect(nameTrigger.parentElement).toHaveAttribute("data-outcome", "applied");
    await user.hover(nameTrigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("plan-subscription-selection");
  });

  test("shows version, hook, and outcome from the version segment", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PipelinePluginChips plugins={[plugin]} />);

    const versionTrigger = screen.getByLabelText("Behavior version 1; hook access.candidates; outcome applied");
    expect(versionTrigger).toHaveTextContent("b1");
    await user.hover(versionTrigger);
    const executionTooltip = await screen.findByRole("tooltip");
    expect(executionTooltip).toHaveTextContent("Behavior version 1");
    expect(executionTooltip).toHaveTextContent("Hook access.candidates");
    expect(executionTooltip).toHaveTextContent("Outcome Applied");
  });

  test("limits the Request History summary to two plugins and opens the complete invocation chain", async () => {
    const user = userEvent.setup();
    const plugins: PipelinePluginChipItem[] = [
      { ...plugin, instanceRevision: "pir_selection" },
      { ...plugin, id: "access-budget-authorization", abbreviation: "ABA", hook: "access.authorize", outcome: "noop", instanceRevision: "pir_budget" },
      { ...plugin, id: "provider-request-dispatch", abbreviation: "PRD", hook: "provider.dispatch", outcome: "fallback", instanceRevision: "pir_dispatch" },
      { ...plugin, id: "usage-ledger-recording", abbreviation: "ULR", hook: "usage.record", outcome: "failed", instanceRevision: "pir_usage" }
    ];
    renderWithProviders(<PipelinePluginChips plugins={plugins} summary />);

    expect(screen.getByRole("button", { name: "View pipeline plugin chain; plugin plan-subscription-selection" })).toHaveTextContent("PSS·b1");
    expect(screen.getByRole("button", { name: "View pipeline plugin chain; plugin access-budget-authorization" })).toHaveTextContent("ABA·b1");
    expect(screen.queryByText("PRD")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View all 4 pipeline plugins" })).toHaveTextContent("+2 more plugins");

    await user.click(screen.getByRole("button", { name: "View all 4 pipeline plugins" }));

    expect(screen.getByRole("heading", { name: "Pipeline Plugin Chain" })).toBeInTheDocument();
    expect(screen.getAllByTestId("pipeline-plugin-chain-name").map((element) => element.textContent)).toEqual([
      "plan-subscription-selection",
      "access-budget-authorization",
      "provider-request-dispatch",
      "usage-ledger-recording"
    ]);
    expect(screen.getByText("pir_dispatch")).toBeInTheDocument();
    expect(screen.getByText("provider.dispatch")).toBeInTheDocument();
    expect(screen.getByText("Fallback")).toBeInTheDocument();
  });
});
