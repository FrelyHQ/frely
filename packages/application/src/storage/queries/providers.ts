import type * as applicationModels from "../application-model-contracts.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type PageResult } from "./pagination.js";

export type Provider = applicationModels.ProvidersRow;
export type ProviderModel = applicationModels.ProviderModelsRow;

export interface ProviderDirectoryInput { page?: number; pageSize?: number; showRetained?: boolean; }

export interface ProviderDirectoryRow extends Provider {
  binding: Pick<applicationModels.ProviderBindingsRow, "authMethod" | "credentialOwnership" | "credentialPreview" | "revision" | "syncStatus" | "errorCode" | "updatedAt"> | null;
  modelCount: number;
  modelNames: string[];
  deletionState: {
    hasAccessPointReferences: boolean;
    hasOnlineBillingHistory: boolean;
    credentialCleared: boolean;
    retained: boolean;
  };
}

export interface ProviderDirectorySummary {
  providerCount: number;
  enabledProviderCount: number;
  registeredModelCount: number;
  retainedProviderCount: number;
}
export interface ProviderCandidate { id: string; name: string; kind: string; status: string; }
export interface TeamProviderDirectoryRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  authMethod: string | null;
  credentialPreview: string | null;
  bindingStatus: string | null;
  bindingRevision: number | null;
  bindingUpdatedAt: string | null;
  modelCount: number;
  modelNames: string[];
  createdAt: string;
  updatedAt: string;
}
