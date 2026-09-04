import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type {
  CreateApiKeyInput,
  CreateApiKeyResult,
  RunApiKeyActionInput,
} from "@frely/console-ui/models";

export async function createWebApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  const response = await fetch("/api/user/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readConsoleApiResponse(response, "Failed to create API key", parseCreateApiKeyResult);
}

export async function runWebApiKeyAction(input: RunApiKeyActionInput): Promise<void> {
  if (input.action === "copy") {
    const response = await fetch(
      `/api/user/api-keys/${encodeURIComponent(input.apiKeyId)}/copy`,
      { method: "POST", cache: "no-store" },
    );
    const result = await readConsoleApiResponse(response, "Failed to copy API key", parseCopyApiKeyResult);
    await navigator.clipboard.writeText(result.rawKey);
    return;
  }
  const response = await fetch(
    `/api/user/api-keys/${encodeURIComponent(input.apiKeyId)}/revoke`,
    { method: "POST" },
  );
  await readConsoleApiResponse<unknown>(response, "Failed to delete API key");
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

function parseCopyApiKeyResult(value: unknown): { rawKey: string } {
  const rawKey = value && typeof value === "object" && "rawKey" in value ? value.rawKey : null;
  if (typeof rawKey !== "string" || !rawKey) {
    throw new Error("API key copy returned an invalid response");
  }
  return { rawKey };
}
