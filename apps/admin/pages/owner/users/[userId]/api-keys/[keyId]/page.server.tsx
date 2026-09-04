import { ApiKeyDetail } from "@frely/console-ui";
import { notFound } from "@admin/navigation";
import { adminAudienceViewQuery, resolveAdminUserAudienceView } from "../../../../_components/owner-view";
import { AdminViewSwitcher } from "../../../../_components/owner-view-switcher";
import { adminPageServices } from "../../../../../../lib/server";
import { loadUserAudienceApiKeyDetail, loadUserAudienceApiKeyDetailAsync } from "@frely/tenancy/audience-server";

interface AdminApiKeyDetailPageProps {
  params: Promise<{ userId: string; keyId: string }>;
  searchParams?: Promise<{ view?: string | string[] }>;
}

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const params = Promise.resolve(request.params);
  const searchParams = Promise.resolve(request.search);
  const { userId, keyId } = await params;
  if (!userId || !keyId) notFound();
  const view = resolveAdminUserAudienceView((await searchParams)?.view);
  const viewQuery = adminAudienceViewQuery(view);
  const admin = await adminPageServices();
  if (!admin) return null;
  const { application, authorityEntitlement } = admin;
  const apiKey = await loadUserAudienceApiKeyDetailAsync(application.queries, userId, keyId);
  if (!apiKey) notFound();
  const restriction = await authorityEntitlement.entitlement.decideApiKeyPlanSourceRestriction(apiKey.id);
  return { userId, view, viewQuery, apiKey: { ...apiKey, planSourceRestriction: { mode: restriction.mode, sourceCount: restriction.sourceKeys.length, teamCount: restriction.teamScopeRefs.length } }, planSourceRestriction: restriction };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
