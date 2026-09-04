import type { IdentityQueries } from "@frely/identity/server";
import type { TenancyQueries } from "./server.js";
import {
  teamMembershipRoles,
  type AsyncApplicationOperationPort,
  type DirectoryPageSize,
  type ManagementPermissionAction,
  type ApplicationOperationPort,
  type TeamMemberSummary,
} from "@frely/application/runtime";

export type TeamAudiencePermissionCheck = (
  teamId: string,
  action: ManagementPermissionAction,
) => boolean;

export type TeamAudienceAsyncApplicationOperationPort = Pick<AsyncApplicationOperationPort,
  | "pageTeamMemberSummaries"
  | "getTeamMemberSummary"
  | "getUserApiKeyDirectoryMetrics"
  | "usageSummary"
  | "findActivePlanSubscriptions"
  | "getPlan"
  | "listPlanBudgetLimitsForPlans"
>;

export type TeamAudienceApplicationOperationPort = Pick<ApplicationOperationPort,
  | "pageTeamMemberSummaries"
  | "getTeamMemberSummary"
  | "getUserApiKeyDirectoryMetrics"
  | "usageSummary"
  | "getActivePlanIdentity"
  | "getPrimarySubscriptionAmountLimit"
>;

export interface TeamAudienceSummary {
  initials: string;
  name: string;
  id: string;
  ownerId: string;
  status: string;
  members: string;
  usage: number;
  planName: string;
  planState: string;
  planWindow: string;
  planEffectiveStart: string | null;
  planEffectiveEnd: string | null;
  budget: string;
  budgetState: string;
  accessCoverage: string;
  canManageMemberApiKeyLimit: boolean;
  canManageMemberCredit: boolean;
  teamOwnerCanCreateCustomProvider: boolean;
  teamOwnerCanCreateAccessPoint: boolean;
  createdAt: string;
  createdAtIso: string;
}

export interface TeamAudienceMember {
  id: string;
  teamId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  apiKeys: string;
  apiKeyLimit: number;
  lastSeen: "Restricted";
  lastSeenAt: null;
  createdAt: string;
  createdAtIso: string;
}

export interface TeamAudienceViewModel {
  audience: {
    userId: string;
    teamId: string;
    perspective: "teamOwner" | "member";
  };
  availableTeam: {
    id: string;
    name: string;
    ownerId: string;
    role: string;
    status: "Active";
  };
  team: TeamAudienceSummary;
  members: {
    items: TeamAudienceMember[];
    page: number;
    pageSize: DirectoryPageSize;
    total: number;
    totalPages: number;
  } | null;
  capabilities: {
    canReadMembers: boolean;
    canReadUsage: boolean;
    canReadBilling: boolean;
    canUpdateMembers: boolean;
  };
}

