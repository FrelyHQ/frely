import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@frely/ui/components/tooltip";
import { ConsoleAuthShell, ConsoleHeader, ConsoleShell, MetricCard, consoleNavLabel, SidebarMenuButton, type ConsoleNavItem } from "./index.js";
import { RequestLogFilters } from "./request-log-filters.js";

describe("shared console experience", () => {
  it("shows real page context without placeholder global controls", () => {
    const markup = renderToStaticMarkup(<ConsoleHeader context="Request Logs" environment="staging" />);
    expect(markup).toContain("Request Logs");
    expect(markup).toContain("Environment: staging");
    expect(markup).not.toContain("Search ID");
    expect(markup).not.toContain("Notifications");
    expect(markup).not.toContain("aria-label=\"Help\"");
  });

  it("selects the most specific task navigation label", () => {
    const navItems: ConsoleNavItem[] = [
      { label: "Overview", children: [{ label: "Dashboard", href: "/user" }] },
      { label: "Usage & Billing", children: [{ label: "Request History", href: "/user/request-history" }] }
    ];
    expect(consoleNavLabel(navItems, "/user")).toBe("Dashboard");
    expect(consoleNavLabel(navItems, "/user/request-history/req_1")).toBe("Request History");
    const markup = renderToStaticMarkup(
      <SidebarMenuButton href="/user/request-history" label="Request History">
        <span aria-hidden="true">icon</span>
        <span className="sidebar-text">Request History</span>
      </SidebarMenuButton>
    );
    expect(markup).toContain('aria-label="Request History"');
    expect(markup).not.toContain('data-slot="tooltip"');
    expect(markup).not.toContain("title=");
  });

  it("uses one branded authentication surface for both console contexts", () => {
    const markup = renderToStaticMarkup(<ConsoleAuthShell context="Admin Console" environment="dev"><span>Form</span></ConsoleAuthShell>);
    expect(markup).toContain("Frely");
    expect(markup).toContain("Admin Console");
    expect(markup).toContain("Environment: dev");
  });

  it("masks profile and metric values without masking navigation or labels", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ConsoleShell
            brandTitle="Frely"
            brandSubtitle="User Console"
            navItems={[{ label: "Overview", children: [{ label: "Dashboard", href: "/user" }] }]}
            currentPath="/user"
            profileLabel="person@example.com"
            profileSubtext="Sensitive workspace"
          >
            <MetricCard label="Credit Balance" value="$12.34" detail="Available balance" maskValue />
          </ConsoleShell>
        </TooltipProvider>
      </QueryClientProvider>
    );

    expect(markup).toContain('class="sidebar-profile" data-clarity-mask="true"');
    expect(markup).toContain('<span class="sidebar-text">Dashboard</span>');
    expect(markup).toContain('<div class="metric-label">Credit Balance</div>');
    expect(markup).toContain('<div class="metric-value" data-clarity-mask="true">$12.34</div>');
    expect(markup).toContain('<div class="metric-detail ">Available balance</div>');
  });

  it("separates common and additional log filters and exposes removable chips", () => {
    const markup = renderToStaticMarkup(
      <RequestLogFilters action="/logs" resetHref="/logs" status="failed" model="gpt-5" start="" timeWindow="7d" downloadHref="/download" canBatchDownload />
    );
    expect(markup).toContain("Common filters");
    expect(markup).toContain("More filters");
    expect(markup).toContain("Applied filters");
    expect(markup).toContain("Status: failed");
    expect(markup).toContain("Model: gpt-5");
    expect(markup).toContain("Window: 7d");
  });
});
