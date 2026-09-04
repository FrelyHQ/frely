import type { PlanPurchaseOrder } from "@frely/ui-application/contracts";

export interface PublicPlanPurchaseOrder {
  orderId: string;
  planId: string;
  planPaymentListingId: string | null;
  paymentKind: "credit_balance" | "payment_listing";
  paymentAsset: string;
  expectedPaymentAmountUnits: number;
  canonicalPurchaseAmountUnits: number;
  useImmediately: boolean;
  status: PlanPurchaseOrder["status"];
  cardId: string | null;
  subscriptionId: string | null;
  expiresAt: string | null;
  fulfilledAt: string | null;
  paymentFailedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  reversedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function publicPlanPurchaseOrder(order: PlanPurchaseOrder): PublicPlanPurchaseOrder {
  return {
    orderId: order.id,
    planId: order.planId,
    planPaymentListingId: order.planPaymentListingId,
    paymentKind: order.paymentKind,
    paymentAsset: order.paymentAsset,
    expectedPaymentAmountUnits: order.expectedPaymentAmountUnits,
    canonicalPurchaseAmountUnits: order.canonicalPurchaseAmountUnits,
    useImmediately: order.useImmediately,
    status: order.status,
    cardId: order.cardId,
    subscriptionId: order.subscriptionId,
    expiresAt: order.expiresAt,
    fulfilledAt: order.fulfilledAt,
    paymentFailedAt: order.paymentFailedAt,
    cancelledAt: order.cancelledAt,
    expiredAt: order.expiredAt,
    reversedAt: order.reversedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}
