import { requireWebUserSession } from "../../../../lib/web-page";
import { userAccessDirectoryState } from "../../../../features/access/lib/user-access-url-state";

export async function loadPage(search: Record<string, string | string[] | undefined>) {
  const state = userAccessDirectoryState(search);
  const { services, claims } = await requireWebUserSession("/user/access/available-models");
  const at = new Date().toISOString();
  const directory = await services.application.queries.pageUserAvailableModels(claims.sub, state, at);
  const metrics = await services.application.queries.getUserAvailableModelMetrics(claims.sub, at);
  return { state, directory, metrics, userId: claims.sub };
}

export type AvailableModelsPageData = Awaited<ReturnType<typeof loadPage>>;
