// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { KeyUsageLookup } from "./key-usage-lookup";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const planOrigin = {
  scopeType: "team" as const,
  scopeLabel: "hsg-backend",
  planName: "HSG-GPT-pro",
  planVersion: 4,
  limitScope: "subscription" as const,
  applicableModels: ["gpt-5.5"],
  subscriptionEffectiveStart: "2026-07-01T00:00:00.000Z",
  subscriptionEffectiveEnd: "2026-08-01T00:00:00.000Z"
};

function renderLookup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<TooltipProvider><QueryClientProvider client={client}><KeyUsageLookup currentUser={null} /></QueryClientProvider></TooltipProvider>);
}

// REQ-MEMBER-008: remaining usage stays grouped by attributed source with fixed reset facts.
describe("KeyUsageLookup", () => {
  test("groups limits by source, preserves small positive amounts, and renders machine-readable reset time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      usage: { totalTokens: 150, calculatedCost: 0.12 },
      apiKey: { prefix: "fr_live_1234567890", status: "enabled", expiresAt: null },
      sources: [
        { source: "plan", limitCount: 1, origin: planOrigin },
        { source: "plan", limitCount: 0, origin: { ...planOrigin, scopeLabel: "Empty Team", planName: "No Limit Plan", planVersion: 1, applicableModels: [], subscriptionEffectiveStart: "2026-07-02T00:00:00.000Z" } }
      ],
      limits: [{
        source: "plan", metric: "amount", limitValue: 30, usedValue: 29.998651, remainingValue: 0.001349, percentUsed: 100,
        windowType: "fixed", windowSeconds: 604800, periodStart: "2026-07-15T00:00:00.000Z", periodEnd: "2026-07-17T14:20:00.000Z", nextResetAt: "2026-07-22T00:00:00.000Z", exhausted: false,
        recovery: { nextRecoveryAt: null, nextRecoveryValue: null, fullRecoveryAt: null },
        origin: planOrigin
      }]
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const user = userEvent.setup();
    renderLookup();
    await user.type(screen.getByPlaceholderText("sk-..."), "sk-test-value");
    await user.click(screen.getByRole("button", { name: "Check Usage" }));

    expect(await screen.findByText("API key all-time usage")).toBeInTheDocument();
    expect([...document.querySelectorAll(".key-usage-summary .metric-label")].map((node) => node.textContent)).toEqual(["Usage sources", "API key all-time usage", "API Key"]);
    expect(screen.getByText("hsg-backend")).toBeInTheDocument();
    expect(screen.getByText("HSG-GPT-pro · v4")).toBeInTheDocument();
    expect(screen.getAllByText(/Models:/)[0]?.parentElement).toHaveTextContent("gpt-5.5");
    expect(screen.getByText("$0.001349")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.getByText(/Team shared \/ Subscription · 7d fixed/)).toBeInTheDocument();
    expect(screen.getByText(/Resets in full at/)).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-07-22T00:00:00.000Z"]')).toBeInTheDocument();
    expect(screen.getByText("No configured limit")).toBeInTheDocument();
    expect(screen.getByText(/No enabled models in this Plan/)).toBeInTheDocument();
  });

  test("distinguishes no active usage source", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ usage: { totalTokens: 0, calculatedCost: 0 }, apiKey: { prefix: "fr_empty", status: "enabled", expiresAt: null }, sources: [], limits: [] }), { status: 200 })));
    const user = userEvent.setup();
    renderLookup();
    await user.type(screen.getByPlaceholderText("sk-..."), "sk-empty");
    await user.click(screen.getByRole("button", { name: "Check Usage" }));
    expect(await screen.findByText("No active usage source")).toBeInTheDocument();
  });
});
