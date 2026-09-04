import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { CreateApiKeyInput, CreateApiKeyResult } from "@frely/console-ui/models";

export interface ApiKeyCandidate { id: string; userId: string; name: string; keyPrefix: string; status: string; }
export interface ApiKeyCandidatePage { items: ApiKeyCandidate[]; page: number; pageSize: number; total: number; totalPages: number; }

export async function fetchApiKeyCandidates(query: string, page: number, signal?: AbortSignal): Promise<ApiKeyCandidatePage> {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await fetch(`/api/owner/api-key-candidates?${params}`, signal ? { signal } : undefined);
  return readConsoleApiResponse<ApiKeyCandidatePage>(response, "Load API key candidates failed");
}

export interface RevokeApiKeyInput {
  apiKeyId: string;
  failureLabel?: string;
}

export async function revokeApiKey({ apiKeyId, failureLabel }: RevokeApiKeyInput) {
  const response = await fetch(`/api/owner/api-keys/${encodeURIComponent(apiKeyId)}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  return readConsoleApiResponse<unknown>(response, `Revoke ${failureLabel ?? apiKeyId} failed`);
}

export async function revokeApiKeys(inputs: RevokeApiKeyInput[]) {
  await Promise.all(inputs.map(revokeApiKey));
}

export async function createAdminApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  const response = await fetch("/api/owner/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await readConsoleApiResponse<unknown>(response, "Failed to create API key");
  return parseCreateApiKeyResult(result);
}

function parseCreateApiKeyResult(value: unknown): CreateApiKeyResult {
  if (!value || typeof value !== "object") throw new Error("API key creation returned an invalid response");
  const apiKey = "apiKey" in value ? value.apiKey : null;
  const rawKey = "rawKey" in value ? value.rawKey : null;
  if (!apiKey || typeof apiKey !== "object" || !("id" in apiKey) || typeof apiKey.id !== "string" || typeof rawKey !== "string") {
    throw new Error("API key creation returned an invalid response");
  }
  return { id: apiKey.id, rawKey };
}
