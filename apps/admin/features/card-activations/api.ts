import { readConsoleApiResponse } from "@frely/console-ui/api-error";

export type CardActivationType = "plan" | "credit";
export type CardActivationStats = { total: number; available: number; redeemed: number; revoked: number; expired: number; redemptionRate: number };
export type CardActivationBatch = {
  id: string;
  referenceCode: string;
  cardType: CardActivationType;
  planId: string | null;
  creditProductId: string | null;
  creditAmountUnits: number | null;
  quantity: number;
  redeemExpiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  stats: CardActivationStats;
};
export type CardActivationBatchList = { items: CardActivationBatch[]; page: number; pageSize: number; total: number; totalPages: number; stats: CardActivationStats };
export type CardActivationBatchDetail = {
  batch: CardActivationBatch;
  codes: Array<{ id: string; ordinal: number; codeSuffix: string; redeemedAt: string | null; revokedAt: string | null; status: string }>;
  totalCodes: number;
  page: number;
  pageSize: number;
  totalPages: number;
  stats: CardActivationStats;
};

export async function createCardActivationBatch(input: {
  referenceCode: string;
  cardType: CardActivationType;
  planId: string | null;
  creditProductId: string | null;
  creditAmountUnits: number | null;
  quantity: number;
  redeemExpiresAt: string;
}): Promise<CardActivationBatch> {
  const response = await fetch("/api/owner/card-activation-batches", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
  return readConsoleApiResponse<CardActivationBatch>(response, "Create Card Activation batch failed");
}

export async function listCardActivationBatchDetail(batchId: string, page: number, pageSize = 20): Promise<CardActivationBatchDetail> {
  const response = await fetch(`/api/owner/card-activation-batches/${encodeURIComponent(batchId)}?page=${page}&pageSize=${pageSize}`);
  return readConsoleApiResponse<CardActivationBatchDetail>(response, "Load Card Activation batch failed");
}

export async function revokeCardActivationBatch(batchId: string): Promise<CardActivationBatch> {
  const response = await fetch(`/api/owner/card-activation-batches/${encodeURIComponent(batchId)}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "owner_revoked" }),
  });
  return readConsoleApiResponse<CardActivationBatch>(response, "Revoke Card Activation batch failed");
}

export async function revokeCardActivationCode(codeId: string): Promise<unknown> {
  const response = await fetch(`/api/owner/card-activation-codes/${encodeURIComponent(codeId)}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "owner_revoked" }),
  });
  return readConsoleApiResponse<unknown>(response, "Revoke Card Activation code failed");
}
