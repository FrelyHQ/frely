/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { afterEach, describe, expect, test } from "vitest";
import "@testing-library/jest-dom/vitest";
import { PlanBudgetSources, type PlanBudgetSourceDisplay } from "./plan-budget.js";

afterEach(cleanup);

describe("Plan budget source presentation (REQ-GA-007, REQ-TA-005, REQ-MEMBER-005)", () => {
  test("keeps sources and metrics separate while showing freshness and fixed reset", () => {
    render(<TooltipProvider><PlanBudgetSources calculatedAt="2026-07-20T01:00:00.000Z" sources={[source({
      limits: [
        limit({ metric: "amount", limitValue: 0.001, usedValue: 0.000001, remainingValue: 0.000999 }),
        limit({ key: "tokens", metric: "tokens", limitValue: 1_000, usedValue: 200, remainingValue: 800, nextResetAt: "2026-07-20T02:00:00.000Z" })
      ]
    }), source({ key: "second", planName: "Second", scopeLabel: "Personal", limits: [] })]} /></TooltipProvider>);

    expect(screen.getAllByText("Current period ends")).toHaveLength(2);
    expect(screen.getAllByText("Calculated as of")).toHaveLength(2);
    expect(screen.getByText("$0.000001")).toBeInTheDocument();
    expect(screen.getAllByText(/Next /)).toHaveLength(2);
    expect(screen.queryByText("Total remaining")).not.toBeInTheDocument();
  });

  test("does not invent usage or a renewal for a future subscription", () => {
    render(<TooltipProvider><PlanBudgetSources calculatedAt="2026-07-20T01:00:00.000Z" sources={[source({
      effectiveState: "future", usageMode: "not_started", effectiveStart: "2026-07-21T00:00:00.000Z", nextPeriodStart: null,
      limits: [limit({ usedValue: null, remainingValue: null, percentUsed: null, exhausted: null })]
    })]} /></TooltipProvider>);

    expect(screen.getByText("Starts at")).toBeInTheDocument();
    expect(screen.getAllByText("Not started")).toHaveLength(3);
    expect(screen.queryByText(/remaining/i)).toBeTruthy();
    expect(screen.queryByText("No scheduled next period")).not.toBeInTheDocument();
  });

  test("labels ended usage as historical instead of presenting remaining capacity", () => {
    render(<TooltipProvider><PlanBudgetSources calculatedAt="2026-07-20T01:00:00.000Z" sources={[source({ effectiveState: "ended", usageMode: "at_end", nextPeriodStart: null })]} /></TooltipProvider>);

    expect(screen.getByText("Usage at end")).toBeInTheDocument();
    expect(screen.getByText("Historical — not available")).toBeInTheDocument();
    expect(screen.getByText("No scheduled next period")).toBeInTheDocument();
  });

  test("shows an actual persisted next period and explicit empty models and limits", () => {
    render(<TooltipProvider><PlanBudgetSources calculatedAt="2026-07-20T01:00:00.000Z" sources={[source({
      applicableModels: [], limits: [], nextPeriodStart: "2026-07-21T00:00:00.000Z"
    })]} /></TooltipProvider>);

    expect(screen.getByText("Next period starts")).toBeInTheDocument();
    expect(screen.getByText("No exposed models")).toBeInTheDocument();
    expect(screen.getByText("No visible limits for this source.")).toBeInTheDocument();
    expect(screen.queryByText("No scheduled next period")).not.toBeInTheDocument();
  });
});

function source(overrides: Partial<PlanBudgetSourceDisplay> = {}): PlanBudgetSourceDisplay {
  return { key: "source", planName: "Plan", planVersion: 1, billingMode: "prepaid", scopeLabel: "Team", effectiveState: "current", effectiveStart: "2026-07-20T00:00:00.000Z", effectiveEnd: "2026-07-21T00:00:00.000Z", usageMode: "current", usageReferenceAt: "2026-07-20T01:00:00.000Z", applicableModels: ["model-a"], limits: [limit()], nextPeriodStart: null, ...overrides };
}

function limit(overrides: Partial<PlanBudgetSourceDisplay["limits"][number]> = {}): PlanBudgetSourceDisplay["limits"][number] {
  return { key: "amount", limitScope: "subscription", metric: "amount", windowType: "fixed", windowSeconds: 3_600, limitValue: 10, usedValue: 1, remainingValue: 9, percentUsed: 10, exhausted: false, nextResetAt: "2026-07-20T02:00:00.000Z", ...overrides };
}
