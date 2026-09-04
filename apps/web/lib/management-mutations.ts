import { RelayError, type AccessPointTargetType, type ScopeRef } from "@frely/core";
import { normalizeAccessPointDescription, type AccessPointCommandResult, type CreateAccessPointCommand, type ModelAccessAuditInput, type ModelAccessCommandService, type ModelAccessManagementQueryService } from "@frely/model-access/server";
import type { AuditActor, AuditSource, BillingCommands } from "@frely/ui-application/contracts";

export interface WebMutationAudit {
  actor: AuditActor;
  source: AuditSource;
  requestId?: string | null;
}

export async function createScopedAccessPointAsync(
  modelAccess: ModelAccessCommandService,
  modelAccessQueries: ModelAccessManagementQueryService,
  billing: BillingCommands,
  body: Record<string, unknown>,
  scopeRef: ScopeRef,
  audit: WebMutationAudit,
  idempotencyKey: string | null,
  createAccessPoint: (command: CreateAccessPointCommand, audit: ModelAccessAuditInput) => Promise<AccessPointCommandResult> = (command, modelAccessAudit) => modelAccess.createAccessPoint(command, modelAccessAudit),
) {
  const createKey = idempotencyKey?.trim();
  if (!createKey) throw new RelayError("idempotency_key_required", "Idempotency-Key header is required", 400);
  const targetType = normalizeAccessPointTargetType(body.targetType);
  const targetId = String(body.targetId ?? "");
  const targetProviderId = String(body.targetProviderId ?? "");
  const exposedModel = requiredString(body.exposedModel, "exposedModel");
  const targetModel = requiredString(body.targetModel, "targetModel");
  const targetProviderModelName = String(body.targetProviderModelName ?? targetModel);
  const createCommand: CreateAccessPointCommand = {
    idempotencyKey: createKey,
    ownerId: audit.actor.actorId,
    scopeRef,
    name: String(body.name ?? "Access Point"),
    description: normalizeAccessPointDescription(body.description),
    apiFamily: String(body.apiFamily ?? "openai-compatible"),
    exposedModel,
    targetModel,
    routing: {
      selector: { id: "direct", behaviorVersion: 1, config: {} },
      targets: [{
        type: targetType,
        targetAccessPointId: targetType === "access-point" ? targetId : null,
        targetProviderId: targetType === "provider-model" ? targetProviderId : null,
        targetProviderModelName: targetType === "provider-model" ? targetProviderModelName : null,
        position: 0,
        status: "enabled",
      }],
    },
    priority: Number(body.priority ?? 100),
    weight: Number(body.weight ?? 1),
    fallbackOrder: Number(body.fallbackOrder ?? 100),
    ...(body.status ? { status: String(body.status) } : {})
  };
  const created = await createAccessPoint(createCommand, audit);
  try {
    await billing.configureInitialAccessPointPrice(created.id, { price: priceInputFromBody(body.salePrice) }, audit);
  } catch (error) {
    throw new RelayError("access_point_price_configuration_failed", `AccessPoint ${created.id} was created disabled, but its initial price was not configured. Retry the same create action with the same Idempotency-Key.`, 409, {
      accessPointId: created.id,
      pricingConfigured: false,
      retryAction: "retry_create_access_point_with_same_idempotency_key",
      errorCode: error instanceof RelayError ? error.code : "price_configuration_failed",
    });
  }
  const result = await modelAccessQueries.getAccessPointWithRouting(created.id);
  if (!result) throw new RelayError("access_point_not_found", `AccessPoint ${created.id} not found`, 404);
  return result;
}

function normalizeAccessPointTargetType(value: unknown): AccessPointTargetType {
  if (value === "access-point") return "access-point";
  return "provider-model";
}

function requiredString(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new RelayError("invalid_access_point", `${field} is required`, 400);
  return text;
}

function priceInputFromBody(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new RelayError("invalid_sale_price", "salePrice must be an object", 400);
  const price = value as Record<string, unknown>;
  return {
    inputPer1M: requiredPriceNumber(price.inputPer1M, "salePrice.inputPer1M"),
    cachedInputPer1M: requiredPriceNumber(price.cachedInputPer1M, "salePrice.cachedInputPer1M"),
    cacheWritePer1M: cacheWritePriceNumber(price.cacheWritePer1M, price.inputPer1M, "salePrice.cacheWritePer1M"),
    outputPer1M: requiredPriceNumber(price.outputPer1M, "salePrice.outputPer1M")
  };
}

function requiredPriceNumber(value: unknown, field: string): number {
  if (value === undefined || value === null || value === "") throw new RelayError("invalid_access_point_price", `${field} is required`, 400);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RelayError("invalid_access_point_price", `${field} must be a finite number`, 400);
  return number;
}

function cacheWritePriceNumber(value: unknown, fallbackInput: unknown, field: string): number | null {
  if (value === null) return null;
  return requiredPriceNumber(value === undefined ? fallbackInput : value, field);
}
