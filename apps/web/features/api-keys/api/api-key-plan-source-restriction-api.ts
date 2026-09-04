import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { ApiKeyPlanSourceRestriction, ApiKeyPlanSourceRestrictionApi, ApiKeyPlanSourceRestrictionCandidatePage } from "@frely/console-ui/api-key-plan-source-restriction";

export function createWebApiKeyPlanSourceRestrictionApi(apiKeyId: string): ApiKeyPlanSourceRestrictionApi {
  return {
    pageCandidates: async ({ query, page, pageSize }, signal) => {
      const params = new URLSearchParams({ q: query, page: String(page), pageSize: String(pageSize) });
      const response = await fetch(`/api/user/api-keys/${encodeURIComponent(apiKeyId)}/plan-source-restriction/candidates?${params.toString()}`, signal ? { signal, cache: "no-store" } : { cache: "no-store" });
      return readConsoleApiResponse<ApiKeyPlanSourceRestrictionCandidatePage>(response, "Failed to load Plan source candidates");
    },
    replace: async (input) => {
      const response = await fetch(`/api/user/api-keys/${encodeURIComponent(apiKeyId)}/plan-source-restriction`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return readConsoleApiResponse<ApiKeyPlanSourceRestriction>(response, "Failed to save Plan source restriction");
    },
  };
}
