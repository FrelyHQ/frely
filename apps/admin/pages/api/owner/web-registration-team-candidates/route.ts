import { RelayError } from "@frely/core";
import { handle, json, services } from "../../../../lib/server";

export async function GET(request: Request) {
  return handle(request, async () => {
    const { asyncTenancy, application} = await services();
    await asyncTenancy.requireOwner(request.headers);
    const params = new URL(request.url).searchParams;
    assertQuery(params);
    const query = params.get("q") ?? "";
    const cursor = params.get("cursor");
    return json(await application.queries.searchWebRegistrationCandidates(query, cursor || null));
  });
}

function assertQuery(params: URLSearchParams): void {
  for (const key of params.keys()) {
    if (key !== "q" && key !== "cursor") throw new RelayError("invalid_web_registration_team_query", `Unsupported query parameter: ${key}`, 400);
    if (params.getAll(key).length > 1) throw new RelayError("invalid_web_registration_team_query", `Query parameter ${key} must appear once`, 400);
  }
  const query = params.get("q");
  if (query !== null && query.length > 100) throw new RelayError("invalid_web_registration_team_query", "Team search query is too long", 400);
}
