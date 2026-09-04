import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import type { UnauthorizedHandler } from "./unauthorized-response.js";

export function createConsoleQueryClient(options: { onUnauthorized?: UnauthorizedHandler } = {}) {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => notifyUnauthorized(error, options.onUnauthorized)
    }),
    mutationCache: new MutationCache({
      onError: (error) => notifyUnauthorized(error, options.onUnauthorized)
    }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
        staleTime: 30_000
      },
      mutations: {
        retry: false
      }
    }
  });
}

function notifyUnauthorized(error: unknown, onUnauthorized: UnauthorizedHandler | undefined) {
  if (queryErrorStatus(error) === 401) onUnauthorized?.();
}

function shouldRetryQuery(failureCount: number, error: unknown) {
  if (failureCount >= 2) return false;
  const status = queryErrorStatus(error);
  return status !== 401 && status !== 403;
}

function queryErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}
