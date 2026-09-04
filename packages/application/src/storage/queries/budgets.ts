import type * as applicationModels from "../application-model-contracts.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type PageResult } from "./pagination.js";

export type BudgetPolicy = applicationModels.BudgetPoliciesRow;
export type GovernanceBudgetPolicy = applicationModels.GovernanceBudgetPoliciesRow;
export interface GovernanceBudgetAssignmentRow {
  id: string;
  scopeRef: string;
  governanceBudgetPolicyId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  governanceBudgetPolicy: GovernanceBudgetPolicy;
}

export interface BudgetPolicyDirectoryInput {
  page?: number;
  pageSize?: number;
  query?: string;
  status?: string;
}

export interface BudgetPolicyCandidate {
  id: string;
  metric: string;
  limitValue: number;
  windowType: string;
  windowSeconds: number | null;
  status: string;
}

export interface DirectBudgetAssignmentRow {
  id: string;
  scopeRef: string;
  budgetPolicyId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
  userId: string | null;
  policy: BudgetPolicy;
}
