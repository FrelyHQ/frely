import type * as applicationModels from "../application-model-contracts.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type PageResult } from "./pagination.js";

export type ApiKey = applicationModels.ApiKeysRow;

export interface OwnerApiKeyDirectoryInput { query?: string; page?: number; pageSize?: number; }
export interface OwnerApiKeyDirectoryRow {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  status: string;
  createdAt: string;
  userEmail: string;
  scopeSummary: string;
  budgetLimit: number | null;
  budgetWindowType: string | null;
  budgetWindowSeconds: number | null;
  calculatedCost: number;
  lastUsedAt: string | null;
}
export interface OwnerApiKeyDirectoryMetrics { totalKeys: number; activeKeys: number; revokedKeys: number; usedKeys: number; }
export interface UserApiKeyDirectoryInput { query?: string; page?: number; pageSize?: number; }
export interface UserApiKeyDirectoryRow {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  status: string;
  createdAt: string;
  budgetLimit: number | null;
  budgetWindowType: string | null;
  budgetWindowSeconds: number | null;
  calculatedCost: number;
  lastUsedAt: string | null;
}
export interface UserApiKeyDirectoryMetrics {
  totalKeys: number;
  activeKeys: number;
  disabledKeys: number;
  peakUsagePercent: number;
}
export interface ApiKeyCandidate { id: string; userId: string; name: string; keyPrefix: string; status: string; }
export interface ApiKeyListSummary { id: string; userId: string; name: string; keyPrefix: string; status: string; createdAt: string; }
export interface UserApiKeyDetailRow extends ApiKeyListSummary {
  expiresAt: string | null;
  revokedAt: string | null;
}
