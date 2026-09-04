import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adminPageServices: vi.fn(),
  redirects: vi.fn(),
  routes: new Map<string, { beforeLoad?: () => unknown; component?: unknown; loader?: unknown }>(),
}));

vi.mock("../lib/server", () => ({
  adminPageServices: mocks.adminPageServices,
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({ handler: (handler: unknown) => handler }),
}));

vi.mock("@tanstack/react-router", () => ({
  Outlet: Symbol("Outlet"),
  createFileRoute: (path: string) => (options: { beforeLoad?: () => unknown; component?: unknown; loader?: unknown }) => {
    mocks.routes.set(path, options);
    return options;
  },
  redirect: (options: unknown) => {
    mocks.redirects(options);
    return options;
  },
}));

import { ownerAliasRedirectAuthorized } from "./owner-alias-redirect";
import "./routes/owner.budget-managers";
import "./routes/owner.budget-policies";
import "./routes/owner.plans";
import "./routes/owner.plans.index";
import "./routes/owner.plans.subscriptions";
import "./routes/owner.teams";
import "./routes/owner.teams.$teamId";
import "./routes/owner.users";
import "./routes/owner.users.$userId";

const aliases = [
  ["/owner/budget-managers", "/owner/plans-and-budgets/budget-policies"],
  ["/owner/budget-policies", "/owner/plans-and-budgets/budget-policies"],
  ["/owner/plans/", "/owner/plans-and-budgets/plans"],
] as const;

beforeEach(() => {
  mocks.adminPageServices.mockReset();
  mocks.redirects.mockReset();
});

describe("nested Owner routes and legacy aliases", () => {
  test.each([
    "/owner/teams",
    "/owner/teams/$teamId",
    "/owner/users",
    "/owner/users/$userId",
    "/owner/plans",
    "/owner/plans/subscriptions",
  ])("keeps %s as a loader-free layout", async (path) => {
    const { Outlet } = await import("@tanstack/react-router");
    const route = mocks.routes.get(path);

    expect(route?.component).toBe(Outlet);
    expect(route?.loader).toBeUndefined();
    expect(route?.beforeLoad).toBeUndefined();
  });

  test("reports whether the request passed the current Owner check", async () => {
    mocks.adminPageServices.mockResolvedValueOnce(null).mockResolvedValueOnce({ claims: { sub: "user_owner" } });

    await expect(ownerAliasRedirectAuthorized()).resolves.toBe(false);
    await expect(ownerAliasRedirectAuthorized()).resolves.toBe(true);
  });

  test.each(aliases)("checks Owner authorization before redirecting %s", async (source, target) => {
    const beforeLoad = mocks.routes.get(source)?.beforeLoad;
    if (!beforeLoad) throw new Error(`missing alias route: ${source}`);

    mocks.adminPageServices.mockResolvedValueOnce(null);
    await expect(beforeLoad()).resolves.toBeUndefined();
    expect(mocks.redirects).not.toHaveBeenCalled();

    mocks.adminPageServices.mockResolvedValueOnce({ claims: { sub: "user_owner" } });
    await expect(beforeLoad()).rejects.toEqual({ href: target, statusCode: 307 });
    expect(mocks.redirects).toHaveBeenCalledWith({ href: target, statusCode: 307 });
  });
});
