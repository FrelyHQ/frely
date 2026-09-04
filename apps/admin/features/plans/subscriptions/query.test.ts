import { describe, expect, test } from "vitest";
import { parseSubscriptionSearch, SUBSCRIPTIONS_PAGE_SIZE } from "./query";
import { subscriptionsHref } from "./url";

describe("Subscription overview URL state", () => {
  test("defaults missing and invalid lifecycle status to Active", () => {
    expect(parseSubscriptionSearch().status).toBe("active");
    expect(parseSubscriptionSearch({ status: "unknown" }).status).toBe("active");
    expect(SUBSCRIPTIONS_PAGE_SIZE).toBe(20);
  });

  test("keeps explicit all and emits the new plural route", () => {
    const state = parseSubscriptionSearch({ status: "all", page: "2", scopeType: "team" });
    expect(state).toEqual(expect.objectContaining({ status: "all", page: 2, scopeType: "team" }));
    expect(subscriptionsHref(state)).toBe("/owner/plans/subscriptions?scopeType=team&status=all&page=2");
  });
});
