import { createHash } from "node:crypto";
import {
  AUTHORITY_CANCEL_REASON_CODES,
  AUTHORITY_PRODUCT_LIMITS,
  AUTHORITY_REFUND_REASON_CODES,
  createId,
  isRuntimeScopeRef,
  nowIso,
  parseScopeRef,
  RelayError,
  userScopeRef,
  type AuthorityCancelReasonCode,
  type AuthorityProductEffectCode,
  type AuthorityRefundReasonCode,
  type ScopeRef
} from "@frely/core";
import type { ApplicationOperationPort } from "./application-operation-port.js";
import { teamMembershipRoles } from "./runtime-domain.js";
import type * as applicationModels from "./application-model-contracts.js";

export type AuthorityProduct = applicationModels.AuthorityProductsRow;
export type AuthorityPurchase = applicationModels.AuthorityPurchasesRow;
export type AuthorityGrant = applicationModels.AuthorityGrantsRow;
export type AuthorityGrantQuota = applicationModels.AuthorityGrantQuotasRow;
export type AuthorityUse = applicationModels.AuthorityUsesRow;
export type AuthorityRefund = applicationModels.AuthorityRefundsRow;
export type TeamProviderEntitlement = applicationModels.TeamProviderEntitlementsRow;

export interface AuthorityProductTerms {
  displayName: string;
  effectCode: AuthorityProductEffectCode;
  grantUnits: number;
  purchaseAmountUnits: number;
  grantDurationSeconds: number;
  maxLifetimePurchasesPerUser: number | null;
  maxUnconsumedUnitsPerUser: number | null;
  maxCurrentOwnedTeams: number | null;
  maxLifetimeCreatedTeams: number | null;
  refundMode: "none" | "unused_by_owner";
  refundDeadlineSeconds: number | null;
  settlementHoldSeconds: number;
  sellerScopeRef: ScopeRef;
}

export interface AuthorityPurchaseResult {
  purchase: AuthorityPurchase;
  grant: AuthorityGrant;
  quota: AuthorityGrantQuota;
  replayed: boolean;
}

export interface AuthorityTeamCreateResult {
  use: AuthorityUse;
  targetStatus: "active" | "unavailable";
  replayed: boolean;
}

export interface AuthorityRefundResult {
  refund: AuthorityRefund;
  creditLedgerEventId: string;
  sellerSettlementReversalId: string;
}

export interface AuthorityTeamProviderPurchaseResult {
  purchase: AuthorityPurchase;
  entitlement: TeamProviderEntitlement;
  replayed: boolean;
}

export type TeamProviderEntitlementState =
  | { state: "not_entitled"; entitlement: null; nextEntitlement: null; latestEffectiveEnd: null }
  | { state: "active" | "permanent"; entitlement: TeamProviderEntitlement; nextEntitlement: TeamProviderEntitlement | null; latestEffectiveEnd: string | null }
  | { state: "scheduled"; entitlement: null; nextEntitlement: TeamProviderEntitlement; latestEffectiveEnd: string | null }
  | { state: "expired"; entitlement: null; nextEntitlement: null; latestEffectiveEnd: string | null };

const TEAM_PROVIDER_CANCEL_REASON_CODES = ["security_response", "fraud", "product_correction", "operator_error"] as const;
export type TeamProviderCancelReasonCode = (typeof TEAM_PROVIDER_CANCEL_REASON_CODES)[number];

