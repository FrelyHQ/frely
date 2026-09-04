import { describe, expect, test, vi } from "vitest";
import { createUnauthorizedRecoveryController, installSessionExpiryRecovery, wrapFetchWithUnauthorizedHandler } from "./unauthorized-response.js";

describe("frontend API 401 interception", () => {
  test("activates recovery once for concurrent read and write failures", async () => {
    const activate = vi.fn();
    const controller = createUnauthorizedRecoveryController(activate);
    const fetchImplementation = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const interceptedFetch = wrapFetchWithUnauthorizedHandler(fetchImplementation, {
      currentUrl: () => "https://relay.example/user/teams?tab=members#active",
      onUnauthorized: controller.onUnauthorized
    });

    await Promise.all([
      interceptedFetch("/api/user/teams"),
      interceptedFetch("/api/user/teams", { method: "POST" })
    ]);

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  test("does not intercept login or cross-origin responses", async () => {
    const onUnauthorized = vi.fn();
    const fetchImplementation = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const interceptedFetch = wrapFetchWithUnauthorizedHandler(fetchImplementation, {
      currentUrl: () => "https://relay.example/login",
      onUnauthorized
    });

    await interceptedFetch("/api/auth/login", { method: "POST" });
    await interceptedFetch("/api/auth/passkey/options", { method: "POST" });
    await interceptedFetch("/api/auth/passkey/verify", { method: "POST" });
    await interceptedFetch("https://provider.example/api/models");

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  test("can activate again only after successful recovery resets the cycle", () => {
    const activate = vi.fn();
    const controller = createUnauthorizedRecoveryController(activate);

    controller.onUnauthorized();
    controller.onUnauthorized();
    expect(activate).toHaveBeenCalledTimes(1);

    controller.reset();
    controller.onUnauthorized();
    expect(activate).toHaveBeenCalledTimes(2);
  });

  test("activates recovery when the trusted SSR session expires without waiting for an API 401", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    const onUnauthorized = vi.fn();
    const uninstall = installSessionExpiryRecovery(
      Date.parse("2026-07-24T00:00:02.000Z") / 1_000,
      onUnauthorized
    );

    vi.advanceTimersByTime(1_999);
    expect(onUnauthorized).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    uninstall();
    vi.useRealTimers();
  });

  test("cancels an obsolete session expiry when refreshed RSC identity arrives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    const onUnauthorized = vi.fn();
    const uninstall = installSessionExpiryRecovery(
      Date.parse("2026-07-24T00:00:02.000Z") / 1_000,
      onUnauthorized
    );

    uninstall();
    vi.advanceTimersByTime(2_000);
    expect(onUnauthorized).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
