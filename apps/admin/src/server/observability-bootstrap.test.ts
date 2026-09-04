import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerFridayRelayObservability: vi.fn(),
}));

vi.mock("@frely/observability/instrumentation", () => ({
  registerFridayRelayObservability: mocks.registerFridayRelayObservability,
}));

import { registerAdminObservability } from "./observability-bootstrap";

describe("Admin observability bootstrap", () => {
  test("returns one awaitable registration for every caller", async () => {
    const first = registerAdminObservability();
    const second = registerAdminObservability();

    expect(first).toBeInstanceOf(Promise);
    expect(second).toBe(first);
    await first;
    expect(mocks.registerFridayRelayObservability).toHaveBeenCalledTimes(1);
  });
});
