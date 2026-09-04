import { describe, expect, test } from "vitest";
import { assertRequestExecutionLeaseFreshForDispatch } from "./domain.js";

describe("Request Execution dispatch lease", () => {
  test("accepts only a lease that remains fresh at the synchronous Provider dispatch boundary", () => {
    const checkedAt = Date.parse("2026-08-29T00:00:00.000Z");
    expect(() => assertRequestExecutionLeaseFreshForDispatch("2026-08-29T00:00:00.001Z", checkedAt)).not.toThrow();
    expect(() => assertRequestExecutionLeaseFreshForDispatch("2026-08-29T00:00:00.000Z", checkedAt)).toThrowError("Request execution lease expired before Provider dispatch");
    expect(() => assertRequestExecutionLeaseFreshForDispatch("2026-08-28T23:59:59.999Z", checkedAt)).toThrowError("Request execution lease expired before Provider dispatch");
  });
});
