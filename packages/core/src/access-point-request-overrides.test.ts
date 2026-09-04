import { describe, expect, test } from "vitest";
import {
  applyAccessPointRequestOverrides,
  normalizeAccessPointRequestOverrides,
} from "./access-point-request-overrides.js";

describe("AccessPoint request overrides", () => {
  test("normalizes fixed inference parameters and gives AccessPoint values precedence", () => {
    const overrides = normalizeAccessPointRequestOverrides({
      service_tier: "fast",
      reasoning: { effort: "high" },
    });

    expect(applyAccessPointRequestOverrides({
      service_tier: "default",
      reasoning: { effort: "low" },
      input: "hello",
    }, overrides)).toEqual({
      service_tier: "fast",
      reasoning: { effort: "high" },
      input: "hello",
    });
  });

  test.each(["model", "input", "messages", "tools", "headers", "api_key", "transport", "stream", "store"])(
    "rejects server-owned, content, credential, or transport field %s",
    (key) => expect(() => normalizeAccessPointRequestOverrides({ [key]: true })).toThrow("forbidden_key"),
  );

  test("accepts only Fast-compatible service tier values", () => {
    expect(() => normalizeAccessPointRequestOverrides({ service_tier: "default" })).toThrow("invalid_service_tier");
  });
});
