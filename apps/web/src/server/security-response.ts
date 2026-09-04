const DEFAULT_DYNAMIC_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

export function withWebSecurityHeaders(
  response: Response,
  options: { production?: boolean; requestId?: string } | boolean = {},
): Response {
  const production = typeof options === "boolean"
    ? options
    : options.production ?? process.env.NODE_ENV === "production";
  const requestId = typeof options === "boolean" ? undefined : options.requestId;
  const headers = new Headers(response.headers);
  if (!headers.has("cache-control")) headers.set("cache-control", DEFAULT_DYNAMIC_CACHE_CONTROL);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  if (requestId) headers.set("x-request-id", requestId);
  if (production) headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
