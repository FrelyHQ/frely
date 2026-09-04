import { describe, expect, test } from "vitest";
import {
  getAccessPointSelector,
  normalizeAccessPointSelectorConfig,
  type SelectorAttemptResult,
  type SelectorCandidate,
} from "./access-point-selectors.js";

const candidates: SelectorCandidate[] = [
  { candidateId: "second", targetEdgeId: "edge-2", position: 1, available: true },
  { candidateId: "first", targetEdgeId: "edge-1", position: 0, available: true },
  { candidateId: "third", targetEdgeId: "edge-3", position: 2, available: false },
];

describe("AccessPoint selector registry", () => {
  test("normalizes strict direct and ordered configs", () => {
    expect(normalizeAccessPointSelectorConfig("direct", 1, {}, 1)).toEqual({});
    expect(normalizeAccessPointSelectorConfig("ordered-fallback", 1, {}, 3)).toEqual({
      maxAttempts: 2,
      retryOn: ["connect_error", "timeout", "rate_limited", "upstream_5xx"],
    });
    expect(() => normalizeAccessPointSelectorConfig("direct", 1, { unexpected: true }, 1)).toThrow("unknown_field");
    expect(() => normalizeAccessPointSelectorConfig("ordered-fallback", 1, { maxAttempts: 4 }, 3)).toThrow("max_attempts");
    expect(() => normalizeAccessPointSelectorConfig("ordered-fallback", 1, { retryOn: ["timeout", "timeout"] }, 3)).toThrow("retry_on");
    expect(() => normalizeAccessPointSelectorConfig("ordered-fallback", 1, { retryOn: ["timeout", 503] }, 3)).toThrow("retry_on");
    expect(() => normalizeAccessPointSelectorConfig("unknown", 1, {}, 1)).toThrow("unknown");
  });

  test("selects deterministically and only retries configured pre-output failures", () => {
    const selector = getAccessPointSelector("ordered-fallback", 1);
    const config = normalizeAccessPointSelectorConfig("ordered-fallback", 1, {
      maxAttempts: 2,
      retryOn: ["timeout"],
    }, 3);
    expect(selector.decide(candidates, [], config)).toBe("first");
    expect(selector.decide(candidates, [attempt("first", "timeout")], config)).toBe("second");
    expect(selector.decide(candidates, [attempt("first", "non_retryable")], config)).toBeNull();
    expect(selector.decide(candidates, [{ ...attempt("first", "timeout"), outputCommitted: true }], config)).toBeNull();
    expect(selector.decide(candidates, [attempt("first", "timeout"), attempt("second", "timeout", 1)], config)).toBeNull();
  });
});

function attempt(candidateId: string, failureClass: SelectorAttemptResult["failureClass"], attemptIndex = 0): SelectorAttemptResult {
  return {
    candidateId,
    targetEdgeId: `edge-${candidateId}`,
    attemptIndex,
    outcome: "failed",
    failureClass,
    outputCommitted: false,
    durationMs: 1,
  };
}
