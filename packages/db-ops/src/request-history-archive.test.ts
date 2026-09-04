import { describe, expect, test } from "vitest";
import { planRequestHistoryArchiveMonth, REQUEST_HISTORY_ARCHIVE_DOMAINS } from "./request-history-archive.js";

describe("request history archive control", () => {
  test("keeps the database history cutoff at 180 days and selects the last eligible complete month", () => {
    const plan = planRequestHistoryArchiveMonth("previous", new Date("2026-09-01T00:00:00.000Z"), 180);
    expect(plan.archiveMonth).toBe("2026-02");
    expect(plan.cutoffGte).toBe("2026-02-01T00:00:00.000Z");
    expect(plan.cutoffLt).toBe("2026-03-01T00:00:00.000Z");
    expect(Date.parse(plan.eligibleBefore)).toBe(Date.parse("2026-03-05T00:00:00.000Z"));
  });

  test("rejects a month whose end is still inside the hot window", () => {
    expect(() => planRequestHistoryArchiveMonth("2026-08", new Date("2026-09-01T00:00:00.000Z"), 180)).toThrow("request_history_archive_month_not_eligible");
  });

  test("does not include Capture in the history domain allowlist", () => {
    expect(REQUEST_HISTORY_ARCHIVE_DOMAINS).not.toContain("capture");
    expect(REQUEST_HISTORY_ARCHIVE_DOMAINS).toContain("request-logs");
    expect(REQUEST_HISTORY_ARCHIVE_DOMAINS).toContain("billing-events");
  });
});
