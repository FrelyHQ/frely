// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClarityAnalytics, clarityRelease, claritySurface, isClarityPath } from "./clarity-analytics";
import { resolveClarityProjectId } from "./clarity-runtime-config";

const clarity = vi.hoisted(() => ({
  consent: vi.fn(),
  consentV2: vi.fn(),
  init: vi.fn(),
  setTag: vi.fn()
}));
const navigation = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@microsoft/clarity", () => ({ default: clarity }));
vi.mock("@web/navigation", () => ({ usePathname: () => navigation.pathname }));

afterEach(cleanup);
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  window.localStorage.clear();
  navigation.pathname = "/";
  vi.clearAllMocks();
});

describe("Clarity route policy", () => {
  it("loads the project id only from production deployment configuration", () => {
    expect(resolveClarityProjectId("production", { FRIDAY_RELAY_CLARITY_PROJECT_ID: " clarity-id " })).toBe("clarity-id");
    expect(resolveClarityProjectId("production", {})).toBeNull();
    expect(resolveClarityProjectId("development", { FRIDAY_RELAY_CLARITY_PROJECT_ID: "clarity-id" })).toBeNull();
  });

  it("allows landing, login, register including token URLs, and the complete User Console", () => {
    expect(isClarityPath("/")).toBe(true);
    expect(isClarityPath("/login")).toBe(true);
    expect(isClarityPath("/register")).toBe(true);
    expect(isClarityPath("/user/request-history")).toBe(true);
    expect(isClarityPath("/key")).toBe(false);
    expect(isClarityPath("/api/user/request-logs")).toBe(false);
  });

  it("uses only low-cardinality surface tags", () => {
    expect(claritySurface("/")).toBe("landing");
    expect(claritySurface("/login")).toBe("login");
    expect(claritySurface("/register")).toBe("register");
    expect(claritySurface("/user/team/team_123")).toBe("user-console");
    expect(clarityRelease("c".repeat(40))).toBe("c".repeat(40));
    expect(clarityRelease("user-provided-release-value")).toBe("unknown");
  });
});

describe("Clarity consent", () => {
  it("does not initialize before consent and explicitly denies advertising storage after acceptance", async () => {
    const user = userEvent.setup();
    render(<ClarityAnalytics projectId="xr8geyk4ln" release={"c".repeat(40)} />);

    await screen.findByRole("region", { name: "Analytics preferences" });
    expect(clarity.init).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Accept analytics" }));

    await waitFor(() => expect(clarity.init).toHaveBeenCalledWith("xr8geyk4ln"));
    expect(clarity.consentV2).toHaveBeenCalledWith({ analytics_Storage: "granted", ad_Storage: "denied" });
    expect(clarity.setTag).toHaveBeenCalledWith("release", "c".repeat(40));
    expect(clarity.setTag).toHaveBeenCalledWith("surface", "landing");
    expect(window.localStorage.getItem("friday_clarity_consent_v1")).toBe("granted");
  });

  it("keeps Clarity unloaded after rejection", async () => {
    const user = userEvent.setup();
    render(<ClarityAnalytics projectId="xr8geyk4ln" release="v0.55.0" />);

    await user.click(await screen.findByRole("button", { name: "Reject" }));

    expect(clarity.init).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("friday_clarity_consent_v1")).toBe("denied");
    expect(await screen.findByRole("button", { name: "Analytics settings" })).toBeInTheDocument();
  });

  it("renders nothing and never initializes on excluded paths or outside production", async () => {
    navigation.pathname = "/key";
    const { rerender } = render(<ClarityAnalytics projectId="xr8geyk4ln" release="v0.55.0" />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Analytics preferences" })).not.toBeInTheDocument());
    expect(clarity.init).not.toHaveBeenCalled();

    navigation.pathname = "/";
    rerender(<ClarityAnalytics projectId={null} release="v0.55.0" />);
    expect(screen.queryByRole("region", { name: "Analytics preferences" })).not.toBeInTheDocument();
    expect(clarity.init).not.toHaveBeenCalled();
  });
});
