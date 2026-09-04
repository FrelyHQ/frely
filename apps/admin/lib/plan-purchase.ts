import type { PlanPurchaseOrder } from "@frely/ui-application/contracts";

export interface OwnerPlanPurchaseOrder {
  orderId: string;
  buyerUserId: string;
  planId: string;
  planPaymentListingId: string | null;
  paymentChannelId: string | null;
  paymentKind: "credit_balance" | "payment_listing";
  paymentNetwork: string;
  paymentAsset: string;
  expectedPaymentAmountUnits: number;
  canonicalPurchaseAmountUnits: number;
  useImmediately: boolean;
  status: PlanPurchaseOrder["status"];
  checkoutSessionTail: string | null;
  paymentIntentTail: string | null;
  cardId: string | null;
  creditLedgerEventId: string | null;
  subscriptionId: string | null;
  expiresAt: string | null;
  fulfilledAt: string | null;
  paymentFailedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  reversedAt: string | null;
  reversedByUserId: string | null;
  reversalReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export function ownerPlanPurchaseOrder(order: PlanPurchaseOrder): OwnerPlanPurchaseOrder {
  return {
    orderId: order.id,
    buyerUserId: order.buyerUserId,
    planId: order.planId,
    planPaymentListingId: order.planPaymentListingId,
    paymentChannelId: order.paymentChannelId,
    paymentKind: order.paymentKind,
    paymentNetwork: order.paymentNetwork,
    paymentAsset: order.paymentAsset,
    expectedPaymentAmountUnits: order.expectedPaymentAmountUnits,
    canonicalPurchaseAmountUnits: order.canonicalPurchaseAmountUnits,
    useImmediately: order.useImmediately,
    status: order.status,
    checkoutSessionTail: order.checkoutSessionId?.slice(-8) ?? null,
    paymentIntentTail: order.paymentIntentId?.slice(-8) ?? null,
    cardId: order.cardId,
    creditLedgerEventId: order.creditLedgerEventId,
    subscriptionId: order.subscriptionId,
    expiresAt: order.expiresAt,
    fulfilledAt: order.fulfilledAt,
    paymentFailedAt: order.paymentFailedAt,
    cancelledAt: order.cancelledAt,
    expiredAt: order.expiredAt,
    reversedAt: order.reversedAt,
    reversedByUserId: order.reversedByUserId,
    reversalReason: order.reversalReason,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}
