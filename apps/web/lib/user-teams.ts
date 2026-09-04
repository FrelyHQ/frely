import { teamMembershipRoles, type UiQueryPort, type DirectoryPageSize, type ManagementPermissionAction, type UiSyncQueryPort, type UserTeamIdentityRow } from "@frely/ui-application/server";
import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";
import type { TeamRow, TeamUserRow } from "@frely/team-console-ui";
import { loadTeamAudience, loadTeamAudienceAsync, type TeamAudienceAsyncApplicationOperationPort } from "@frely/tenancy/audience-server";
import type { IdentityQueries } from "@frely/identity/server";
import type { TenancyQueries } from "@frely/tenancy/server";
import type { UserTeamDirectoryView } from "./user-team-view";
export type { UserTeamDirectoryView } from "./user-team-view";

export interface AvailableUserTeam {
  id: string;
  name: string;
  ownerId: string;
  role: string;
  status: "Active";
}

export interface UserTeamDirectoryRow extends AvailableUserTeam {
  members: string;
  usage: string;
  plan: string;
}

export interface UserTeamDetailView {
  availableTeam: AvailableUserTeam;
  team: TeamRow;
  users: TeamUserRow[];
  memberPage: { page: number; pageSize: DirectoryPageSize; total: number; totalPages: number };
  canReadMembers: boolean;
  canReadUsage: boolean;
  canReadBilling: boolean;
  canUpdateMembers: boolean;
}

export type UserTeamPermissionCheck = (teamId: string, action: ManagementPermissionAction) => boolean;

export interface UserTeamDirectoryState {
  query: string;
  page: number;
  pageSize: TablePageSize;
}

export function availableUserTeam(row: UserTeamIdentityRow, userId: string): AvailableUserTeam {
  const role = row.ownerId === userId
    ? "Owner"
    : teamMembershipRoles(row).map(titleCase).join(", ");
  return { id: row.id, name: row.name, ownerId: row.ownerId, role, status: "Active" };
}

export function userTeamNavigationHref(
  teams: readonly Pick<AvailableUserTeam, "id">[],
  total = teams.length,
): string | null {
  if (total === 0) return null;
  return total === 1 && teams[0] ? `/user/team/${encodeURIComponent(teams[0].id)}` : "/user/team";
}

export function buildUserTeamDirectory(
  repo: UiSyncQueryPort,
  userId: string,
  hasPermission: UserTeamPermissionCheck,
  state: UserTeamDirectoryState,
): UserTeamDirectoryView {
  const page = repo.pageUserTeamDirectory(userId, state);
  const teams = page.items.map((row) => availableUserTeam(row, userId));
  const memberTeamIds = teams.filter((team) => hasPermission(team.id, "team.member.read")).map((team) => team.id);
  const usageTeamIds = teams.filter((team) => hasPermission(team.id, "team.usage.read")).map((team) => team.id);
  const billingTeamIds = teams.filter((team) => hasPermission(team.id, "team.billing.read")).map((team) => team.id);
  const facts = repo.getUserDirectoryFacts({ memberTeamIds, usageTeamIds, billingTeamIds });
  const rows = teams.map((team) => {
    const canReadMembers = hasPermission(team.id, "team.member.read");
    const canReadUsage = hasPermission(team.id, "team.usage.read");
    const canReadBilling = hasPermission(team.id, "team.billing.read");
    return {
      ...team,
      members: canReadMembers ? formatInteger(facts.memberCounts[team.id] ?? 0) : "Restricted",
      usage: canReadUsage ? `${formatInteger(facts.usageTokens[team.id] ?? 0)} tokens` : "Restricted",
      plan: canReadBilling ? facts.planNames[team.id] ?? "No active plan" : "Restricted"
    };
  });

  return {
    query: state.query,
    rows,
    ownerTeams: page.ownerTeams,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
  };
}

