// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebVitalName } from "@frely/observability/contracts";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  pathname: "/owner/teams",
  registrations: new Map<string, Array<(metric: { name: WebVitalName; value: number }) => void>>(),
  runtimes: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    onPathname: ReturnType<typeof vi.fn>;
    reportWebVital: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) => select({ pathname: mocks.pathname }),
}));

vi.mock("@frely/observability/client-runtime", () => ({
  installSurfaceRuntime: () => {
    const value = {
      dispose: vi.fn(),
      onPathname: vi.fn(),
      reportWebVital: vi.fn(),
    };
    mocks.runtimes.push(value);
    return { dispose: value.dispose, runtime: value };
  },
}));

vi.mock("web-vitals", () => {
  const register = (name: WebVitalName) => (callback: (metric: { name: WebVitalName; value: number }) => void) => {
    const callbacks = mocks.registrations.get(name) ?? [];
    callbacks.push(callback);
    mocks.registrations.set(name, callbacks);
  };
  return {
    onCLS: register("CLS"),
    onFCP: register("FCP"),
    onINP: register("INP"),
    onLCP: register("LCP"),
    onTTFB: register("TTFB"),
  };
});

import { AdminUiSurfaceProvider } from "./observability-client";

const routeRegistry = {
  match: (pathname: string) => pathname,
  routes: ["/owner/teams", "/owner/providers", "/owner/users"],
};

function provider(children: ReactNode = "content") {
  return (
    <AdminUiSurfaceProvider release="0.64.1" routeRegistry={routeRegistry}>
      {children}
    </AdminUiSurfaceProvider>
  );
}

function emit(name: WebVitalName, value: number) {
  for (const callback of mocks.registrations.get(name) ?? []) callback({ name, value });
}

afterEach(() => {
  cleanup();
});

describe("Admin document Web Vitals lifecycle", () => {
  test("registers once across route changes and Root remounts while retaining the document initial route", async () => {
    const first = render(provider());
    await waitFor(() => expect(mocks.runtimes).toHaveLength(1));
    for (const name of ["CLS", "FCP", "INP", "LCP", "TTFB"] as const) {
      expect(mocks.registrations.get(name)).toHaveLength(1);
    }

    act(() => emit("LCP", 125));
    expect(mocks.runtimes[0]?.reportWebVital).toHaveBeenLastCalledWith("LCP", 125, "/owner/teams");

    mocks.pathname = "/owner/providers";
    first.rerender(provider());
    await waitFor(() => expect(mocks.runtimes[0]?.onPathname).toHaveBeenLastCalledWith("/owner/providers"));
    act(() => emit("CLS", 0.02));
    expect(mocks.runtimes[0]?.reportWebVital).toHaveBeenLastCalledWith("CLS", 0.02, "/owner/teams");

    first.unmount();
    const reportsBeforeDetachedMetric = mocks.runtimes[0]?.reportWebVital.mock.calls.length;
    act(() => emit("FCP", 80));
    expect(mocks.runtimes[0]?.reportWebVital).toHaveBeenCalledTimes(reportsBeforeDetachedMetric ?? 0);

    mocks.pathname = "/owner/users";
    const second = render(provider());
    await waitFor(() => expect(mocks.runtimes).toHaveLength(2));
    for (const name of ["CLS", "FCP", "INP", "LCP", "TTFB"] as const) {
      expect(mocks.registrations.get(name)).toHaveLength(1);
    }

    act(() => emit("TTFB", 42));
    expect(mocks.runtimes[1]?.reportWebVital).toHaveBeenLastCalledWith("TTFB", 42, "/owner/teams");

    second.unmount();
    const remountedReports = mocks.runtimes[1]?.reportWebVital.mock.calls.length;
    act(() => emit("INP", 75));
    expect(mocks.runtimes[1]?.reportWebVital).toHaveBeenCalledTimes(remountedReports ?? 0);
    expect(mocks.runtimes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.runtimes[1]?.dispose).toHaveBeenCalledTimes(1);
  });
});
