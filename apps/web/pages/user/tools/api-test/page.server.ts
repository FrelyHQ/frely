import { requireWebUserPage } from "../../../../lib/web-page";

export async function loadPage() {
  const { view } = await requireWebUserPage("/user/tools/api-test");
  const seen = new Set<string>();
  const models = view.accessPoints.flatMap((accessPoint) => {
    if (!accessPoint.exposedModel || seen.has(accessPoint.exposedModel)) return [];
    seen.add(accessPoint.exposedModel);
    return [{
      model: accessPoint.exposedModel,
      label: accessPoint.displayName,
      apiFamily: accessPoint.apiFamily,
      ...(accessPoint.description ? { description: accessPoint.description } : {}),
    }];
  });
  return { models, apiKeyCount: view.apiKeys.length };
}

export type UserApiTestPageData = Awaited<ReturnType<typeof loadPage>>;
