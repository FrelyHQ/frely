import { queryOptions } from "@tanstack/react-query";
import { fetchCardInventory, fetchCardTransfers, fetchPlanCards } from "../api/cards-api";
import type { CardInventoryStatus } from "../lib/cards-url-state";

export const cardsQueryKey = ["web", "cards"] as const;
export const cardInventoryQueryKey = (status: CardInventoryStatus, page: number, pageSize: number) => [...cardsQueryKey, "inventory", status, page, pageSize] as const;
export const planCardsQueryKey = (planId: string, page: number, pageSize: number) => [...cardsQueryKey, "plan", planId, page, pageSize] as const;
export const cardTransfersQueryKey = (page: number, pageSize: number) => [...cardsQueryKey, "transfers", page, pageSize] as const;

export function cardInventoryQueryOptions(status: CardInventoryStatus, page: number, pageSize: number) {
  return queryOptions({
    queryKey: cardInventoryQueryKey(status, page, pageSize),
    queryFn: ({ signal }) => fetchCardInventory(status, page, pageSize, signal),
    staleTime: 10_000,
    retry: false,
  });
}

export function planCardsQueryOptions(planId: string, page: number, pageSize: number) {
  return queryOptions({
    queryKey: planCardsQueryKey(planId, page, pageSize),
    queryFn: ({ signal }) => fetchPlanCards(planId, page, pageSize, signal),
    staleTime: 10_000,
    retry: false,
  });
}

export function cardTransfersQueryOptions(page: number, pageSize: number) {
  return queryOptions({
    queryKey: cardTransfersQueryKey(page, pageSize),
    queryFn: ({ signal }) => fetchCardTransfers(page, pageSize, signal),
    staleTime: 10_000,
    retry: false,
  });
}
