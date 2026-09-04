export const cardExpirationPurchaseNotice = "发卡后有效 2 年，过期作废且不退款";

export function cardExpiryPresentation(expiresAt: string, now = Date.now()) {
  const remainingMs = Math.max(0, Date.parse(expiresAt) - now);
  const remainingDays = Math.ceil(remainingMs / 86_400_000);
  return {
    remainingDays,
    urgency: remainingMs <= 7 * 86_400_000 ? "warning" : remainingMs <= 30 * 86_400_000 ? "notice" : "normal"
  } as const;
}

export function cardPurchaseRequest(productIdKey: "planId" | "productListingId", productId: string, useImmediately: boolean) {
  return { [productIdKey]: productId, useImmediately };
}
