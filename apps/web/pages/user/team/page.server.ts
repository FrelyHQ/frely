import { requireWebUserSession } from "../../../lib/web-page";
import { buildUserTeamDirectoryAsync, userTeamDirectoryState } from "../../../lib/user-teams";

export async function loadPage(search: Record<string, string | string[] | undefined>) {
  const { services, claims } = await requireWebUserSession("/user/team");
  const directory = await buildUserTeamDirectoryAsync(
    services.application.queries,
    claims.sub,
    (teamId, action) => services.asyncTenancy.hasPermission(claims.sub, { resourceType: "team", resourceId: teamId, action }),
    userTeamDirectoryState(search),
  );
  return { directory };
}

export type TeamPageData = Awaited<ReturnType<typeof loadPage>>;
