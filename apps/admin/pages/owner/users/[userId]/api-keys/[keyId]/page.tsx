import { ApiKeyDetail } from "@frely/console-ui";
import { AdminApiKeyPlanSourceRestrictionEditor } from "../../../../../../features/api-keys/components/api-key-plan-source-restriction";
import { AdminViewSwitcher } from "../../../../_components/owner-view-switcher";
import type { AdminPageData } from "./page.server";

export default function AdminApiKeyDetailPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { userId, view, viewQuery, apiKey, planSourceRestriction } = loaded;
  return (
    <ApiKeyDetail
      apiKey={apiKey}
      backHref={`/owner/users/${userId}${viewQuery}`}
      backLabel="Back to User"
      eyebrow="Owner / API Key Details"
      audienceControl={<AdminViewSwitcher view={view} audience="user" />}
      planSourceRestrictionEditor={<AdminApiKeyPlanSourceRestrictionEditor apiKeyId={apiKey.id} initial={planSourceRestriction} />}
    />
  );
}
