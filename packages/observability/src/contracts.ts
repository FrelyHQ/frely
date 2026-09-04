export const UI_SURFACE_RESULTS = ["success", "failed", "cancelled", "timeout"] as const;
export const UI_SURFACE_TYPES = ["page", "dialog"] as const;
export const WEB_VITAL_NAMES = ["CLS", "FCP", "INP", "LCP", "TTFB"] as const;

export type UiSurfaceResult = (typeof UI_SURFACE_RESULTS)[number];
export type UiSurfaceType = (typeof UI_SURFACE_TYPES)[number];
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];

export interface UiSurfaceMeasurement {
  kind: "ui_surface";
  durationMs: number;
  result: UiSurfaceResult;
  surfaceName: string;
  surfaceType: UiSurfaceType;
}

export interface WebVitalMeasurement {
  kind: "web_vital";
  name: WebVitalName;
  routeName: string;
  value: number;
}

export type BrowserMeasurement = UiSurfaceMeasurement | WebVitalMeasurement;

export interface RouteRegistry {
  match(pathname: string): string | null;
  routes: readonly string[];
}

const ROUTE_NAME = /^\/(?:[a-z0-9._~!$&'()*+,;=:@%/-]|\[(?:\.\.\.)?[A-Za-z0-9_]+\])*$/;
const DIALOG_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export function normalizeRelease(value: string | undefined): string {
  const candidate = value?.trim();
  return candidate && RELEASE_NAME.test(candidate) ? candidate : "unknown";
}

export function isSurfaceName(type: UiSurfaceType, value: unknown): value is string {
  if (typeof value !== "string" || value.length > 160) return false;
  return type === "page" ? ROUTE_NAME.test(value) : DIALOG_NAME.test(value);
}

export function createRouteRegistry(input: readonly string[]): RouteRegistry {
  const routes = [...new Set(input)].sort(compareRoutePriority);
  const compiled = routes.map((route) => ({ route, pattern: compileRoutePattern(route) }));
  return {
    routes,
    match(pathname: string): string | null {
      if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#")) return null;
      return compiled.find(({ pattern }) => pattern.test(pathname))?.route ?? null;
    },
  };
}

export function parseBrowserMeasurement(
  value: unknown,
  registries: { dialogNames: ReadonlySet<string>; routeNames: ReadonlySet<string> },
): BrowserMeasurement | null {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "ui_surface") {
    if (!hasExactKeys(value, ["durationMs", "kind", "result", "surfaceName", "surfaceType"])) return null;
    if (!UI_SURFACE_TYPES.includes(value.surfaceType as UiSurfaceType)) return null;
    const surfaceType = value.surfaceType as UiSurfaceType;
    if (!UI_SURFACE_RESULTS.includes(value.result as UiSurfaceResult)) return null;
    if (!isBoundedNumber(value.durationMs, 0, 120_000)) return null;
    if (!isSurfaceName(surfaceType, value.surfaceName)) return null;
    const names = surfaceType === "page" ? registries.routeNames : registries.dialogNames;
    if (!names.has(value.surfaceName)) return null;
    return {
      kind: "ui_surface",
      durationMs: value.durationMs,
      result: value.result as UiSurfaceResult,
      surfaceName: value.surfaceName,
      surfaceType,
    };
  }
  if (value.kind === "web_vital") {
    if (!hasExactKeys(value, ["kind", "name", "routeName", "value"])) return null;
    if (!WEB_VITAL_NAMES.includes(value.name as WebVitalName)) return null;
    if (!isBoundedNumber(value.value, 0, 600_000)) return null;
    if (typeof value.routeName !== "string" || !registries.routeNames.has(value.routeName)) return null;
    return {
      kind: "web_vital",
      name: value.name as WebVitalName,
      routeName: value.routeName,
      value: value.value,
    };
  }
  return null;
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareRoutePriority(left: string, right: string): number {
  const rank = (route: string) => route.split("/").reduce((score, segment) => {
    if (!segment) return score;
    if (segment.startsWith("[[...")) return score + 1;
    if (segment.startsWith("[...")) return score + 2;
    if (segment.startsWith("[")) return score + 3;
    return score + 4;
  }, 0);
  return rank(right) - rank(left) || right.length - left.length || left.localeCompare(right);
}

function compileRoutePattern(route: string): RegExp {
  if (route === "/") return /^\/$/;
  const segments = route.slice(1).split("/");
  let source = "^";
  for (const segment of segments) {
    if (/^\[\[\.\.\.[A-Za-z0-9_]+\]\]$/.test(segment)) {
      source += "(?:/.*)?";
    } else if (/^\[\.\.\.[A-Za-z0-9_]+\]$/.test(segment)) {
      source += "/.+";
    } else if (/^\[[A-Za-z0-9_]+\]$/.test(segment)) {
      source += "/[^/]+";
    } else {
      source += `/${escapeRegExp(segment)}`;
    }
  }
  return new RegExp(`${source}/?$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
