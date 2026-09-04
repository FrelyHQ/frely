export async function GET() {
  return Response.json({ error: "auth_method_retired" }, { status: 404, headers: { "cache-control": "no-store" } });
}

export async function POST() {
  return Response.json({ error: "auth_method_retired" }, { status: 404, headers: { "cache-control": "no-store" } });
}
