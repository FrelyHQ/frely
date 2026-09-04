export interface PlanPaymentListing {
  id: string;
  planId: string;
  paymentChannelId: string;
  channelDisplayName: string;
  paymentNetwork: string;
  paymentAsset: string;
  settlementMode: string;
  priceAmountUnits: number;
}

export interface PlanProduct {
  id: string;
  name: string;
  version: number;
  description: string | null;
  purchaseAmount: number;
  durationSeconds: number;
  accessPointCount: number;
  paymentListings: PlanPaymentListing[];
}

export interface PlanPurchaseInput {
  planId: string;
  planName: string;
  useImmediately: boolean;
  idempotencyKey: string;
  payment: { kind: "credit_balance" } | { kind: "payment_listing"; listingId: string };
}

export type PlanPurchaseResponse =
  | { kind: "fulfilled"; orderId: string; cardId: string; subscriptionId: string | null }
  | { kind: "stripe_checkout"; orderId: string; checkoutUrl: string };

export interface PlanPurchaseOrderStatus {
  orderId: string;
  planId: string;
  status: "pending_payment" | "fulfilled" | "payment_failed" | "cancelled" | "expired" | "reversed";
  useImmediately: boolean;
  cardId: string | null;
  subscriptionId: string | null;
  paymentAsset: string;
  expectedPaymentAmountUnits: number;
}
