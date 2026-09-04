import { requireWebUserPage } from "../../lib/web-page";

export async function loadPage() {
  const { view, availableTeams, availableTeamCount } = await requireWebUserPage("/user");
  return { view, availableTeams, availableTeamCount };
}

export type UserPageData = Awaited<ReturnType<typeof loadPage>>;
