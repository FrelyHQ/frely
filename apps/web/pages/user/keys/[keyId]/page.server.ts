import { getRequestHeaders } from "@tanstack/react-start/server";
import { notFound, redirect } from "@web/navigation";
import { loadUserAudienceApiKeyDetailAsync } from "@frely/tenancy/audience-server";
import { services } from "../../../../lib/server";

export async function loadPage(keyId: string) {
  const { asyncTenancy, authorityEntitlement, application } = await services();
  let claims: Awaited<ReturnType<typeof asyncTenancy.requireUser>>;
  try {
    claims = await asyncTenancy.requireUser(new Headers(getRequestHeaders()));
  } catch {
    redirect(`/login?next=/user/keys/${encodeURIComponent(keyId)}`);
  }
  const apiKey = await loadUserAudienceApiKeyDetailAsync(application.queries, claims.sub, keyId);
  if (!apiKey) notFound();
  const restriction = await authorityEntitlement.entitlement.decideApiKeyPlanSourceRestriction(apiKey.id);
  return {
    apiKey: {
      ...apiKey,
      planSourceRestriction: {
        mode: restriction.mode,
        sourceCount: restriction.sourceKeys.length,
        teamCount: restriction.teamScopeRefs.length,
      },
    },
    planSourceRestriction: restriction,
  };
}

export type WebApiKeyDetailPageData = Awaited<ReturnType<typeof loadPage>>;
