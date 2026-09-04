import { readConsoleApiResponse } from "@frely/console-ui/api-error";

export interface SubscriptionCandidate {
  value: string;
  label: string;
  description: string;
  billingMode?: "prepaid" | "paygo";
  purchaseAmount?: number;
  durationSeconds?: number;
  balance?: number;
}

export interface SubscriptionCandidatePage {
  items: SubscriptionCandidate[];
  page: number;
  pageSize: 20;
  total: number;
  totalPages: number;
}

export async function fetchSubscriptionCandidates(kind: string, search: string, page: number, subscriptionId?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ kind, search, page: String(page) });
  if (subscriptionId) params.set("subscriptionId", subscriptionId);
  const response = await fetch(`/api/owner/subscription-candidates?${params}`, signal ? { signal } : undefined);
  return readConsoleApiResponse<SubscriptionCandidatePage>(response, "Load Subscription candidates failed");
}
