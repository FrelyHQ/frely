import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { NumericPricePayload } from "../form/price-draft";
import type {
  AccessPointPrice,
  OpenAiReferencePriceTable,
  Provider,
  ProviderModelCost,
} from "../types";

export async function loadOpenAiReferencePrices(
  signal?: AbortSignal,
): Promise<OpenAiReferencePriceTable> {
  const response = await fetch(
    "/api/owner/external-price-lookup?source=openai-official-reference",
    signal ? { signal } : undefined,
  );
  return readConsoleApiResponse(
    response,
    "Load OpenAI reference prices failed",
  );
}

export async function loadProviderCandidates(
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<{ items: Provider[]; page: number; pageSize: 20; total: number; totalPages: number }> {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await fetch(`/api/owner/provider-candidates?${params}`, signal ? { signal } : undefined);
  return readConsoleApiResponse(response, "Load Provider candidates failed");
}

export async function createProviderModelCost(
  input: NumericPricePayload & {
    providerId: string;
    providerModelName: string;
  },
): Promise<ProviderModelCost> {
  const response = await fetch("/api/owner/provider-model-costs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readConsoleApiResponse(
    response,
    `Create provider model cost for ${input.providerModelName} failed`,
  );
}

export async function createAccessPointPrice(
  input: NumericPricePayload & { accessPointId: string },
): Promise<AccessPointPrice> {
  const response = await fetch("/api/owner/access-point-prices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readConsoleApiResponse(response, "Create AccessPoint price failed");
}

export async function disableProviderModelCost(
  id: string,
): Promise<ProviderModelCost> {
  return patchPriceStatus<ProviderModelCost>(
    "/api/owner/provider-model-costs",
    id,
  );
}

export async function disableAccessPointPrice(
  id: string,
): Promise<AccessPointPrice> {
  return patchPriceStatus<AccessPointPrice>(
    "/api/owner/access-point-prices",
    id,
  );
}

async function patchPriceStatus<T>(endpoint: string, id: string): Promise<T> {
  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, status: "disabled" }),
  });
  return readConsoleApiResponse(response, "Price status update failed");
}
