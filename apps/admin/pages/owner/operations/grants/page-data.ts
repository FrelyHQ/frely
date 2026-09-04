import type {
  GrantActionType,
  GrantBatchDetail,
} from "../../../../features/batch-grants/api";

interface GrantBatchDetailInput {
  batch: {
    id: string;
    actionType: string;
    referenceCode: string;
    planId: string | null;
    creditProductId: string | null;
    expiresAt: string | null;
    fallbackToPlanCard: number;
    createdAt: string;
    completedAt: string | null;
  };
  items: Array<{
    id: string;
    targetUserId: string;
    targetEmail: string;
    outcome: string;
    reasonCode: string | null;
    cardId: string | null;
    subscriptionId: string | null;
    processedAt: string;
  }>;
  total: number;
}

export function grantBatchPageData(
  detail: GrantBatchDetailInput,
  page: number,
  pageSize: number,
): GrantBatchDetail {
  return {
    batch: {
      id: detail.batch.id,
      actionType: detail.batch.actionType as GrantActionType,
      referenceCode: detail.batch.referenceCode,
      planId: detail.batch.planId,
      creditProductId: detail.batch.creditProductId,
      expiresAt: detail.batch.expiresAt,
      fallbackToPlanCard: detail.batch.fallbackToPlanCard,
      createdAt: detail.batch.createdAt,
      completedAt: detail.batch.completedAt,
    },
    items: detail.items.map((item) => ({
      id: item.id,
      targetUserId: item.targetUserId,
      targetEmail: item.targetEmail,
      outcome: item.outcome as "success" | "skipped" | "failed",
      reasonCode: item.reasonCode,
      cardId: item.cardId,
      subscriptionId: item.subscriptionId,
      processedAt: item.processedAt,
    })),
    total: detail.total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(detail.total / pageSize)),
  };
}
