import { afterEach, describe, expect, test, vi } from "vitest";
import { login } from "./login-api.js";

afterEach(() => vi.unstubAllGlobals());

describe("login authenticated principal", () => {
  test("returns only the stable authenticated user id from the trusted response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      user: { id: "user-authenticated", email: "changed@example.com", displayName: "Ignored" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(login({ email: "login-input@example.com", password: "secret" })).resolves.toEqual({ id: "user-authenticated" });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ method: "POST" }));
  });

  test("rejects a successful response without an authenticated user id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ user: { email: "user@example.com" } })));

    await expect(login({ email: "user@example.com", password: "secret" })).rejects.toThrow("Invalid sign-in response");
  });
});
