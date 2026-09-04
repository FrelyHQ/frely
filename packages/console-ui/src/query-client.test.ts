import { describe, expect, test, vi } from "vitest";
import { ConsoleApiError } from "./api-error.js";
import { createConsoleQueryClient } from "./query-client.js";

describe("console query authentication failures", () => {
  test("notifies once when a query returns 401 without retrying", async () => {
    const onUnauthorized = vi.fn();
    const query = vi.fn().mockRejectedValue(unauthorizedError());
    const client = createConsoleQueryClient({ onUnauthorized });

    await expect(client.fetchQuery({ queryKey: ["protected-query"], queryFn: query })).rejects.toMatchObject({ status: 401 });

    expect(query).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test("notifies once when a mutation returns 401", async () => {
    const onUnauthorized = vi.fn();
    const mutationFn = vi.fn().mockRejectedValue(unauthorizedError());
    const client = createConsoleQueryClient({ onUnauthorized });
    const mutation = client.getMutationCache().build(client, { mutationKey: ["protected-mutation"], mutationFn });

    await expect(mutation.execute(undefined)).rejects.toMatchObject({ status: 401 });

    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

function unauthorizedError() {
  return new ConsoleApiError("Bearer token or session cookie is required", { status: 401, code: "unauthorized" });
}
