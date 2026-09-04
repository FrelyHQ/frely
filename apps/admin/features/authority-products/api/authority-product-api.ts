import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { AuthorityProductEffectCode } from "@frely/core";

export interface AuthorityProductInput {
  code: string; displayName: string; effectCode: AuthorityProductEffectCode; grantUnits: number;
  purchaseAmountUnits: number; grantDurationSeconds?: number; grantDurationDays?: number; maxLifetimePurchasesPerUser: number | null;
  maxUnconsumedUnitsPerUser: number | null; maxCurrentOwnedTeams: number | null;
  maxLifetimeCreatedTeams: number | null; refundMode: "none" | "unused_by_owner";
  refundDeadlineSeconds: number | null; settlementHoldSeconds: number; sellerScopeRef: string;
}

export async function createAuthorityProduct(input: AuthorityProductInput) {
  const response = await fetch("/api/owner/authority-products", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return readConsoleApiResponse<{ id: string }>(response, "Create Authority Product failed");
}

export async function updateAuthorityProductLifecycle(input: { id: string; lifecycle: "listed" | "closed" }) {
  const response = await fetch(`/api/owner/authority-products/${input.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ lifecycle: input.lifecycle }) });
  return readConsoleApiResponse<{ id: string; lifecycle: string }>(response, "Update Authority Product failed");
}
