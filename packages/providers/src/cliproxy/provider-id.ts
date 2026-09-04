const CLIPROXY_PROVIDER_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;

/**
 * Provider IDs become an upstream routing prefix, so use one deliberately
 * narrower grammar at every CLIProxy boundary. In particular, percent escapes,
 * path delimiters, whitespace and dot-only path segments are never accepted.
 */
export function isCliProxyProviderId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 128
    && CLIPROXY_PROVIDER_ID_PATTERN.test(value)
    && value !== "."
    && value !== "..";
}

export function validateProviderId(value: unknown): string {
  if (!isCliProxyProviderId(value)) {
    throw Object.assign(new Error("cliproxy_provider_id_invalid"), { code: "cliproxy_provider_id_invalid" });
  }
  return value;
}
