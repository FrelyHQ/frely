import type * as applicationModels from "../application-model-contracts.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type CursorPageResult, type PageResult } from "./pagination.js";

export type AuthorityProduct = applicationModels.AuthorityProductsRow;
export interface UserAuthorityGrantRow {
  id: string;
  sourceKind: string;
  productCode: string | null;
  productVersion: number | null;
  effectiveStart: string;
  effectiveEnd: string | null;
  lifecycle: string;
  capabilityCode: string;
  grantedUnits: number;
  usedUnits: number;
  availableUnits: number;
}
export interface AuthorityProductCandidate { id: string; code: string; version: number; displayName: string; grantDurationSeconds: number; }

export interface TeamProviderEntitlementHistoryRow {
  id: string;
  teamId: string;
  sourceKind: string;
  sourceAuthorityPurchaseId: string | null;
  sourceAuthorityProductId: string | null;
  sourceProductCodeSnapshot: string | null;
  sourceProductVersionSnapshot: number | null;
  sourceProductDisplayNameSnapshot: string | null;
  buyerUserId: string | null;
  issuedByUserId: string | null;
  effectiveStart: string;
  effectiveEnd: string | null;
  lifecycle: string;
  canceledAt: string | null;
  canceledByUserId: string | null;
  cancelReasonCode: string | null;
  createdAt: string;
  buyerEmail: string | null;
  issuedByEmail: string | null;
  canceledByEmail: string | null;
}

export class TeamProviderEntitlementCursorError extends Error {}
