import { readConsoleApiResponse } from "@frely/console-ui/api-error";

export type AuthorityMutation =
  | { kind: "purchase"; productId: string; teamId?: string }
  | { kind: "renew"; productId: string; slotId: string }
  | { kind: "create-team"; name: string };

export interface TeamProviderPurchaseCandidate {
  id: string;
  name: string;
  role: "Owner" | "Billing";
  permanent: number;
  currentEnd: string | null;
}

export async function fetchTeamProviderPurchaseCandidates(query: string, page: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await fetch(`/api/user/team-provider-purchase-candidates?${params}`, signal ? { signal } : {});
  return readConsoleApiResponse<{ items: TeamProviderPurchaseCandidate[]; page: number; pageSize: 20; total: number; totalPages: number }>(
    response,
    "Team candidates could not be loaded"
  );
}

export async function mutateAuthority(input: AuthorityMutation) {
  const path = input.kind === "purchase" ? `/api/user/authority-products/${input.productId}/purchase`
    : input.kind === "renew" ? `/api/user/authority-products/${input.productId}/renew` : "/api/user/teams";
  const body = input.kind === "purchase" ? (input.teamId ? { teamId: input.teamId } : {})
    : input.kind === "renew" ? { slotId: input.slotId } : { name: input.name };
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
  return readConsoleApiResponse<{ teamId?: string; targetStatus?: string }>(response, "Authority operation failed");
}
