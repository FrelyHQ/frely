import { describe, expect, test, vi } from "vitest";
import { completeAdminLogin } from "./owner-login-dialog";

describe("completeAdminLogin", () => {
  test("navigates to the Owner Console after a successful login", () => {
    const assign = vi.fn();

    completeAdminLogin(assign);

    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith("/owner");
  });
});
