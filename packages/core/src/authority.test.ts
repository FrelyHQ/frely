import {
  AUTHORITY_CANCEL_REASON_CODES,
  AUTHORITY_CAPABILITY_CATALOG,
  AUTHORITY_PRODUCT_LIMITS,
  AUTHORITY_REFUND_REASON_CODES,
  authorityRoleAllows
} from "./index.js";
import { describe, expect, test } from "vitest";

describe("Authority catalog (REQ-NEXT-IDENTITY-002, REQ-MEMBER-020)", () => {
  test("keeps Platform Owner management and commercial Team creation explicit", () => {
    expect(authorityRoleAllows("owner", "platform.owner.manage")).toBe(true);
    expect(authorityRoleAllows("owner", "platform.team.manage:any")).toBe(true);
    expect(authorityRoleAllows("creator", "team.create")).toBe(true);
    expect(authorityRoleAllows("creator", "platform.owner.manage")).toBe(false);
    expect(authorityRoleAllows("owner", "team.create")).toBe(false);
    expect(AUTHORITY_CAPABILITY_CATALOG["team.create"].quotaKind).toBe("units");
  });

  test("owns safety bounds and reason allowlists in code without product prices", () => {
    expect(AUTHORITY_PRODUCT_LIMITS).toEqual({
      maxPurchaseAmountUnits: Number.MAX_SAFE_INTEGER,
      maxGrantUnits: 1_000,
      maxGrantDurationSeconds: 315_360_000,
      maxSettlementHoldSeconds: 31_536_000,
      maxPurchaseOrUnconsumedLimit: 1_000_000,
      maxTeamLimit: 1_000
    });
    expect(AUTHORITY_CANCEL_REASON_CODES).toEqual(["security_response", "fraud", "product_correction", "operator_error", "refund"]);
    expect(AUTHORITY_REFUND_REASON_CODES).toEqual(["customer_request", "duplicate_purchase", "product_correction", "operator_error"]);
    expect(Object.keys(AUTHORITY_PRODUCT_LIMITS)).not.toContain("price");
  });
});
