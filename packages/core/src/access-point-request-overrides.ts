export type AccessPointRequestOverrides = Readonly<Record<string, unknown>>;

export const ACCESS_POINT_REQUEST_OVERRIDES_MAX_BYTES = 8 * 1024;
export const ACCESS_POINT_REQUEST_OVERRIDES_MAX_KEYS = 64;
export const ACCESS_POINT_REQUEST_OVERRIDES_MAX_DEPTH = 8;

const FORBIDDEN_REQUEST_OVERRIDE_KEYS = new Set([
  "agent",
  "apikey",
  "authorization",
  "baseurl",
  "credential",
  "credentialref",
  "credentials",
  "dispatcher",
  "fetch",
  "headers",
  "input",
  "instructions",
  "managementapikey",
  "maxretries",
  "maxretrydelayms",
  "messages",
  "model",
  "onchunk",
  "onerror",
  "onevent",
  "onpayload",
  "onresponse",
  "ontransport",
  "ontransporterror",
  "prompt",
  "providerurl",
  "proxy",
  "proxyurl",
  "signal",
  "store",
  "stream",
  "timeout",
  "timeoutms",
  "tools",
  "transport",
  "websocketconnecttimeoutms",
]);
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function normalizeAccessPointRequestOverrides(input: unknown): AccessPointRequestOverrides {
  if (!isPlainRecord(input)) {
    throw new TypeError("access_point_request_overrides_must_be_object");
  }

  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const state = { keyCount: 0 };
  for (const [key, value] of sortedEntries(input)) {
    state.keyCount += 1;
    if (state.keyCount > ACCESS_POINT_REQUEST_OVERRIDES_MAX_KEYS) {
      throw new TypeError("access_point_request_overrides_too_many_keys");
    }
    if (key.length === 0 || FORBIDDEN_JSON_KEYS.has(key) || forbiddenKey(key)) {
      throw new TypeError(`access_point_request_overrides_forbidden_key:${key}`);
    }
    normalized[key] = normalizeJsonValue(value, 1, state);
  }

  if (Object.prototype.hasOwnProperty.call(normalized, "service_tier")) {
    const serviceTier = normalized.service_tier;
    if (serviceTier !== "fast" && serviceTier !== "priority") {
      throw new TypeError("access_point_request_overrides_invalid_service_tier");
    }
  }

  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, "utf8") > ACCESS_POINT_REQUEST_OVERRIDES_MAX_BYTES) {
    throw new TypeError("access_point_request_overrides_too_large");
  }
  return deepFreeze(normalized) as AccessPointRequestOverrides;
}

export function parseAccessPointRequestOverridesJson(value: string): AccessPointRequestOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("access_point_request_overrides_invalid_json");
  }
  return normalizeAccessPointRequestOverrides(parsed);
}

export function applyAccessPointRequestOverrides(
  payload: Readonly<Record<string, unknown>>,
  overrides: AccessPointRequestOverrides,
): Record<string, unknown> {
  return Object.keys(overrides).length === 0 ? { ...payload } : { ...payload, ...overrides };
}

export function accessPointRequestOverrideKeys(value: AccessPointRequestOverrides): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function normalizeJsonValue(value: unknown, depth: number, state: { keyCount: number }): unknown {
  if (depth > ACCESS_POINT_REQUEST_OVERRIDES_MAX_DEPTH) {
    throw new TypeError("access_point_request_overrides_too_deep");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("access_point_request_overrides_invalid_number");
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => normalizeJsonValue(item, depth + 1, state)));
  }
  if (!isPlainRecord(value)) throw new TypeError("access_point_request_overrides_invalid_value");

  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of sortedEntries(value)) {
    state.keyCount += 1;
    if (state.keyCount > ACCESS_POINT_REQUEST_OVERRIDES_MAX_KEYS) {
      throw new TypeError("access_point_request_overrides_too_many_keys");
    }
    if (FORBIDDEN_JSON_KEYS.has(key)) throw new TypeError(`access_point_request_overrides_forbidden_key:${key}`);
    normalized[key] = normalizeJsonValue(child, depth + 1, state);
  }
  return deepFreeze(normalized);
}

function forbiddenKey(key: string): boolean {
  return FORBIDDEN_REQUEST_OVERRIDE_KEYS.has(key.replace(/[-_]/g, "").toLowerCase());
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze(value);
}

function sortedEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}