export function loadTeamAudience(input: {
  repo: TeamAudienceApplicationOperationPort;
  identity: Pick<ApplicationOperationPort, "getUser">;
  tenancy: Pick<ApplicationOperationPort, "getTeam" | "getTeamMembership">;
  teamId: string;
  viewerUserId: string;
  memberPage?: number;
  memberPageSize?: DirectoryPageSize;
  hasPermission: TeamAudiencePermissionCheck;
}): TeamAudienceViewModel | null {
  const { repo, identity, tenancy, teamId, viewerUserId, hasPermission } = input;
  const team = tenancy.getTeam(teamId);
  const viewer = identity.getUser(viewerUserId);
  if (!team || team.status !== "enabled" || !viewer || viewer.status !== "enabled" || !hasPermission(teamId, "team.read")) return null;

  const membership = tenancy.getTeamMembership(teamId, viewerUserId);
  const isTeamOwner = team.ownerId === viewerUserId;
  if (!isTeamOwner && !membership) return null;

  const canReadMembers = hasPermission(teamId, "team.member.read");
  const canReadUsage = hasPermission(teamId, "team.usage.read");
  const canReadBilling = hasPermission(teamId, "team.billing.read");
  const canUpdateMembers = hasPermission(teamId, "team.member.update");
  const memberPage = canReadMembers
    ? repo.pageTeamMemberSummaries(teamId, input.memberPage, input.memberPageSize)
    : restrictedMemberPage(repo, identity, teamId, viewerUserId, input.memberPageSize ?? 20);
  const usage = canReadUsage ? repo.usageSummary({ teamId }) : null;
  const activePlan = canReadBilling ? activePlanSummary(repo, teamId) : null;
  const usagePercent = usage && activePlan
    ? usagePercentForBudget(usage.calculatedCost, activePlan.budgetLimit)
    : 0;

  return {
    audience: {
      userId: viewerUserId,
      teamId,
      perspective: isTeamOwner ? "teamOwner" : "member",
    },
    availableTeam: {
      id: team.id,
      name: team.name,
      ownerId: team.ownerId,
      role: isTeamOwner ? "Owner" : teamMembershipRoles(membership).map(titleCase).join(", "),
      status: "Active",
    },
    team: {
      initials: initialsForName(team.name),
      name: team.name,
      id: team.id,
      ownerId: team.ownerId,
      status: "Active",
      members: canReadMembers ? String(memberPage.total) : "Restricted",
      usage: usagePercent,
      planName: activePlan?.planName ?? "Hidden",
      planState: activePlan?.planState ?? "Restricted",
      planWindow: activePlan?.planWindow ?? "No permission",
      planEffectiveStart: activePlan?.effectiveStart ?? null,
      planEffectiveEnd: activePlan?.effectiveEnd ?? null,
      budget: activePlan ? formatBudget(activePlan.budgetLimit) : "Hidden",
      budgetState: activePlan ? budgetState(team.status, usagePercent, activePlan.budgetLimit) : "Restricted",
      accessCoverage: "Owner only",
      canManageMemberApiKeyLimit: Boolean(team.teamOwnerCanManageMemberApiKeyLimit),
      canManageMemberCredit: Boolean(team.teamOwnerCanManageMemberCredit),
      teamOwnerCanCreateCustomProvider: Boolean(team.teamOwnerCanCreateCustomProvider),
      teamOwnerCanCreateAccessPoint: Boolean(team.teamOwnerCanCreateAccessPoint),
      createdAt: formatUtcDate(team.createdAt),
      createdAtIso: team.createdAt,
    },
    members: {
      items: memberPage.items.map((member) => audienceMember(tenancy, teamId, team.ownerId, member)),
      page: memberPage.page,
      pageSize: memberPage.pageSize,
      total: memberPage.total,
      totalPages: memberPage.totalPages,
    },
    capabilities: {
      canReadMembers,
      canReadUsage,
      canReadBilling,
      canUpdateMembers,
    },
  };
}

export async function loadTeamAudienceAsync(input: {
  repo: TeamAudienceAsyncApplicationOperationPort;
  identity: Pick<IdentityQueries, "getUser">;
  tenancy: Pick<TenancyQueries, "getTeam" | "getMembership">;
  teamId: string;
  viewerUserId: string;
  memberPage?: number;
  memberPageSize?: DirectoryPageSize;
  hasPermission: (teamId: string, action: ManagementPermissionAction) => Promise<boolean>;
}): Promise<TeamAudienceViewModel | null> {
  const { repo, identity, tenancy, teamId, viewerUserId, hasPermission } = input;
  const [team, viewer, membership, canReadTeam] = await Promise.all([
    tenancy.getTeam(teamId),
    identity.getUser(viewerUserId),
    tenancy.getMembership(teamId, viewerUserId),
    hasPermission(teamId, "team.read"),
  ]);
  if (!team || team.status !== "enabled" || !viewer || viewer.status !== "enabled" || !canReadTeam) return null;

  const isTeamOwner = team.ownerId === viewerUserId;
  if (!isTeamOwner && !membership) return null;
  const [canReadMembers, canReadUsage, canReadBilling, canUpdateMembers] = await Promise.all([
    hasPermission(teamId, "team.member.read"),
    hasPermission(teamId, "team.usage.read"),
    hasPermission(teamId, "team.billing.read"),
    hasPermission(teamId, "team.member.update"),
  ]);
  const memberPage = canReadMembers
    ? await repo.pageTeamMemberSummaries(teamId, input.memberPage, input.memberPageSize)
    : await restrictedMemberPageAsync(repo, identity, teamId, viewerUserId, input.memberPageSize ?? 20);
  const [usage, activePlan] = await Promise.all([
    canReadUsage ? repo.usageSummary({ teamId }) : Promise.resolve(null),
    canReadBilling ? activePlanSummaryAsync(repo, teamId) : Promise.resolve(null),
  ]);
  const usagePercent = usage && activePlan
    ? usagePercentForBudget(usage.calculatedCost, activePlan.budgetLimit)
    : 0;

  return {
    audience: {
      userId: viewerUserId,
      teamId,
      perspective: isTeamOwner ? "teamOwner" : "member",
    },
    availableTeam: {
      id: team.id,
      name: team.name,
      ownerId: team.ownerId,
      role: isTeamOwner ? "Owner" : teamMembershipRoles(membership).map(titleCase).join(", "),
      status: "Active",
    },
    team: {
      initials: initialsForName(team.name),
      name: team.name,
      id: team.id,
      ownerId: team.ownerId,
      status: "Active",
      members: canReadMembers ? String(memberPage.total) : "Restricted",
      usage: usagePercent,
      planName: activePlan?.planName ?? "Hidden",
      planState: activePlan?.planState ?? "Restricted",
      planWindow: activePlan?.planWindow ?? "No permission",
      planEffectiveStart: activePlan?.effectiveStart ?? null,
      planEffectiveEnd: activePlan?.effectiveEnd ?? null,
      budget: activePlan ? formatBudget(activePlan.budgetLimit) : "Hidden",
      budgetState: activePlan ? budgetState(team.status, usagePercent, activePlan.budgetLimit) : "Restricted",
      accessCoverage: "Owner only",
      canManageMemberApiKeyLimit: Boolean(team.teamOwnerCanManageMemberApiKeyLimit),
      canManageMemberCredit: Boolean(team.teamOwnerCanManageMemberCredit),
      teamOwnerCanCreateCustomProvider: Boolean(team.teamOwnerCanCreateCustomProvider),
      teamOwnerCanCreateAccessPoint: Boolean(team.teamOwnerCanCreateAccessPoint),
      createdAt: formatUtcDate(team.createdAt),
      createdAtIso: team.createdAt,
    },
    members: {
      items: memberPage.items.map((member) => audienceMemberFromSummary(teamId, team.ownerId, member)),
      page: memberPage.page,
      pageSize: memberPage.pageSize,
      total: memberPage.total,
      totalPages: memberPage.totalPages,
    },
    capabilities: {
      canReadMembers,
      canReadUsage,
      canReadBilling,
      canUpdateMembers,
    },
  };
}

