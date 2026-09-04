import type { SubscriptionSearchState } from "./query";

export function subscriptionsHref(state: SubscriptionSearchState, overrides: Partial<SubscriptionSearchState> = {}) {
  const value = { ...state, ...overrides };
  const params = new URLSearchParams();
  if (value.subscriptionId) params.set("subscriptionId", value.subscriptionId);
  if (value.planId) params.set("planId", value.planId);
  if (value.scopeType) params.set("scopeType", value.scopeType);
  if (value.scopeRef) params.set("scopeRef", value.scopeRef);
  params.set("status", value.status);
  if (value.source) params.set("source", value.source);
  if (value.effectiveState) params.set("effectiveState", value.effectiveState);
  if (value.page > 1) params.set("page", String(value.page));
  if (value.pageSize !== 20) params.set("pageSize", String(value.pageSize));
  return `/owner/plans/subscriptions?${params}`;
}
