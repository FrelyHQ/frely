import { requireWebUserPage } from "../../../lib/web-page";

export async function loadPage() {
  const { view } = await requireWebUserPage("/user/chat");
  const seen = new Set<string>();
  const models = view.accessPoints.flatMap((accessPoint) => {
    if (seen.has(accessPoint.exposedModel)) return [];
    seen.add(accessPoint.exposedModel);
    return [{ model: accessPoint.exposedModel, label: accessPoint.displayName, apiFamily: accessPoint.apiFamily }];
  });
  return { models };
}

export type UserChatPageData = Awaited<ReturnType<typeof loadPage>>;