function restrictedMemberPage(repo: TeamAudienceApplicationOperationPort, identity: Pick<ApplicationOperationPort, "getUser">, teamId: string, viewerUserId: string, pageSize: DirectoryPageSize): {
  items: TeamMemberSummary[];
  page: 1;
  pageSize: DirectoryPageSize;
  total: number;
  totalPages: 1;
} {
  const summary = repo.getTeamMemberSummary(teamId, viewerUserId);
  if (summary) return { items: [summary], page: 1, pageSize, total: 1, totalPages: 1 };
  const user = identity.getUser(viewerUserId);
  if (!user) return { items: [], page: 1, pageSize, total: 0, totalPages: 1 };
  return {
    items: [{
      id: user.id,
      email: user.email,
      status: user.status,
      apiKeyLimit: user.apiKeyLimit,
      createdAt: user.createdAt,
      membershipRolesJson: "[]",
      apiKeyCount: repo.getUserApiKeyDirectoryMetrics(user.id).totalKeys,
      lastSeenAt: null,
      isPlatformOwner: 0,
    }],
    page: 1,
    pageSize,
    total: 1,
    totalPages: 1,
  };
}

async function restrictedMemberPageAsync(repo: TeamAudienceAsyncApplicationOperationPort, identity: Pick<IdentityQueries, "getUser">, teamId: string, viewerUserId: string, pageSize: DirectoryPageSize): Promise<{
  items: TeamMemberSummary[];
  page: 1;
  pageSize: DirectoryPageSize;
  total: number;
  totalPages: 1;
}> {
  const summary = await repo.getTeamMemberSummary(teamId, viewerUserId);
  if (summary) return { items: [summary], page: 1, pageSize, total: 1, totalPages: 1 };
  const user = await identity.getUser(viewerUserId);
  if (!user) return { items: [], page: 1, pageSize, total: 0, totalPages: 1 };
  return {
    items: [{
      id: user.id,
      email: user.email,
      status: user.status,
      apiKeyLimit: user.apiKeyLimit,
      createdAt: user.createdAt,
      membershipRolesJson: "[]",
      apiKeyCount: (await repo.getUserApiKeyDirectoryMetrics(user.id)).totalKeys,
      lastSeenAt: null,
      isPlatformOwner: 0,
    }],
    page: 1,
    pageSize,
    total: 1,
    totalPages: 1,
  };
}

