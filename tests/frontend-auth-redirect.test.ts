import { describe, expect, test, vi } from "vitest";
import { completeAdminLogin } from "../apps/admin/pages/owner/_components/owner-login-dialog";
import { safeWebLoginNext, webLoginHref } from "../apps/web/pages/login/login-next";
import { safeNextPath } from "../apps/web/lib/safe-navigation";
import { completeWebLogin } from "../apps/web/pages/login/web-login-form";
import { completeUnauthorizedRecovery, createUnauthorizedRecoveryController } from "../packages/console-ui/src/unauthorized-response";

describe("frontend authentication recovery", () => {
  test("same-user sign-in closes recovery, refreshes server state, and permits a later expiry", () => {
    const activate = vi.fn();
    const deactivate = vi.fn();
    const refresh = vi.fn();
    const hardNavigate = vi.fn();
    const controller = createUnauthorizedRecoveryController(activate);

    controller.onUnauthorized();
    const outcome = completeUnauthorizedRecovery(controller, {
      originalUserId: "user-original",
      authenticatedUserId: "user-original",
      deactivate,
      refresh,
      hardNavigate,
      differentUserHome: "/owner"
    });
    controller.onUnauthorized();

    expect(outcome).toBe("same-user");
    expect(activate).toHaveBeenCalledTimes(2);
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(hardNavigate).not.toHaveBeenCalled();
  });

  test.each([
    ["Admin", "/owner"],
    ["Web", "/user"]
  ])("different-user sign-in starts a fresh %s session at its default home", (_surface, differentUserHome) => {
    const activate = vi.fn();
    const deactivate = vi.fn();
    const refresh = vi.fn();
    const hardNavigate = vi.fn();
    const controller = createUnauthorizedRecoveryController(activate);

    controller.onUnauthorized();
    const outcome = completeUnauthorizedRecovery(controller, {
      originalUserId: "user-original",
      authenticatedUserId: "user-other",
      deactivate,
      refresh,
      hardNavigate,
      differentUserHome
    });

    expect(outcome).toBe("different-user");
    expect(hardNavigate).toHaveBeenCalledWith(differentUserHome);
    expect(deactivate).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledTimes(1);
  });

  test("missing original principal is treated as a fresh login", () => {
    const hardNavigate = vi.fn();
    const controller = createUnauthorizedRecoveryController(vi.fn());

    expect(completeUnauthorizedRecovery(controller, {
      originalUserId: null,
      authenticatedUserId: "user-authenticated",
      deactivate: vi.fn(),
      refresh: vi.fn(),
      hardNavigate,
      differentUserHome: "/user"
    })).toBe("different-user");
    expect(hardNavigate).toHaveBeenCalledWith("/user");
  });

  test("keeps the standalone Admin login refresh behavior", () => {
    const refresh = vi.fn();
    completeAdminLogin(refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("keeps the standalone Web login next navigation behavior", () => {
    const assign = vi.fn();
    completeWebLogin("/user/team/team-1?tab=members#user-2", assign);
    expect(assign).toHaveBeenCalledWith("/user/team/team-1?tab=members#user-2");
  });

  test.each([
    ["default", "https://relay.example.com"],
    ["alias", "https://relay-alt.example.com"]
  ])("keeps the Landing login on the validated %s platform origin", (_kind, publicOrigin) => {
    expect(webLoginHref(publicOrigin)).toBe(`${publicOrigin}/login?next=%2Fuser`);
  });

  test.each([
    [null],
    ["https://attacker.example/user"],
    ["//attacker.example/user"],
    ["/login"],
    ["/login?next=%2Fuser"],
    ["/login/recovery?next=%2Fuser"]
  ])("defaults an unsafe or recursive Web login next target to the User Console", (next) => {
    expect(safeWebLoginNext(next)).toBe("/user");
  });

  test("preserves a safe Web login next target", () => {
    expect(safeWebLoginNext("/user/team/team-1?tab=members#user-2")).toBe("/user/team/team-1?tab=members#user-2");
  });

  test("keeps login navigation same-origin after URL normalization", () => {
    expect(safeNextPath("/user/team/team-1?tab=members#user-2")).toBe("/user/team/team-1?tab=members#user-2");
    for (const target of [null, "https://evil.example", "//evil.example", "/\\evil.example", "/\\/evil.example", "/\t/evil.example"]) {
      expect(safeNextPath(target)).toBe("/user");
      expect(safeWebLoginNext(target)).toBe("/user");
    }
  });
});
