// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { PlanTokenLimitPreview } from "./plan-token-limit-preview";

afterEach(cleanup);

describe("PlanTokenLimitPreview (REQ-GA-005)", () => {
  it("renders semantic groups, scope explanations, and the combined constraint", () => {
    render(<PlanTokenLimitPreview preview={{
      userLimits: [{ sourceIndex: 0, windowType: "fixed", label: "100,000 tokens / fixed 24 hours" }],
      subscriptionLimits: [{ sourceIndex: 0, windowType: "cumulative", label: "1,000,000 tokens / Plan lifecycle" }],
      incompleteRuleIndexes: []
    }} />);

    expect(screen.getByRole("region", { name: "Configured token limits" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Each user · User limits" })).getByRole("list")).toHaveTextContent("100,000 tokens / fixed 24 hours");
    expect(within(screen.getByRole("region", { name: "Entire team · Subscription limits" })).getByText(/Team scope/u)).toBeInTheDocument();
    expect(screen.getByText(/Both limits apply/u)).toBeInTheDocument();
  });

  it("keeps both empty states visible and explains incomplete limits", () => {
    render(<PlanTokenLimitPreview preview={{ userLimits: [], subscriptionLimits: [], incompleteRuleIndexes: [1] }} />);

    expect(screen.getByText("No per-user token limit configured.")).toBeInTheDocument();
    expect(screen.getByText("No shared Subscription token limit configured.")).toBeInTheDocument();
    expect(screen.getByText("Limit 2: Complete this token limit to preview it.")).toBeInTheDocument();
    expect(screen.queryByText(/Both limits apply/u)).not.toBeInTheDocument();
  });
});
