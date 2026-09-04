export const API_KEY_ACTION_IDS = [
  "api_key.create",
  "api_key.copy",
  "api_key.delete",
] as const;

export type ApiKeyActionId = (typeof API_KEY_ACTION_IDS)[number];
export type ApiKeyAction = "copy" | "delete";

export interface CreateApiKeyInput {
  userId: string;
  name: string;
  expiresAt: string | null;
}

export interface CreateApiKeyResult {
  id: string;
  rawKey: string;
}

export interface ApiKeyCreateActionPort {
  createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult>;
  onCreated(result: CreateApiKeyResult): void | Promise<void>;
}

export interface RunApiKeyActionInput {
  apiKeyId: string;
  action: ApiKeyAction;
}

export interface ApiKeyActionPort {
  runApiKeyAction(input: RunApiKeyActionInput): Promise<void>;
  onDeleted(): void | Promise<void>;
}

export function visibleApiKeyActionIds(input: {
  canCreate: boolean;
  status?: "Active" | "Disabled" | "Revoked";
}): ApiKeyActionId[] {
  return [
    ...(input.canCreate ? ["api_key.create" as const] : []),
    ...(input.status === "Active" ? ["api_key.copy" as const, "api_key.delete" as const] : []),
    ...(input.status === "Disabled" ? ["api_key.delete" as const] : []),
  ];
}
