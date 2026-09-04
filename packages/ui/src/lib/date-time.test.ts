import { describe, expect, test } from "vitest";
import { formatTimeZoneOffset, formatUtcDate, formatUtcDateTime, formatZonedDate, formatZonedDateTime } from "./date-time.js";

describe("UTC date formatting", () => {
  test("formats dates and timestamps independently of the local time zone", () => {
    const value = "2026-07-09T23:10:11.000-07:00";
    expect(formatUtcDate(value)).toBe("2026-07-10");
    expect(formatUtcDateTime(value)).toBe("2026-07-10, 06:10");
    expect(formatUtcDateTime(value, { seconds: true })).toBe("2026-07-10, 06:10:11");
  });

  test("formats the same instant in a requested browser time zone", () => {
    const value = "2026-07-10T06:10:11.000Z";
    expect(formatZonedDate(value, "America/Los_Angeles")).toBe("2026-07-09");
    expect(formatZonedDateTime(value, { timeZone: "Asia/Shanghai", seconds: true })).toBe("2026-07-10, 14:10:11");
    expect(formatTimeZoneOffset(value, "Asia/Shanghai")).toBe("GMT+08:00");
  });

  test("preserves invalid values for existing empty-state labels", () => {
    expect(formatUtcDate("Never")).toBe("Never");
    expect(formatUtcDateTime("Restricted")).toBe("Restricted");
  });
});
