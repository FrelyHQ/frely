import { errorStatus, RelayError } from "@frely/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ services: vi.fn() }));

vi.mock("../apps/web/lib/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apps/web/lib/server")>()),
  handle: async (_request: Request, action: () => Promise<Response> | Response) => {
    try {
      return await action();
    } catch (error) {
      return Response.json({ error: { code: error instanceof RelayError ? error.code : "internal_error" } }, { status: errorStatus(error) });
    }
  },
  services: mocks.services,
}));

describe("Web access-order API", () => {
  beforeEach(() => mocks.services.mockReset());

  it("keeps complete PUT replacement and returns the paged mode metadata", async () => {
    const fixture = routeFixture();
    const route = await import("../apps/web/pages/api/user/[[...path]]/route");
    const response = await route.PUT(new Request("http://localhost/api/user/access-order/fast", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderedPlanScopeIds: ["order_b", "order_a"] }),
    }), { params: Promise.resolve({ path: ["access-order", "fast"] }) });

    expect(response.status).toBe(200);
    expect(fixture.replace).toHaveBeenCalledWith("user_access_order", "fast", ["order_b", "order_a"]);
    expect(await response.json()).toMatchObject({ mode: "replace", previousOrderId: null, nextOrderId: null });
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "access_order.replace", result: "success" }));
  });

  it("uses PATCH relative placement and preserves the 409 switch signal from PUT", async () => {
    const fixture = routeFixture("relative");
    const route = await import("../apps/web/pages/api/user/[[...path]]/route");
    const patchResponse = await route.PATCH(new Request("http://localhost/api/user/access-order/fast/order_b", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ placement: "before", anchorId: null }),
    }), { params: Promise.resolve({ path: ["access-order", "fast", "order_b"] }) });

    expect(patchResponse.status).toBe(200);
    expect(fixture.move).toHaveBeenCalledWith("user_access_order", "fast", "order_b", "before", null);
    expect(await patchResponse.json()).toMatchObject({ mode: "relative", previousOrderId: "order_previous", nextOrderId: "order_next" });

    fixture.replace.mockImplementationOnce(() => {
      throw new RelayError("access_order_requires_relative_move", "Use relative moves", 409);
    });
    const putResponse = await route.PUT(new Request("http://localhost/api/user/access-order/fast", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderedPlanScopeIds: ["order_a", "order_b"] }),
    }), { params: Promise.resolve({ path: ["access-order", "fast"] }) });
    expect(putResponse.status).toBe(409);
    expect(await putResponse.json()).toEqual({ error: { code: "access_order_requires_relative_move" } });
  });
});

function routeFixture(mode: "replace" | "relative" = "replace") {
  const rows = [
    { id: "order_a", updatedAt: "2026-07-30T00:00:00.000Z" },
    { id: "order_b", updatedAt: "2026-07-30T00:00:00.000Z" },
  ];
  const replace = vi.fn(() => rows);
  const move = vi.fn(() => rows);
  const audit = vi.fn();
  const page = vi.fn(() => ({
    items: [],
    page: 1,
    pageSize: 50,
    total: 2,
    totalPages: 1,
    previousOrderId: mode === "relative" ? "order_previous" : null,
    nextOrderId: mode === "relative" ? "order_next" : null,
    mode,
  }));
  mocks.services.mockResolvedValue({
    asyncTenancy: {
      requireUser: vi.fn(async () => ({ sub: "user_access_order", email: "access-order@example.local", platformRoles: [], teamRoles: [] })),
    },
    application: {
      queries: { pageUserAccessOrder: page },
      commands: {
        replaceUserModelPlanSourceOrder: replace,
        moveUserModelPlanSourceOrder: move,
      },
      audit: { record: audit },
    },
  });
  return { replace, move, audit };
}
