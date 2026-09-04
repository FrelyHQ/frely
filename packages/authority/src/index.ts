export type AuthorityGrantSourceKind = "product_purchase" | "system_bootstrap" | "control_snapshot";
export type AuthorityGrantLifecycle = "active" | "canceled";
export type AuthorityCapabilityCode = "team.create";

export interface AuthorityGrantRef { readonly id: string; }
export interface AuthorityGrantQuotaRef { readonly id: string; }
export interface AuthorityUseRef { readonly id: string; }

export interface AuthorityGrantSnapshot {
  readonly id: string;
  readonly beneficiaryUserId: string;
  readonly roleDomain: "platform";
  readonly roleCode: "owner" | "creator";
  readonly sourceKind: AuthorityGrantSourceKind;
  readonly sourcePurchaseId: string | null;
  readonly sourceProductCodeSnapshot: string | null;
  readonly sourceProductVersionSnapshot: number | null;
  readonly sourceOriginIdSnapshot: string | null;
  readonly maxCurrentOwnedTeamsSnapshot: number | null;
  readonly maxLifetimeCreatedTeamsSnapshot: number | null;
  readonly issuedByUserId: string | null;
  readonly effectiveStart: string;
  readonly effectiveEnd: string | null;
  readonly lifecycle: AuthorityGrantLifecycle;
  readonly canceledAt: string | null;
  readonly canceledByUserId: string | null;
  readonly cancelReasonCode: string | null;
  readonly createdAt: string;
}

export interface AuthorityGrantQuotaSnapshot {
  readonly id: string;
  readonly grantId: string;
  readonly capabilityCode: AuthorityCapabilityCode;
  readonly grantedUnits: number;
  readonly createdAt: string;
}

export interface AuthorityUseSnapshot {
  readonly id: string;
  readonly grantQuotaId: string;
  readonly unitIndex: number;
  readonly beneficiaryUserId: string;
  readonly operation: AuthorityCapabilityCode;
  readonly idempotencyKeyHash: string;
  readonly requestHash: string;
  readonly targetType: "team";
  readonly targetIdSnapshot: string;
  readonly actorUserId: string;
  readonly createdAt: string;
}

export interface AuthorityRoleDecision {
  readonly userId: string;
  readonly platformRoles: readonly ("owner")[];
  readonly evaluatedAt: string;
}

export interface AuthorityQuotaDecision {
  readonly kind: "available" | "exhausted" | "expired" | "canceled";
  readonly capabilityCode: AuthorityCapabilityCode;
  readonly grantId: string | null;
  readonly grantQuotaId: string | null;
  readonly unitIndex: number | null;
  readonly evaluatedAt: string;
}

export interface UserAuthorityGrantRow {
  readonly id: string;
  readonly sourceKind: string;
  readonly productCode: string | null;
  readonly productVersion: number | null;
  readonly effectiveStart: string;
  readonly effectiveEnd: string | null;
  readonly lifecycle: string;
  readonly capabilityCode: string;
  readonly grantedUnits: number;
  readonly usedUnits: number;
  readonly availableUnits: number;
}

export interface PageResult<T> {
  readonly items: T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

// [L6] Authority owns only platform Grant/Quota/Use. Product, Purchase,
// Refund, prices, balances and settlement remain Billing/Commerce facts.
export const AUTHORITY_CONTEXT_CONTRACT = Object.freeze({
  owner: "authority_grant_quota_use",
  persistence: Object.freeze({ grant: "controlled-lifecycle", quota: "aggregate-state", use: "append-only-fact" }),
  lockOrder: Object.freeze(["principal", "authority-grant", "authority-quota", "authority-use"]),
});
