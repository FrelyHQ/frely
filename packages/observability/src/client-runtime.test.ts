// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRouteRegistry } from "./contracts.js";
import { installSurfaceRuntime, isDialogContentReady } from "./client-runtime.js";

describe("automatic UI Surface lifecycle", () => {
  const beacon = vi.fn(() => true);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(null, { status: 202 }));

  beforeEach(() => {
    document.body.innerHTML = "";
    sessionStorage.clear();
    beacon.mockClear();
    fetchMock.mockClear();
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: fetchMock });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("does not create an event for an ordinary button that opens no Surface", () => {
    vi.useFakeTimers();
    const installed = install();
    const button = document.createElement("button");
    document.body.append(button);
    button.click();
    vi.advanceTimersByTime(30_000);
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    installed.dispose();
  });

  test("closes a Dialog measurement at most once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const installed = install();
    const trigger = document.createElement("button");
    trigger.dataset.uiDialogTrigger = "true";
    document.body.append(trigger);
    trigger.click();
    vi.advanceTimersByTime(180);
    installed.runtime.openDialog("team-create");
    installed.runtime.dialogReady("team-create");
    installed.runtime.dialogReady("team-create");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/telemetry/browser");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("traceparent"))
      .toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    installed.dispose();
  });

  test("completes a Page after the generated route and shared ready content are visible", () => {
    vi.useFakeTimers();
    const installed = install();
    const anchor = document.createElement("a");
    anchor.href = "/owner/teams";
    anchor.textContent = "Teams";
    anchor.addEventListener("click", (event) => event.preventDefault());
    const ready = document.createElement("main");
    ready.dataset.uiPageSurfaceReady = "true";
    ready.dataset.uiPageSurfacePathname = "/owner/teams";
    document.body.append(anchor, ready);
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    anchor.remove();
    installed.runtime.onPathname("/owner/teams");
    vi.advanceTimersByTime(50);
    expect(surfacePayloads()).toContainEqual(expect.objectContaining({
      result: "success",
      surfaceName: "/owner/teams",
      surfaceType: "page",
    }));
    installed.dispose();
  });

  test("reports failed, cancelled by supersession, and timeout terminals", () => {
    vi.useFakeTimers();
    const installed = install();
    const trigger = document.createElement("button");
    trigger.dataset.uiDialogTrigger = "true";
    document.body.append(trigger);

    trigger.click();
    installed.runtime.openDialog("team-create");
    window.dispatchEvent(new ErrorEvent("error"));

    trigger.click();
    installed.runtime.openDialog("team-create");
    trigger.click();

    installed.runtime.openDialog("team-create");
    vi.advanceTimersByTime(30_000);

    expect(surfacePayloads().map((payload) => payload.result)).toEqual([
      "failed",
      "cancelled",
      "timeout",
    ]);
    installed.dispose();
  });

  test("ignores download, non-self target, external, and unregistered Page links", async () => {
    const installed = install();
    const links = [
      { href: "/owner/teams", download: "teams.json" },
      { href: "/owner/teams", target: "_blank" },
      { href: "https://external.example.test/owner/teams" },
      { href: "/owner/unregistered" },
    ];

    for (const attributes of links) {
      const anchor = document.createElement("a");
      Object.assign(anchor, attributes);
      anchor.addEventListener("click", (event) => event.preventDefault());
      document.body.append(anchor);
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
      anchor.remove();
    }

    expect(sessionStorage.getItem("friday.ui-surface.page-candidate.v1")).toBeNull();
    await window.fetch("/_next/data");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).has("traceparent")).toBe(false);
    installed.dispose();
  });

  test("propagates W3C trace context only to same-origin requests", async () => {
    const installed = install();
    const anchor = document.createElement("a");
    anchor.href = "/owner/teams";
    anchor.addEventListener("click", (event) => event.preventDefault());
    document.body.append(anchor);
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    anchor.remove();

    await window.fetch("/_next/data");
    await window.fetch("https://external.example.test/data");

    const sameOriginHeaders = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(sameOriginHeaders.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    const externalHeaders = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers);
    expect(externalHeaders.has("traceparent")).toBe(false);
    installed.dispose();
  });

  test("rejects and removes an expired redirect candidate", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:01:00.000Z"));
    sessionStorage.setItem("friday.ui-surface.page-candidate.v1", JSON.stringify({
      kind: "page",
      release: "release-test",
      startedAtEpochMs: Date.now() - 60_000,
      expiresAtEpochMs: Date.now() - 30_000,
    }));
    const installed = install();
    installed.runtime.onPathname("/owner/teams");
    expect(sessionStorage.getItem("friday.ui-surface.page-candidate.v1")).toBeNull();
    expect(beacon).not.toHaveBeenCalled();
    installed.dispose();
  });

  test("restores a full-document Page candidate without persisting destination identity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:01:00.000Z"));
    sessionStorage.setItem("friday.ui-surface.page-candidate.v1", JSON.stringify({
      kind: "page",
      release: "release-test",
      startedAtEpochMs: Date.now() - 800,
      expiresAtEpochMs: Date.now() + 29_200,
    }));
    const ready = document.createElement("main");
    ready.dataset.uiPageSurfaceReady = "true";
    ready.dataset.uiPageSurfacePathname = "/owner/teams";
    document.body.append(ready);

    const installed = install();
    installed.runtime.onPathname("/owner/teams");
    vi.advanceTimersByTime(50);

    expect(surfacePayloads()).toContainEqual(expect.objectContaining({
      result: "success",
      surfaceName: "/owner/teams",
      surfaceType: "page",
    }));
    expect(sessionStorage.getItem("friday.ui-surface.page-candidate.v1")).toBeNull();
    installed.dispose();
  });

  test("preserves a Button candidate only when the document actually exits", () => {
    vi.useFakeTimers();
    const installed = install();
    const button = document.createElement("button");
    document.body.append(button);
    button.click();
    expect(sessionStorage.getItem("friday.ui-surface.page-candidate.v1")).toBeNull();

    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(JSON.parse(sessionStorage.getItem("friday.ui-surface.page-candidate.v1") ?? "{}"))
      .toEqual(expect.objectContaining({ kind: "page", release: "release-test" }));
    installed.dispose();
    expect(sessionStorage.getItem("friday.ui-surface.page-candidate.v1")).not.toBeNull();
  });

  test("does not turn a full-document Link exit into a cancelled Surface", () => {
    vi.useFakeTimers();
    const installed = install();
    const anchor = document.createElement("a");
    anchor.href = "/owner/teams";
    anchor.addEventListener("click", (event) => event.preventDefault());
    document.body.append(anchor);
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));

    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    installed.dispose();

    expect(sessionStorage.getItem("friday.ui-surface.page-candidate.v1")).not.toBeNull();
    expect(surfacePayloads()).toEqual([]);
  });

  test("requires Dialog async content to be settled and actionable", () => {
    const content = document.createElement("section");
    const pending = document.createElement("div");
    pending.dataset.uiSurfacePending = "true";
    const action = document.createElement("button");
    action.disabled = true;
    content.append(pending, action);
    document.body.append(content);

    expect(isDialogContentReady(content)).toBe(false);
    pending.remove();
    expect(isDialogContentReady(content)).toBe(false);
    action.disabled = false;
    expect(isDialogContentReady(content)).toBe(true);
  });

  function surfacePayloads(): Array<{ result: string; surfaceName: string; surfaceType: string }> {
    return fetchMock.mock.calls
      .map(([, init]) => init?.body)
      .filter((body): body is string => typeof body === "string")
      .map((body) => JSON.parse(body) as { kind: string; result: string; surfaceName: string; surfaceType: string })
      .filter((payload) => payload.kind === "ui_surface");
  }
});

function install() {
  return installSurfaceRuntime({
    release: "release-test",
    routes: createRouteRegistry(["/owner/teams"]),
  });
}
