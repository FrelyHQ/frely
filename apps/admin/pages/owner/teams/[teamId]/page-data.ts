export function teamDetailBoundaryData<State extends string>(
  config: { app: { publicBaseUrl: string } },
  providerEntitlementState: { state: State },
) {
  return {
    inviteRegistrationBaseUrl: config.app.publicBaseUrl,
    providerEntitlementState: { state: providerEntitlementState.state },
  };
}

interface TeamProviderEntitlementHistoryInput {
  items: Array<{
    id: string;
    sourceKind: string;
    sourceProductCodeSnapshot: string | null;
    sourceProductVersionSnapshot: number | null;
    buyerEmail: string | null;
    issuedByEmail: string | null;
    effectiveStart: string;
    effectiveEnd: string | null;
    lifecycle: string;
    cancelReasonCode: string | null;
  }>;
  pageSize: number;
  nextCursor: string | null;
}

export function teamProviderEntitlementHistoryData(history: TeamProviderEntitlementHistoryInput) {
  return {
    items: history.items.map((item) => ({
      id: item.id,
      sourceKind: item.sourceKind,
      sourceProductCodeSnapshot: item.sourceProductCodeSnapshot,
      sourceProductVersionSnapshot: item.sourceProductVersionSnapshot,
      buyerEmail: item.buyerEmail,
      issuedByEmail: item.issuedByEmail,
      effectiveStart: item.effectiveStart,
      effectiveEnd: item.effectiveEnd,
      lifecycle: item.lifecycle,
      cancelReasonCode: item.cancelReasonCode,
    })),
    pageSize: history.pageSize,
    nextCursor: history.nextCursor,
  };
}
