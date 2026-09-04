import { WEB_VERSION } from "@web/web-version";

export async function GET() {
  return Response.json({ ok: true, service: "web", version: WEB_VERSION });
}
