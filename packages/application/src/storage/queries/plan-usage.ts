import { RelayError } from "@frely/core";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type DirectoryPageSize } from "./pagination.js";

export type TeamMemberUsageSort = "usage" | "tokens" | "requests" | "member" | "lastUsed";
export type TeamMemberUsageDirection = "asc" | "desc";

export interface TeamSubscriptionCandidateInput {
  teamId: string;
  query: string;
  page: number;
  pageSize: 20;
  calculatedAt: string;
}

export interface TeamSubscriptionCandidate {
  id: string;
  planName: string;
  planVersion: number;
  billingMode: "prepaid" | "paygo";
  effectiveStart: string;
  effectiveEnd: string | null;
}

export interface TeamSubscriptionCandidatePage {
  items: TeamSubscriptionCandidate[];
  page: number;
  pageSize: 20;
  total: number;
  totalPages: number;
}

export interface TeamMemberPlanUsageInput {
  teamId: string;
  subscriptionId: string;
  query: string;
  sort: TeamMemberUsageSort;
  direction: TeamMemberUsageDirection;
  page: number;
  pageSize: DirectoryPageSize;
  calculatedAt: string;
}

export interface TeamMemberPlanUsageItem {
  userId: string;
  email: string;
  roles: string[];
  status: string;
  requestCount: number;
  totalTokens: number;
  billableAmount: number;
  lastUsedAt: string | null;
}

export interface TeamMemberPlanUsageSummary {
  requestCount: number;
  totalTokens: number;
  billableAmount: number;
  currentMemberRequestCount: number;
  currentMemberTokens: number;
  currentMemberBillableAmount: number;
  historicalRequestCount: number;
  historicalTokens: number;
  historicalBillableAmount: number;
}

export interface TeamMemberPlanUsagePage {
  subscription: TeamSubscriptionCandidate;
  periodStart: string;
  periodEnd: string;
  calculatedAt: string;
  summary: TeamMemberPlanUsageSummary;
  items: TeamMemberPlanUsageItem[];
  page: number;
  pageSize: DirectoryPageSize;
  total: number;
  totalPages: number;
}

type SubscriptionRow = TeamSubscriptionCandidate & {
  scopeRef: string;
  planStatus: string;
};

type SummaryRow = {
  requestCount: number;
  totalTokens: number;
  billableAmount: number;
  currentMemberRequestCount: number;
  currentMemberTokens: number;
  currentMemberBillableAmount: number;
  historicalRequestCount: number;
  historicalTokens: number;
  historicalBillableAmount: number;
};

type UsageRow = Omit<TeamMemberPlanUsageItem, "roles"> & { rolesJson: string };
