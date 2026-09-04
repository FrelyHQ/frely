import { ApiKeyDetail } from "@frely/console-ui";
import { WebApiKeyLifecycleAction } from "../../../../features/api-keys";
import { WebApiKeyPlanSourceRestrictionEditor } from "../../../../features/api-keys/components/api-key-plan-source-restriction";
import type { WebApiKeyDetailPageData } from "./page.server";

export default function WebApiKeyDetailPage({ data }: { data: WebApiKeyDetailPageData }) {
  return <ApiKeyDetail
    apiKey={data.apiKey}
    backHref="/user/keys"
    backLabel="Back to Keys"
    eyebrow="Key Details"
    actions={<WebApiKeyLifecycleAction apiKey={data.apiKey} />}
    planSourceRestrictionEditor={<WebApiKeyPlanSourceRestrictionEditor apiKeyId={data.apiKey.id} initial={data.planSourceRestriction} />}
  />;
}
