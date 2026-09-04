import { readConsoleApiResponse } from "@frely/console-ui/api-error";

export type GrantActionType = "subscription" | "plan_card" | "credit_card";
export type GrantBatchItem = { id: string; targetUserId: string; targetEmail: string; outcome: "success" | "skipped" | "failed"; reasonCode: string | null; cardId: string | null; subscriptionId: string | null; processedAt: string; };
export type GrantBatchDetail = { batch: { id: string; actionType: GrantActionType; referenceCode: string; planId: string | null; creditProductId: string | null; expiresAt: string | null; fallbackToPlanCard: number; createdAt: string; completedAt: string | null; }; items: GrantBatchItem[]; total: number; page: number; pageSize: number; totalPages: number; };

export async function createGrantBatch(input: { actionType: GrantActionType; targetUserIds: string[]; planId?: string; creditProductId?: string; expiresAt?: string; referenceCode: string; note?: string; fallbackToPlanCard: boolean; }) {
  const response = await fetch("/api/owner/grant-batches", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(input) });
  return readConsoleApiResponse<GrantBatchDetail>(response, "Create batch grant failed");
}
