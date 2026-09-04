import { RelayError } from "@frely/core";
import type { PrismaTransactionOwner } from "@frely/postgres/server";
import type { ProviderRuntimeTargetExpectation } from "./index.js";

export type ProviderRuntimeTargetMaterial = ProviderRuntimeTargetExpectation & Readonly<{
  authMethod: "oauth" | "api-key" | "credential-import";
  credentialOwnership: "cpa-managed";
}>;

export interface ProviderRuntimeTargetReader {
  loadAvailableTarget(providerModelId: string): Promise<ProviderRuntimeTargetMaterial>;
}

export class PostgresProviderRuntimeTargetReader implements ProviderRuntimeTargetReader {
  constructor(private readonly transactions: PrismaTransactionOwner) {}

  loadAvailableTarget(providerModelId: string): Promise<ProviderRuntimeTargetMaterial> {
    return this.transactions.withPrismaTransaction(async (transaction) => {
      const model = await transaction.provider_models.findUnique({
        where: { id: providerModelId },
        include: {
          providers: {
            include: { provider_bindings: true },
          },
        },
      });
      const provider = model?.providers;
      const binding = provider?.provider_bindings;
      const credentialRefs = binding ? parseCredentialRefs(binding.credential_refs_json) : [];
      if (!model
        || model.status !== "enabled"
        || !provider
        || provider.status !== "enabled"
        || !binding
        || binding.sync_status !== "ready"
        || binding.credential_ownership !== "cpa-managed"
        || (binding.auth_method !== "oauth" && binding.auth_method !== "api-key" && binding.auth_method !== "credential-import")
        || credentialRefs.length !== 1) {
        throw new RelayError("provider_runtime_target_unavailable", "Provider Runtime target is unavailable", 503);
      }
      return Object.freeze({
        providerModelId: model.id,
        providerId: provider.id,
        providerModelName: model.provider_model_name,
        providerKind: provider.kind,
        cpaInstanceId: provider.cpa_instance_id,
        providerUpdatedAt: provider.updated_at,
        providerModelUpdatedAt: model.updated_at,
        bindingRevision: binding.revision,
        authMethod: binding.auth_method,
        credentialOwnership: binding.credential_ownership,
      });
    }, 1, { isolationLevel: "ReadCommitted", statementTimeoutMillis: 5_000 });
  }
}

function parseCredentialRefs(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const refs = parsed.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 1_024);
    return refs.length === parsed.length ? refs : [];
  } catch {
    return [];
  }
}
