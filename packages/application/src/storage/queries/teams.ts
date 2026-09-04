import type * as applicationModels from "../application-model-contracts.js";
import type { PageResult, SortDirection } from "./pagination.js";

export type Team = applicationModels.TeamsRow;

export type TeamDirectorySort = "name" | "status" | "members" | "access" | "ownerPermissions" | "createdAt";
export type TeamDirectoryRow = Team & {
  memberCount: number;
  teamAccessCount: number;
  inheritedAccessCount: number;
};
export type TeamDirectoryPage = PageResult<TeamDirectoryRow> & { rows: TeamDirectoryRow[] };
export interface TeamDirectoryMetrics {
  totalTeams: number;
  activeTeams: number;
  activeUsers: number;
  apiKeyCount: number;
  totalTokens: number;
  totalCost: number;
  totalBudget: number;
}
export interface TeamDirectoryInput {
  query?: string;
  page?: number;
  pageSize?: number;
  sort?: TeamDirectorySort;
  direction?: SortDirection;
}
export interface TeamCandidate { id: string; name: string; status: string; }
export interface WebRegistrationTeamCandidate { id: string; name: string; }
export interface WebRegistrationTeamCandidatePage { items: WebRegistrationTeamCandidate[]; nextCursor: string | null; }
export interface TeamProviderPurchaseCandidate {
  id: string;
  name: string;
  role: "Owner" | "Billing";
  permanent: number;
  currentEnd: string | null;
}
export interface UserTeamDirectoryInput { query?: string; page?: number; pageSize?: number; }
export interface UserTeamIdentityRow {
  id: string;
  name: string;
  ownerId: string;
  rolesJson: string;
  status: "enabled";
}
export type UserTeamDirectoryPage = PageResult<UserTeamIdentityRow> & { ownerTeams: number };
export interface UserTeamNavigationSummary { items: UserTeamIdentityRow[]; total: number; }
export interface UserTeamDirectoryFacts {
  memberCounts: Record<string, number>;
  usageTokens: Record<string, number>;
  planNames: Record<string, string>;
}
export interface ResourcePermissionDirectoryRow {
  id: string;
  resourceType: string;
  resourceId: string;
  action: string;
  subjectType: string;
  subjectRef: string;
  subjectRole: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface TeamInviteLinkDirectoryRow {
  id: string;
  teamId: string;
  createdByUserId: string;
  creatorEmail: string | null;
  maxUses: number | null;
  usedCount: number | null;
  activeLimitExempt: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface TeamDetailCounts {
  memberCount: number;
  teamAccessCount: number;
  inheritedAccessCount: number;
}
