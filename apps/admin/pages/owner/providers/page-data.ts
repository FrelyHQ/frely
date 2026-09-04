import type { ProviderModelRecord } from "../../../features/providers/types";

interface ProviderDirectoryBoundarySource {
  id: string;
  scopeRef: string;
  name: string;
  kind: string;
  status: string;
  configJson: string;
  binding: {
    authMethod: "oauth" | "api-key" | "credential-import";
    credentialOwnership: "cpa-managed" | "linked";
    credentialPreview: string | null;
    revision: number;
    syncStatus: "pending" | "ready" | "error" | "cleared";
    errorCode: string | null;
    updatedAt: string;
  } | null;
  modelCount: number;
  modelNames: string[];
  deletionState: {
    hasAccessPointReferences: boolean;
    hasOnlineBillingHistory: boolean;
    credentialCleared: boolean;
    retained: boolean;
  };
}

export function providerDirectoryRowData(
  provider: ProviderDirectoryBoundarySource,
  models: readonly ProviderModelRecord[],
) {
  return {
    id: provider.id,
    scopeRef: provider.scopeRef,
    name: provider.name,
    kind: provider.kind,
    status: provider.status,
    configJson: provider.configJson,
    binding: provider.binding ? {
      authMethod: provider.binding.authMethod,
      credentialOwnership: provider.binding.credentialOwnership,
      credentialPreview: provider.binding.credentialPreview,
      revision: provider.binding.revision,
      syncStatus: provider.binding.syncStatus,
      errorCode: provider.binding.errorCode,
      updatedAt: provider.binding.updatedAt,
    } : null,
    modelCount: provider.modelCount,
    modelNames: [...provider.modelNames],
    deletionState: {
      hasAccessPointReferences: provider.deletionState.hasAccessPointReferences,
      hasOnlineBillingHistory: provider.deletionState.hasOnlineBillingHistory,
      credentialCleared: provider.deletionState.credentialCleared,
      retained: provider.deletionState.retained,
    },
    models: models.map((model) => ({
      id: model.id,
      providerId: model.providerId,
      providerModelName: model.providerModelName,
      displayName: model.displayName,
      status: model.status,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
    })),
  };
}
