import path from "node:path";
import { fileURLToPath } from "node:url";
import start from "./server/server.js";
import { serve } from "srvx/bun";

const artifactRoot = path.dirname(fileURLToPath(import.meta.url));
const hostname = process.env.HOST?.trim() || process.env.HOSTNAME?.trim() || "127.0.0.1";
const port = parsePort(process.env.PORT ?? "43002");

serve({
  hostname,
  port,
  trustProxy: false,
  gracefulShutdown: true,
  async fetch(request) {
    const staticResponse = await serveStaticAsset(request);
    return staticResponse ?? start.fetch(request);
  },
  error() {
    process.stderr.write(`${JSON.stringify({ code: "internal_server_error", event: "admin.listener.failed" })}\n`);
    const headers = new Headers({
      "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId(),
    });
    if (process.env.NODE_ENV === "production") {
      headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return Response.json({ error: "internal_server_error" }, { status: 500, headers });
  },
});

async function serveStaticAsset(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const pathname = new URL(request.url).pathname;
  const prefix = pathname.startsWith("/_build/")
    ? "/_build/"
    : pathname.startsWith("/assets/")
      ? "/assets/"
      : null;
  if (!prefix || pathname.includes("..")) return null;
  const relative = pathname.slice(prefix.length);
  if (!relative || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  for (const candidate of [
    path.join(artifactRoot, "client", prefix.slice(1, -1), relative),
    path.join(artifactRoot, "client", relative),
  ]) {
    const file = Bun.file(candidate);
    if (!await file.exists()) continue;
    const headers = new Headers({
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": contentType(candidate),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId(request),
    });
    if (process.env.NODE_ENV === "production") {
      headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return new Response(request.method === "HEAD" ? null : file, { headers });
  }
  return null;
}

function contentType(file) {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function requestId(request) {
  const external = request?.headers.get("x-request-id") ?? null;
  return external !== null && /^req_[A-Za-z0-9][A-Za-z0-9_.-]{0,187}$/u.test(external)
    ? external
    : `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("admin_port_invalid");
  return parsed;
}