export async function buildUserTeamDirectoryAsync(
  repo: Pick<UiQueryPort, "pageUserTeamDirectory" | "getUserDirectoryFacts">,
  userId: string,
  hasPermission: (teamId: string, action: ManagementPermissionAction) => Promise<boolean>,
  state: UserTeamDirectoryState,
): Promise<UserTeamDirectoryView> {
  const page = await repo.pageUserTeamDirectory(userId, state);
  const teams = page.items.map((row) => availableUserTeam(row, userId));
  const memberTeamIds: string[] = [];
  const usageTeamIds: string[] = [];
  const billingTeamIds: string[] = [];
  const permissions = await Promise.all(teams.map(async (team) => ({
    team,
    canReadMembers: await hasPermission(team.id, "team.member.read"),
    canReadUsage: await hasPermission(team.id, "team.usage.read"),
    canReadBilling: await hasPermission(team.id, "team.billing.read"),
  })));
  for (const permission of permissions) {
    if (permission.canReadMembers) memberTeamIds.push(permission.team.id);
    if (permission.canReadUsage) usageTeamIds.push(permission.team.id);
    if (permission.canReadBilling) billingTeamIds.push(permission.team.id);
  }
  const facts = await repo.getUserDirectoryFacts({ memberTeamIds, usageTeamIds, billingTeamIds });
  const rows = permissions.map(({ team, canReadMembers, canReadUsage, canReadBilling }) => ({
    ...team,
    members: canReadMembers ? formatInteger(facts.memberCounts[team.id] ?? 0) : "Restricted",
    usage: canReadUsage ? `${formatInteger(facts.usageTokens[team.id] ?? 0)} tokens` : "Restricted",
    plan: canReadBilling ? facts.planNames[team.id] ?? "No active plan" : "Restricted",
  }));
  return {
    query: state.query,
    rows,
    ownerTeams: page.ownerTeams,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
  };
}

export function buildUserTeamDetailView(
  repo: UiSyncQueryPort,
  identity: Pick<UiSyncQueryPort, "getUser">,
  tenancy: Pick<UiSyncQueryPort, "getTeam" | "getTeamMembership">,
  userId: string,
  teamId: string,
  hasPermission: UserTeamPermissionCheck,
  memberPage = 1,
  memberPageSize: DirectoryPageSize = 20,
): UserTeamDetailView | null {
  const audience = loadTeamAudience({
    repo,
    identity,
    tenancy,
    teamId,
    viewerUserId: userId,
    memberPage,
    memberPageSize,
    hasPermission,
  });
  if (!audience?.members) return null;

  return {
    availableTeam: audience.availableTeam,
    team: audience.team,
    users: audience.members.items,
    memberPage: {
      page: audience.members.page,
      pageSize: audience.members.pageSize,
      total: audience.members.total,
      totalPages: audience.members.totalPages,
    },
    canReadMembers: audience.capabilities.canReadMembers,
    canReadUsage: audience.capabilities.canReadUsage,
    canReadBilling: audience.capabilities.canReadBilling,
    canUpdateMembers: audience.capabilities.canUpdateMembers,
  };
}

export async function buildUserTeamDetailViewAsync(
  repo: TeamAudienceAsyncApplicationOperationPort,
  identity: Pick<IdentityQueries, "getUser">,
  tenancy: Pick<TenancyQueries, "getTeam" | "getMembership">,
  userId: string,
  teamId: string,
  hasPermission: (teamId: string, action: ManagementPermissionAction) => Promise<boolean>,
  memberPage = 1,
  memberPageSize: DirectoryPageSize = 20,
): Promise<UserTeamDetailView | null> {
  const audience = await loadTeamAudienceAsync({
    repo,
    identity,
    tenancy,
    teamId,
    viewerUserId: userId,
    memberPage,
    memberPageSize,
    hasPermission,
  });
  if (!audience?.members) return null;

  return {
    availableTeam: audience.availableTeam,
    team: audience.team,
    users: audience.members.items,
    memberPage: {
      page: audience.members.page,
      pageSize: audience.members.pageSize,
      total: audience.members.total,
      totalPages: audience.members.totalPages,
    },
    canReadMembers: audience.capabilities.canReadMembers,
    canReadUsage: audience.capabilities.canReadUsage,
    canReadBilling: audience.capabilities.canReadBilling,
    canUpdateMembers: audience.capabilities.canUpdateMembers,
  };
}

export function canViewUserTeamMember(
  tenancy: Pick<UiSyncQueryPort, "getTeam" | "getTeamMembership">,
  actorUserId: string,
  targetUserId: string,
  teamId: string,
  hasPermission: UserTeamPermissionCheck
): boolean {
  const team = tenancy.getTeam(teamId);
  if (!team || team.status !== "enabled") return false;
  if (!tenancy.getTeamMembership(teamId, actorUserId)) return false;
  if (!tenancy.getTeamMembership(teamId, targetUserId)) return false;
  return actorUserId === targetUserId || hasPermission(teamId, "team.member.read");
}

export function normalizeUserTeamQuery(value: string): string {
  return value.trim().slice(0, 100);
}

export function userTeamDirectoryState(
  params: Record<string, string | string[] | undefined> | undefined,
): UserTeamDirectoryState {
  return {
    query: normalizeUserTeamQuery(singleValue(params?.q)),
    page: boundedPage(singleValue(params?.page)),
    pageSize: normalizeTablePageSize(params?.pageSize),
  };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function singleValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function boundedPage(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) return 1;
  return Math.min(10_000, Number(value));
}