function audienceMember(
  tenancy: Pick<ApplicationOperationPort, "getTeamMembership">,
  teamId: string,
  ownerId: string,
  member: TeamMemberSummary,
): TeamAudienceMember {
  return {
    id: member.id,
    teamId,
    name: displayNameFromEmail(member.email),
    email: member.email,
    role: member.id === ownerId
      ? "Owner"
      : teamMembershipRoles(tenancy.getTeamMembership(teamId, member.id)).map(titleCase).join(", "),
    status: displayStatus(member.status),
    apiKeys: String(member.apiKeyCount),
    apiKeyLimit: member.apiKeyLimit,
    lastSeen: "Restricted",
    lastSeenAt: null,
    createdAt: formatUtcDate(member.createdAt),
    createdAtIso: member.createdAt,
  };
}

function audienceMemberFromSummary(teamId: string, ownerId: string, member: TeamMemberSummary): TeamAudienceMember {
  return {
    id: member.id,
    teamId,
    name: displayNameFromEmail(member.email),
    email: member.email,
    role: member.id === ownerId
      ? "Owner"
      : teamMembershipRoles({ rolesJson: member.membershipRolesJson }).map(titleCase).join(", "),
    status: displayStatus(member.status),
    apiKeys: String(member.apiKeyCount),
    apiKeyLimit: member.apiKeyLimit,
    lastSeen: "Restricted",
    lastSeenAt: null,
    createdAt: formatUtcDate(member.createdAt),
    createdAtIso: member.createdAt,
  };
}

function activePlanSummary(repo: TeamAudienceApplicationOperationPort, teamId: string) {
  const active = repo.getActivePlanIdentity([`team:${teamId}`]);
  if (!active) {
    return {
      planName: "No active plan",
      planState: "Missing",
      planWindow: `team:${teamId}`,
      effectiveStart: null as string | null,
      effectiveEnd: null as string | null,
      budgetLimit: null as number | null,
    };
  }
  const policy = repo.getPrimarySubscriptionAmountLimit(active.planId);
  return {
    planName: active.planName,
    planState: "Applied",
    planWindow: `${formatUtcDateTime(active.effectiveStart)} - ${active.effectiveEnd ? formatUtcDateTime(active.effectiveEnd) : "No end"}`,
    effectiveStart: active.effectiveStart,
    effectiveEnd: active.effectiveEnd,
    budgetLimit: policy?.limitValue ?? null,
  };
}

async function activePlanSummaryAsync(repo: TeamAudienceAsyncApplicationOperationPort, teamId: string) {
  const active = (await repo.findActivePlanSubscriptions(`team:${teamId}`))[0];
  if (!active) {
    return {
      planName: "No active plan",
      planState: "Missing",
      planWindow: `team:${teamId}`,
      effectiveStart: null as string | null,
      effectiveEnd: null as string | null,
      budgetLimit: null as number | null,
    };
  }
  const plan = await repo.getPlan(active.planId);
  if (!plan) return null;
  const limits = (await repo.listPlanBudgetLimitsForPlans([plan.id])).get(plan.id) ?? [];
  const policy = limits.find((limit) => limit.limitScope === "subscription" && limit.metric === "amount");
  return {
    planName: plan.name,
    planState: "Applied",
    planWindow: `${formatUtcDateTime(active.effectiveStart)} - ${active.effectiveEnd ? formatUtcDateTime(active.effectiveEnd) : "No end"}`,
    effectiveStart: active.effectiveStart,
    effectiveEnd: active.effectiveEnd,
    budgetLimit: policy?.limitValue ?? null,
  };
}

function usagePercentForBudget(cost: number, amountLimit: number | null): number {
  if (!amountLimit || amountLimit <= 0) return 0;
  return Math.min(100, Math.round((cost / amountLimit) * 100));
}

function budgetState(teamStatus: string, usagePercent: number, amountLimit: number | null): string {
  if (teamStatus !== "enabled") return "Inactive";
  if (!amountLimit || amountLimit <= 0) return "No Cap";
  if (usagePercent >= 100) return "Hard Stop";
  if (usagePercent >= 90) return "Critical";
  if (usagePercent >= 70) return "Warning";
  return "Within Limit";
}

function formatBudget(value: number | null): string {
  return value === null ? "No amount cap" : new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 6 : 2,
  }).format(value);
}

function formatUtcDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function formatUtcDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function displayStatus(value: string): string {
  return value === "enabled" ? "Active" : titleCase(value);
}

function displayNameFromEmail(email: string): string {
  return email.split("@")[0]?.split(/[._-]/).filter(Boolean).map(titleCase).join(" ") || email;
}

function initialsForName(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "T";
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
