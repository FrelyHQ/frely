"use client";

import { useRouter } from "@web/navigation";
import { ApiKeyPlanSourceRestrictionEditor, type ApiKeyPlanSourceRestriction } from "@frely/console-ui/api-key-plan-source-restriction";
import { createWebApiKeyPlanSourceRestrictionApi } from "../api/api-key-plan-source-restriction-api";

export function WebApiKeyPlanSourceRestrictionEditor({ apiKeyId, initial }: { apiKeyId: string; initial: ApiKeyPlanSourceRestriction }) {
  const router = useRouter();
  return <ApiKeyPlanSourceRestrictionEditor apiKeyId={apiKeyId} initial={initial} api={createWebApiKeyPlanSourceRestrictionApi(apiKeyId)} onSaved={() => router.refresh()} />;
}
