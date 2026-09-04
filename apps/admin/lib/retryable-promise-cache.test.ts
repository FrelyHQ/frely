import { describe, expect, test, vi } from "vitest";
import { createRetryablePromiseCache } from "./retryable-promise-cache";

describe("retryable promise cache", () => {
  test("shares in-flight initialization and clears a rejected attempt", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    const first = new Promise<string>((_resolve, reject) => { rejectFirst = reject; });
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce("ready");
    const cache = createRetryablePromiseCache<string>();

    const one = cache.get(factory);
    const two = cache.get(factory);
    expect(two).toBe(one);
    expect(factory).toHaveBeenCalledTimes(1);

    rejectFirst?.(new Error("initialization_failed"));
    await expect(one).rejects.toThrow("initialization_failed");
    await expect(cache.get(factory)).resolves.toBe("ready");
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