function validatedTerms(input: AuthorityProductTerms, sellerScopeRef: ScopeRef): AuthorityProductTerms {
  const displayName = requiredText(input.displayName, "displayName", 120);
  if (input.effectCode !== "team_create_unit" && input.effectCode !== "team_custom_provider_access" && input.effectCode !== "user_custom_provider_access") throw new RelayError("authority_product_effect_invalid", "Unsupported Authority Product effect", 400);
  const grantUnits = boundedInteger(input.grantUnits, "grantUnits", { min: 1, max: AUTHORITY_PRODUCT_LIMITS.maxGrantUnits });
  const purchaseAmountUnits = boundedInteger(input.purchaseAmountUnits, "purchaseAmountUnits", { min: 1, max: AUTHORITY_PRODUCT_LIMITS.maxPurchaseAmountUnits });
  const grantDurationSeconds = boundedInteger(input.grantDurationSeconds, "grantDurationSeconds", { min: 1, max: AUTHORITY_PRODUCT_LIMITS.maxGrantDurationSeconds });
  const maxLifetimePurchasesPerUser = optionalBoundedInteger(input.maxLifetimePurchasesPerUser, "maxLifetimePurchasesPerUser", { min: 1, max: AUTHORITY_PRODUCT_LIMITS.maxPurchaseOrUnconsumedLimit });
  const maxUnconsumedUnitsPerUser = optionalBoundedInteger(input.maxUnconsumedUnitsPerUser, "maxUnconsumedUnitsPerUser", { min: 1, max: AUTHORITY_PRODUCT_LIMITS.maxPurchaseOrUnconsumedLimit });
  const maxCurrentOwnedTeams = optionalBoundedInteger(input.maxCurrentOwnedTeams, "maxCurrentOwnedTeams", { min: 1, max: AUTHORITY_PRODUCT_LIMITS.maxTeamLimit });
  const maxLifetimeCreatedTeams = optionalBoundedInteger(input.maxLifetimeCreatedTeams, "maxLifetimeCreatedTeams", { min: 1, max: AUTHORITY_PRODUCT_LIMITS.maxTeamLimit });
  const settlementHoldSeconds = boundedInteger(input.settlementHoldSeconds, "settlementHoldSeconds", { min: 1, max: AUTHORITY_PRODUCT_LIMITS.maxSettlementHoldSeconds });
  if (input.refundMode !== "none" && input.refundMode !== "unused_by_owner") throw new RelayError("authority_refund_mode_invalid", "Unsupported Authority Product refund mode", 400);
  const refundDeadlineSeconds = input.refundDeadlineSeconds === null ? null : boundedInteger(input.refundDeadlineSeconds, "refundDeadlineSeconds", { min: 1, max: AUTHORITY_PRODUCT_LIMITS.maxGrantDurationSeconds });
  if (input.refundMode === "none" && refundDeadlineSeconds !== null) throw new RelayError("authority_refund_terms_invalid", "Non-refundable products cannot define a refund deadline", 400);
  if (input.refundMode === "unused_by_owner" && (refundDeadlineSeconds === null || refundDeadlineSeconds > grantDurationSeconds || refundDeadlineSeconds >= settlementHoldSeconds)) throw new RelayError("authority_refund_terms_invalid", "Refund deadline must not exceed Grant duration and must end before settlement release", 400);
  if (input.effectCode === "team_custom_provider_access" && (
    grantUnits !== 1 || maxUnconsumedUnitsPerUser !== null || maxCurrentOwnedTeams !== null ||
    maxLifetimeCreatedTeams !== null || input.refundMode !== "none"
  )) {
    throw new RelayError("authority_product_terms_invalid", "Team Provider access requires one non-refundable Team entitlement and no Team creation limits", 400);
  }
  if (input.effectCode === "user_custom_provider_access" && (
    grantUnits !== 1 || (maxLifetimePurchasesPerUser !== null && maxLifetimePurchasesPerUser < 2) || maxUnconsumedUnitsPerUser !== null ||
    maxCurrentOwnedTeams !== null || maxLifetimeCreatedTeams !== null || input.refundMode !== "none" || refundDeadlineSeconds !== null ||
    grantDurationSeconds % 86_400 !== 0
  )) {
    throw new RelayError("authority_product_terms_invalid", "Personal Provider access requires one non-refundable slot and a positive integer-day duration", 400);
  }
  return { displayName, effectCode: input.effectCode, grantUnits, purchaseAmountUnits, grantDurationSeconds, maxLifetimePurchasesPerUser, maxUnconsumedUnitsPerUser, maxCurrentOwnedTeams, maxLifetimeCreatedTeams, refundMode: input.refundMode, refundDeadlineSeconds, settlementHoldSeconds, sellerScopeRef };
}

function boundedInteger(value: number, name: string, bounds: { min: number; max: number }): number {
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) throw new RelayError("authority_product_value_invalid", `${name} must be an integer between ${bounds.min} and ${bounds.max}`, 400);
  return value;
}

function optionalBoundedInteger(value: number | null, name: string, bounds: { min: number; max: number }): number | null {
  return value === null ? null : boundedInteger(value, name, bounds);
}

function requiredCode(value: string): string {
  const code = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(code)) throw new RelayError("authority_product_code_invalid", "Authority Product code is invalid", 400);
  return code;
}

function requiredText(value: string, name: string, maxLength: number): string {
  const text = value.trim();
  if (!text || text.length > maxLength) throw new RelayError("authority_text_invalid", `${name} is required and must not exceed ${maxLength} characters`, 400);
  return text;
}

function hashRequired(value: string, name: string): string {
  return sha256(requiredText(value, name, 200));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}
