import { describe, expect, test } from "vitest";
import { parseCreditHistoryUrlState, userCreditsHref } from "./credit-history-url";

describe("User Credit history URL state", () => {
  test("uses only the first bounded opaque cursor", () => {
    const state = parseCreditHistoryUrlState({
      topupCursor: ["topup", "ignored"],
      ledgerCursor: "l".repeat(1200),
    });
    expect(state.topupCursor).toBe("topup");
    expect(state.ledgerCursor).toHaveLength(1000);
    expect(state.catalogPage).toBe(1);
  });

  test("preserves independent Topup and Ledger cursor positions", () => {
    expect(userCreditsHref({ topupCursor: "topup", topupPageSize: 20, ledgerCursor: "ledger", ledgerPageSize: 20, catalogPage: 2, catalogPageSize: 20 }))
      .toBe("/user/credits?topupCursor=topup&ledgerCursor=ledger&catalogPage=2");
  });
});
