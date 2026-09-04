import { RelayError } from "@frely/core";
import type { PersonalProviderSlotSnapshot } from "@frely/entitlement";

export interface PersonalProviderPublicDto {
  id: string;
  name: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalProviderModelPublicDto {
  id: string;
  providerId: string;
  providerModelName: string;
  displayName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function publicPersonalProvider(provider: {
  id: string; name: string; kind: string; status: string; createdAt: string; updatedAt: string;
}): PersonalProviderPublicDto {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    status: provider.status,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export function publicPersonalProviderModel(model: {
  id: string; providerId: string; providerModelName: string; displayName: string; status: string; createdAt: string; updatedAt: string;
}): PersonalProviderModelPublicDto {
  return {
    id: model.id,
    providerId: model.providerId,
    providerModelName: model.providerModelName,
    displayName: model.displayName,
    status: model.status,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

export function publicPersonalProviderSlot(slot: PersonalProviderSlotSnapshot) {
  return {
    id: slot.id,
    providerId: slot.lifecycle === "retention_expired" ? null : slot.providerId,
    lifecycle: slot.lifecycle,
    latestEffectiveEnd: slot.latestEffectiveEnd,
    renewalCutoff: slot.renewalCutoff,
    retentionExpiredAt: slot.retentionExpiredAt,
    usedAccessPoints: slot.lifecycle === "retention_expired" ? 0 : slot.usedAccessPoints,
    maxAccessPoints: slot.maxAccessPoints,
    createdAt: slot.createdAt,
  };
}

export function publicPersonalOAuthStatus(value: unknown) {
  const result = record(value);
  if (!result || (result.status !== "pending" && result.status !== "ready")) throw invalidOAuthProjection();
  const binding = record(result.binding);
  if (!binding || !Number.isSafeInteger(binding.revision)
    || (binding.syncStatus !== "pending" && binding.syncStatus !== "ready" && binding.syncStatus !== "error" && binding.syncStatus !== "cleared")) {
    throw invalidOAuthProjection();
  }
  return {
    status: result.status,
    binding: {
      revision: binding.revision as number,
      syncStatus: binding.syncStatus,
    },
  };
}

export function publicPersonalOAuthStart(value: unknown) {
  const result = record(value);
  if (!result || typeof result.sessionId !== "string" || typeof result.authorizationUrl !== "string"
    || typeof result.expiresAt !== "string" || !Number.isSafeInteger(result.bindingRevision)) throw invalidOAuthProjection();
  return {
    sessionId: result.sessionId,
    authorizationUrl: result.authorizationUrl,
    expiresAt: result.expiresAt,
    bindingRevision: result.bindingRevision as number,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function invalidOAuthProjection(): RelayError {
  return new RelayError("personal_provider_oauth_projection_invalid", "Personal Provider OAuth response is unavailable", 503);
}
