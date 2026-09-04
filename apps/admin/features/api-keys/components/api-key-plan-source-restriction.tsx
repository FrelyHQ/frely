"use client";

import { useRouter } from "@admin/navigation";
import { ApiKeyPlanSourceRestrictionEditor, type ApiKeyPlanSourceRestriction } from "@frely/console-ui/api-key-plan-source-restriction";
import { createAdminApiKeyPlanSourceRestrictionApi } from "../api/api-key-plan-source-restriction-api";

export function AdminApiKeyPlanSourceRestrictionEditor({ apiKeyId, initial }: { apiKeyId: string; initial: ApiKeyPlanSourceRestriction }) {
  const router = useRouter();
  return <ApiKeyPlanSourceRestrictionEditor apiKeyId={apiKeyId} initial={initial} api={createAdminApiKeyPlanSourceRestrictionApi(apiKeyId)} onSaved={() => router.refresh()} />;
}
