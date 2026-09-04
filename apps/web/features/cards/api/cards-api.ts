import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type {
  CardInventoryData,
  CardMutationInput,
  CardTransferData,
  PlanCardDetailData,
} from "../types";
import type { CardInventoryStatus } from "../lib/cards-url-state";

export async function fetchCardInventory(status: CardInventoryStatus, page: number, pageSize: number, signal?: AbortSignal) {
  const response = await fetch(`/api/user/card-inventory?status=${status}&page=${page}&pageSize=${pageSize}`, {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  return readConsoleApiResponse<CardInventoryData>(response, "Could not load card inventory");
}

export async function fetchPlanCards(planId: string, page: number, pageSize: number, signal?: AbortSignal) {
  const response = await fetch(
    `/api/user/card-inventory/plans/${encodeURIComponent(planId)}?page=${page}&pageSize=${pageSize}`,
    { cache: "no-store", ...(signal ? { signal } : {}) },
  );
  return readConsoleApiResponse<PlanCardDetailData>(response, "Could not load Plan cards");
}

export async function fetchCardTransfers(page: number, pageSize: number, signal?: AbortSignal) {
  const response = await fetch(`/api/user/card-transfers?page=${page}&pageSize=${pageSize}`, {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  return readConsoleApiResponse<CardTransferData>(response, "Could not load card transfers");
}

export async function mutateCard(input: CardMutationInput) {
  const url = `/api/user/cards/${encodeURIComponent(input.cardId)}/${input.kind}`;
  const body = input.kind === "use"
    ? {}
    : {
        toUserId: input.toUserId,
        ...(input.referenceCode !== undefined ? { referenceCode: input.referenceCode } : {}),
        note: input.note,
      };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await readConsoleApiResponse<unknown>(
    response,
    input.kind === "use" ? "Could not use card" : "Could not send card",
  );
}
