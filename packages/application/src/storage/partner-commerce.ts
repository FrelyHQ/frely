import { createHash } from "node:crypto";
import { createId, nowIso, RelayError, teamScopeRef, type ScopeRef } from "@frely/core";
import type { AuditSource } from "./audit.js";
import type { ApplicationOperationPort } from "./application-operation-port.js";
import type * as applicationModels from "./application-model-contracts.js";

export const SERVICE_FULFILLMENT_EFFECTS = ["partner_team_annual"] as const;
export type ServiceFulfillmentEffect = (typeof SERVICE_FULFILLMENT_EFFECTS)[number];
export type ServicePurchaseIntent = "new" | "renew";
export type ServiceProduct = applicationModels.ServiceProductsRow;
export type ServiceProductListing = applicationModels.ServiceProductListingsRow;
export type ServiceOrder = applicationModels.ServiceOrdersRow;
export type ServiceFulfillment = applicationModels.ServiceFulfillmentsRow;
export type PartnerTeamCreationAllocation = applicationModels.PartnerTeamCreationAllocationsRow;
export type PartnerOperatingEntitlement = applicationModels.PartnerOperatingEntitlementsRow;
export type PartnerOperatingState =
  | { kind: "not_partner" }
  | { kind: "active"; entitlement: PartnerOperatingEntitlement }
  | { kind: "inactive"; latestEffectiveEnd: string | null };

function assertPurchaseIntent(_effect: ServiceFulfillmentEffect, intent: ServicePurchaseIntent, targetPartnerTeamId: string | null): void {
  if (intent === "new" && !targetPartnerTeamId) return;
  if (intent === "renew" && targetPartnerTeamId) return;
  throw new RelayError("service_purchase_intent_invalid", "Annual Partner product requires new without a Team or renew with an existing Partner Team", 400);
}

function normalizedCode(value: string): string {
  const code = requiredText(value, "code", 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(code)) throw new RelayError("service_product_code_invalid", "Service product code contains unsupported characters", 400);
  return code;
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new RelayError("invalid_service_commerce_input", `${name} is required`, 400);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new RelayError("invalid_service_commerce_input", `${name} is too long`, 400);
  return normalized;
}

function optionalText(value: string | null | undefined, maxLength: number): string | null {
  if (value == null || !value.trim()) return null;
  return requiredText(value, "value", maxLength);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new RelayError("invalid_service_commerce_input", `${name} must be a positive safe integer`, 400);
  return Number(value);
}

function validIso(value: string, name: string): string {
  if (Number.isNaN(Date.parse(value))) throw new RelayError("invalid_service_commerce_input", `${name} must be an ISO timestamp`, 400);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
