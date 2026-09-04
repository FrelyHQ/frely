import { notFound } from "@web/navigation";
import { loadUserAudienceAsync } from "@frely/tenancy/audience-server";
import { userApiKeyDirectoryState } from "../../../features/api-keys/lib/user-api-key-url-state";
import { requireWebUserSession } from "../../../lib/web-page";

export async function loadPage(search: Record<string, string | string[] | undefined>) {
  const state = userApiKeyDirectoryState(search);
  const { services, claims } = await requireWebUserSession("/user/keys");
  const at = new Date().toISOString();
  const audience = await loadUserAudienceAsync({
    repo: services.application.queries,
    identity: services.asyncTenancy.identity,
    tenancy: services.asyncTenancy.tenancy,
    viewerUserId: claims.sub,
    targetUserId: claims.sub,
    apiKeyPage: state.page,
    apiKeyPageSize: state.pageSize,
    apiKeyQuery: state.query,
    calculatedAt: at,
  });
  if (!audience?.apiKeys) notFound();
  return { user: audience.user, directory: audience.apiKeys, state };
}

export type UserKeysPageData = Awaited<ReturnType<typeof loadPage>>;
