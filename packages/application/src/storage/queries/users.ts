import type * as applicationModels from "../application-model-contracts.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type PageResult, type SortDirection } from "./pagination.js";

export type User = applicationModels.UsersRow;
export interface TeamMemberSummary {
  id: string;
  email: string;
  status: string;
  apiKeyLimit: number;
  createdAt: string;
  membershipRolesJson: string;
  apiKeyCount: number;
  lastSeenAt: string | null;
  isPlatformOwner: number;
}

export type OwnerUserDirectorySort = "user" | "team" | "role" | "status" | "apiKeys" | "lastSeen" | "createdAt";
export interface OwnerUserDirectoryInput {
  query?: string;
  page?: number;
  pageSize?: number;
  sort?: OwnerUserDirectorySort;
  direction?: SortDirection;
}
export interface OwnerUserDirectoryRow {
  id: string;
  teamId: string;
  teamName: string;
  email: string;
  status: string;
  adminNote: string | null;
  apiKeyLimit: number;
  userCanCreateCustomProvider: number;
  userCanCreateAccessPoint: number;
  apiKeyCount: number;
  lastSeenAt: string | null;
  createdAt: string;
  isPlatformOwner: number;
  hasTeamRole: number;
  roleDetails: string;
}
export type OwnerUserDirectoryPage = PageResult<OwnerUserDirectoryRow>;
export interface OwnerUserDirectoryMetrics { totalUsers: number; activeUsers: number; totalApiKeys: number; usersWithKeys: number; teamOwners: number; }
export interface UserCandidate { id: string; email: string; status: string; }
export type TeamMemberPage = PageResult<TeamMemberSummary>;

/** Read models for User and Team membership views. */
