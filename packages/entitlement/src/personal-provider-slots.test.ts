import { describe, expect, test } from "vitest";
import { personalProviderRenewalWindow, personalProviderSlotLifecycle, positiveDurationDays } from "./personal-provider-slots.js";

describe("personal Provider slot lifecycle", () => {
  test("uses a half-open 180-day hot-retention window", () => {
    const latestEffectiveEnd = "2027-01-01T00:00:00.000Z";
    expect(personalProviderSlotLifecycle({ at: "2027-01-01T00:00:00.000Z", latestEffectiveEnd, retentionExpiredAt: null }).lifecycle).toBe("expired_hot");
    expect(personalProviderSlotLifecycle({ at: "2027-06-29T23:59:59.999Z", latestEffectiveEnd, retentionExpiredAt: null }).lifecycle).toBe("expired_hot");
    expect(personalProviderSlotLifecycle({ at: "2027-06-30T00:00:00.000Z", latestEffectiveEnd, retentionExpiredAt: null })).toMatchObject({
      lifecycle: "retention_expired",
      renewalCutoff: "2027-06-30T00:00:00.000Z",
    });
  });

  test("appends early renewal and restarts late renewal without charging the gap", () => {
    expect(personalProviderRenewalWindow({
      latestEffectiveEnd: "2027-01-01T00:00:00.000Z",
      fulfillmentSucceededAt: "2026-12-01T00:00:00.000Z",
      renewalAdmittedAt: "2026-12-01T00:00:00.000Z",
      durationDays: 365,
    })).toMatchObject({ effectiveStart: "2027-01-01T00:00:00.000Z", effectiveEnd: "2028-01-01T00:00:00.000Z" });
    expect(personalProviderRenewalWindow({
      latestEffectiveEnd: "2027-01-01T00:00:00.000Z",
      fulfillmentSucceededAt: "2027-02-01T00:00:00.000Z",
      renewalAdmittedAt: "2027-02-01T00:00:00.000Z",
      durationDays: 365,
    })).toMatchObject({ effectiveStart: "2027-02-01T00:00:00.000Z", effectiveEnd: "2028-02-01T00:00:00.000Z" });
  });

  test("rejects renewal at the exact cutoff and non-integer days", () => {
    expect(() => personalProviderRenewalWindow({
      latestEffectiveEnd: "2027-01-01T00:00:00.000Z",
      fulfillmentSucceededAt: "2027-06-30T00:00:00.000Z",
      renewalAdmittedAt: "2027-06-30T00:00:00.000Z",
      durationDays: 365,
    })).toThrowError(expect.objectContaining({ code: "provider_slot_renewal_window_expired" }));
    expect(() => positiveDurationDays(1.5)).toThrowError(expect.objectContaining({ code: "authority_product_duration_days_invalid" }));
  });
});
