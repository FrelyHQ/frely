import { afterEach, describe, expect, test, vi } from "vitest";
import { reconcileVisibleProviderBindings } from "./provider-api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Provider binding batch API", () => {
  test("chunks a 200-row directory into requests of at most 50 items", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { items: Array<{ providerId: string }> };
      return new Response(JSON.stringify({ items: body.items.map((item) => ({ providerId: item.providerId, result: "ready" })) }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const items = Array.from({ length: 200 }, (_, index) => ({ providerId: `provider_${index}`, expectedRevision: 1 }));
    const result = await reconcileVisibleProviderBindings(items);
    expect(result.items).toHaveLength(200);
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const call of fetch.mock.calls) {
      const body = JSON.parse(String(call[1]?.body)) as { items: unknown[] };
      expect(body.items.length).toBeLessThanOrEqual(50);
    }
  });
});
