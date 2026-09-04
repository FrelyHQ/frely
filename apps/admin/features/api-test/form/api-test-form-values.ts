import { API_TEST_TYPES, apiTestPayloadValidationError, defaultApiTestPayload } from "../lib/api-test-protocols";
import type { ApiTestType } from "../lib/api-test-protocols";
import type { ApiTestFormValues, ApiTestKey, ApiTestPayloadDrafts, ApiTestRequest } from "../types";

const fallbackModel = "gpt-4o-mini";

export function apiTestFormDefaults(apiKeyId = "", accessPointId = "", requestModel = fallbackModel): ApiTestFormValues {
  return {
    gatewayBaseUrl: "http://127.0.0.1:43000",
    accessPointId,
    apiKeyId,
    apiKey: "",
    apiType: "chat",
    payloadDrafts: apiTestPayloadDrafts(requestModel)
  };
}

export function toApiTestRequest(values: ApiTestFormValues): ApiTestRequest {
  const apiKey = values.apiKey.trim();
  const parsedPayload = JSON.parse(activeApiTestPayload(values)) as unknown;
  if (!parsedPayload || Array.isArray(parsedPayload) || typeof parsedPayload !== "object") throw new Error("Payload must be a JSON object");
  const payload = parsedPayload as Record<string, unknown>;
  const validationError = apiTestPayloadValidationError(values.apiType, payload);
  if (validationError) throw new Error(validationError);
  return { apiType: values.apiType, accessPointId: values.accessPointId, ...(apiKey ? { apiKey } : { apiKeyId: values.apiKeyId }), payload };
}

export function validateRequired(value: string, label: string) { return value.trim() ? undefined : `${label} is required`; }
export function hasExecutableApiTestIdentity(values: Pick<ApiTestFormValues, "apiKey" | "apiKeyId">, apiKeys: ApiTestKey[]) {
  return Boolean(values.apiKey.trim() || apiKeys.some((key) => key.id === values.apiKeyId && key.status === "enabled"));
}
export function validateApiTestIdentity(values: Pick<ApiTestFormValues, "apiKey" | "apiKeyId">, apiKeys: ApiTestKey[]) {
  return hasExecutableApiTestIdentity(values, apiKeys) ? undefined : "Select an available saved API key or enter a manual API key";
}
export function payloadWithModel(value: string, model: string) { try { const parsed = JSON.parse(value) as unknown; return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? JSON.stringify({ ...(parsed as Record<string, unknown>), model }, null, 2) : value; } catch { return value; } }

export function apiTestPayloadDrafts(model = fallbackModel): ApiTestPayloadDrafts {
  return Object.fromEntries(API_TEST_TYPES.map((type) => [type, JSON.stringify(defaultApiTestPayload(type, model), null, 2)])) as ApiTestPayloadDrafts;
}

export function activeApiTestPayload(values: Pick<ApiTestFormValues, "apiType" | "payloadDrafts">): string {
  return values.payloadDrafts[values.apiType];
}

export function payloadDraftsWithModel(drafts: ApiTestPayloadDrafts, model: string): ApiTestPayloadDrafts {
  return Object.fromEntries(API_TEST_TYPES.map((type) => [type, payloadWithModel(drafts[type], model)])) as ApiTestPayloadDrafts;
}

export function validateApiTestPayloadDraft(type: ApiTestType, value: string): string | undefined {
  if (!value.trim()) return "Payload is required";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return "Payload must be a JSON object";
    return apiTestPayloadValidationError(type, parsed as Record<string, unknown>);
  } catch {
    return "Payload must be valid JSON";
  }
}
