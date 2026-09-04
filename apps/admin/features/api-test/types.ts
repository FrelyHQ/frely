import type { ApiTestType } from "./lib/api-test-protocols";

export interface ApiTestKey { id: string; teamId: string; userId: string; name: string; keyPrefix: string; status: string }
export interface ApiTestAccessPoint { id: string; name: string; description: string | null; status: string; exposedModel: string; targetModel: string; targetType: string; targetId: string | null; targetProviderModelName: string | null }
export interface ApiTestError { code: string | undefined; message: string | undefined; category: string | undefined }
export interface ApiTestResult { ok: boolean; status: number; elapsedMs: number; requestId: string | null; body: unknown; error?: ApiTestError | null }
export type ApiTestPayloadDrafts = Record<ApiTestType, string>;
export interface ApiTestFormValues { gatewayBaseUrl: string; accessPointId: string; apiKeyId: string; apiKey: string; apiType: ApiTestType; payloadDrafts: ApiTestPayloadDrafts }
export interface ApiTestRequest { apiType: ApiTestType; accessPointId: string; apiKeyId?: string; apiKey?: string; payload: Record<string, unknown> }
export interface ApiTestCurlRequest { gatewayBaseUrl: string; apiType: ApiTestType; accessPointId: string; apiKeyId: string; payload: Record<string, unknown> }
