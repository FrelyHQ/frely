import { describe, expect, test } from "vitest";
import { createRouteRegistry, normalizeRelease, parseBrowserMeasurement } from "./contracts.js";

describe("UI Surface contracts", () => {
  const registries = {
    dialogNames: new Set(["team-create"]),
    routeNames: new Set(["/owner/teams", "/owner/teams/[teamId]"]),
  };

  test("matches static and dynamic routes by Next.js priority and fails closed", () => {
    const registry = createRouteRegistry([
      "/owner/teams/[teamId]",
      "/owner/teams",
      "/files/[...parts]",
      "/docs/[[...parts]]",
    ]);
    expect(registry.match("/owner/teams")).toBe("/owner/teams");
    expect(registry.match("/owner/teams/team_123")).toBe("/owner/teams/[teamId]");
    expect(registry.match("/files/a/b")).toBe("/files/[...parts]");
    expect(registry.match("/docs")).toBe("/docs/[[...parts]]");
    expect(registry.match("/unknown/team_123")).toBeNull();
    expect(registry.match("/owner/teams?teamId=secret")).toBeNull();
  });

  test("accepts only allowlisted low-cardinality Surface fields", () => {
    expect(parseBrowserMeasurement({
      kind: "ui_surface",
      durationMs: 3_800,
      result: "success",
      surfaceName: "/owner/teams",
      surfaceType: "page",
    }, registries)).toEqual({
      kind: "ui_surface",
      durationMs: 3_800,
      result: "success",
      surfaceName: "/owner/teams",
      surfaceType: "page",
    });
    expect(parseBrowserMeasurement({
      kind: "ui_surface",
      durationMs: 10,
      result: "success",
      surfaceName: "/owner/teams/team_123",
      surfaceType: "page",
    }, registries)).toBeNull();
    expect(parseBrowserMeasurement({
      kind: "ui_surface",
      durationMs: 10,
      result: "success",
      surfaceName: "team-create",
      surfaceType: "dialog",
      authorization: "secret",
    }, registries)).toBeNull();
    expect(parseBrowserMeasurement({
      kind: "ui_surface",
      durationMs: 120_001,
      result: "success",
      surfaceName: "team-create",
      surfaceType: "dialog",
    }, registries)).toBeNull();
  });

  test("accepts Web Vitals only for generated route templates", () => {
    expect(parseBrowserMeasurement({
      kind: "web_vital",
      name: "LCP",
      routeName: "/owner/teams",
      value: 1_200,
    }, registries)).not.toBeNull();
    expect(parseBrowserMeasurement({
      kind: "web_vital",
      name: "LCP",
      routeName: "/owner/teams/team_123",
      value: 1_200,
    }, registries)).toBeNull();
  });

  test("keeps only bounded non-secret release identifiers", () => {
    expect(normalizeRelease("v0.48.3:abc123")).toBe("v0.48.3:abc123");
    expect(normalizeRelease("release with spaces")).toBe("unknown");
    expect(normalizeRelease("x".repeat(129))).toBe("unknown");
  });
});
