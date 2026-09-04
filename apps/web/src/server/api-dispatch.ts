export type WebRouteContext = { params: Promise<Record<string, string | string[]>> };
export type WebRouteHandler = (request: Request, context: WebRouteContext) => Response | Promise<Response>;
export type WebRouteModule = Partial<Record<string, WebRouteHandler>>;

export interface WebApiRouteDefinition {
  pattern: RegExp;
  params: readonly { name: string; catchall: boolean }[];
  methods: readonly string[];
  module: unknown;
}

export async function dispatchWebApi(
  request: Request,
  routes: readonly WebApiRouteDefinition[],
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (!hasValidPathEncoding(pathname)) return Response.json({ error: "invalid_path_encoding" }, { status: 400 });
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const params: Record<string, string | string[]> = {};
    route.params.forEach((definition, index) => {
      const value = match[index + 1];
      if (value === undefined) return;
      params[definition.name] = definition.catchall
        ? value === "" ? [] : value.split("/").map(decodeURIComponent)
        : decodeURIComponent(value);
    });
    const routeModule = route.module as WebRouteModule;
    const allow = allowedMethods(route.methods);
    if (request.method === "OPTIONS" && !routeModule.OPTIONS) return new Response(null, { status: 204, headers: { allow: allow.join(", ") } });
    const requested = request.method === "HEAD" && !routeModule.HEAD && routeModule.GET ? "GET" : request.method;
    const handler = routeModule[requested];
    if (!handler) return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: allow.join(", ") } });
    const response = await handler(request, { params: Promise.resolve(params) });
    if (request.method !== "HEAD" || requested !== "GET") return response;
    try {
      await response.body?.cancel("automatic-head-response");
    } catch {
      process.stdout.write(`${JSON.stringify({ event: "web.head_body.cancel_failed", code: "response_body_cancel_failed" })}\n`);
    }
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

export function allowedMethods(methods: readonly string[]): string[] {
  const allow = new Set(methods);
  if (allow.has("GET")) allow.add("HEAD");
  allow.add("OPTIONS");
  return [...allow].sort();
}

function hasValidPathEncoding(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return true;
  } catch {
    return false;
  }
}
