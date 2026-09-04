import { describe, expect, it } from "vitest";
import { createGatewayRoutingBudget } from "./routing-runtime.js";

describe("createGatewayRoutingBudget", () => {
  it("does not impose an implicit wall-clock deadline", () => {
    const budget = createGatewayRoutingBudget(undefined, { now: () => Number.MAX_SAFE_INTEGER });

    expect(() => budget.checkpoint()).not.toThrow();
  });

  it("still honors an explicitly supplied deadline", () => {
    const budget = createGatewayRoutingBudget(undefined, { deadlineAtMs: 100, now: () => 100 });

    expect(() => budget.checkpoint()).toThrow("Routing graph work exceeded platform capacity");
  });
});
