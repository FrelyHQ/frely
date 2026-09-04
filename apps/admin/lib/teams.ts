import { RelayError } from "@frely/core";
import { creditUnitsToUsd, type UiQueryPort, type UiSyncQueryPort, type Team, type TeamDeletionLifecycle, type TeamDeleteBlocker, type TeamDirectorySort, type TeamDirectorySortDirection, type TeamPlanStatusFilter } from "@frely/ui-application/server";
import type { ConsoleApiKey, ConsoleCreditDetail, ConsoleUser } from "@frely/console-ui";
import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";
import type { TeamAccessPointRow, TeamPlanRow, TeamRow, TeamUserRow } from "@frely/team-console-ui";
import { formatUtcDate as formatDate, formatUtcDateTime as formatDateTime } from "@frely/ui/lib/date-time";
import { loadUserAudience, loadUserAudienceAsync } from "@frely/tenancy/audience-server";
import type { AuthorityQueries } from "@frely/authority/server";
import type { IdentityQueries } from "@frely/identity/server";
import type { TenancyQueries } from "@frely/tenancy/server";

type SyncIdentityTenancyReaders = {
  identity: Pick<UiSyncQueryPort, "getUser" | "listUsers" | "listApiKeys">;
  authority: Pick<UiSyncQueryPort, "platformRolesForUser">;
  tenancy: Pick<UiSyncQueryPort, "getTeam" | "listTeams" | "getTeamMembership" | "listAvailableTeamMemberships" | "listEffectiveSubscriptionScopesForUser" | "teamRolesForUser">;
};
type AsyncIdentityTenancyReaders = {
  identity: Pick<IdentityQueries, "getUser">;
  authority: Pick<AuthorityQueries, "platformRolesForUser">;
  tenancy: Pick<TenancyQueries, "getTeam" | "getMembership" | "teamRolesForUser">;
};

type Tone = "good" | "warn" | "bad";

export interface TeamsMetric {
  label: string;
  value: string;
  detail: string;
  tone?: Tone;
}

export interface AdminTeamRow extends TeamRow {
  statusTone: Tone;
  usageTone: Tone;
  deleteBlockers: TeamDeleteBlocker[];
  deletionLifecycle: TeamDeletionLifecycle | null;
}

export type AdminTeamDirectoryRow = Omit<
  AdminTeamRow,
  "usage" | "usageTone" | "planName" | "planState" | "planWindow" | "planEffectiveStart" | "planEffectiveEnd" | "budget" | "budgetState"
>;

export const ADMIN_TEAMS_PAGE_SIZE = 20;

export interface AdminTeamsSearchState {
  query: string;
  page: number;
  pageSize: TablePageSize;
  sort: TeamDirectorySort;
  direction: TeamDirectorySortDirection;
}

export interface AdminTeamsAggregate {
  metrics: TeamsMetric[];
  rows: AdminTeamDirectoryRow[];
  query: string;
  page: number;
  pageSize: TablePageSize;
  total: number;
  totalPages: number;
  search: AdminTeamsSearchState;
}

export interface AdminTeamDetail {
  team: AdminTeamRow;
  users: TeamUserRow[];
  membershipRoles: Array<{ userId: string; email: string; roles: string[] }>;
  accessPoints: TeamAccessPointRow[];
  plans: TeamPlanRow[];
  pages: {
    users: DetailPageMetadata;
    accessPoints: DetailPageMetadata;
    plans: DetailPageMetadata;
  };
}

export interface DetailPageMetadata {
  page: number;
  pageSize: TablePageSize;
  total: number;
  totalPages: number;
}

export interface AdminTeamDetailInput {
  userPage?: number;
  userPageSize?: TablePageSize;
  accessPointPage?: number;
  accessPointPageSize?: TablePageSize;
  planPage?: number;
  planPageSize?: TablePageSize;
  planStatus?: TeamPlanStatusFilter;
  audienceMemberId?: string;
}

export interface OwnerUserOverviewRow extends ConsoleUser {
  teamName: string;
  statusTone: Tone;
  adminNote: string | null;
  roleDetails: string;
}

export interface OwnerUserDetailModel extends ConsoleUser {
  adminNote: string | null;
  roleDetails: string;
  isPlatformOwner: boolean;
}

export interface OwnerUserDetailAggregate {
  user: OwnerUserDetailModel;
  apiKeys: ConsoleApiKey[];
  apiKeyPage: {
    page: number;
    pageSize: TablePageSize;
    total: number;
    totalPages: number;
  };
  apiKeySummary: {
    totalKeys: number;
    activeKeys: number;
    disabledKeys: number;
    peakUsagePercent: number;
  };
  credit: ConsoleCreditDetail;
}

export interface OwnerUsersAggregate {
  metrics: TeamsMetric[];
  rows: OwnerUserOverviewRow[];
  query: string;
}

export interface OwnerUsersPageAggregate extends OwnerUsersAggregate {
  page: number;
  pageSize: TablePageSize;
  total: number;
  totalPages: number;
}

export interface AdminApiKeyOverviewRow extends ConsoleApiKey {
  scopeSummary: string;
  userName: string;
  userEmail: string;
  statusTone: Tone;
  usageTone: Tone;
}

export interface AdminKeysAggregate {
  metrics: TeamsMetric[];
  rows: AdminApiKeyOverviewRow[];
  query: string;
}

export interface AdminKeysPageAggregate extends AdminKeysAggregate {
  page: number;
  pageSize: TablePageSize;
  total: number;
  totalPages: number;
}

export interface AdminCreditUserRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  teamId: string;
  teamName: string;
  accountId: string;
  balance: string;
  balanceValue: number;
  transferOutEnabled: boolean;
  accountStatus: string;
  latestLedgerAt: string;
  latestLedgerAtIso: string | null;
}

export interface AdminCreditsAggregate {
  metrics: TeamsMetric[];
  rows: AdminCreditUserRow[];
  query: string;
  scopeSummary: Array<{ id: string; scopeRef: string; balance: string; status: string; latestLedgerAt: string; latestLedgerAtIso: string | null }>;
  page: number;
  pageSize: TablePageSize;
  total: number;
  totalPages: number;
  scopePage: number;
  scopePageSize: TablePageSize;
  scopeTotal: number;
  scopeTotalPages: number;
}

export function parseAdminTeamsSearch(params?: Record<string, string | string[] | undefined>, strict = false): AdminTeamsSearchState {
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  const rawPage = one(params?.page);
  const rawPageSize = one(params?.pageSize);
  const rawSort = one(params?.sort);
  const rawDirection = one(params?.direction).toLowerCase();
  const allowedSorts: TeamDirectorySort[] = ["name", "status", "members", "access", "ownerPermissions", "createdAt"];
  if (strict && rawPage && !/^\d+$/.test(rawPage)) throw new RelayError("invalid_pagination", "page must be a positive integer", 400);
  if (strict && rawPageSize && (!/^\d+$/.test(rawPageSize) || normalizeTablePageSize(rawPageSize) !== Number(rawPageSize))) throw new RelayError("invalid_pagination", "pageSize must be an integer from 1 to 200", 400);
  if (strict && rawSort && !allowedSorts.includes(rawSort as TeamDirectorySort)) throw new RelayError("invalid_sort", "Unsupported Team directory sort", 400);
  if (strict && rawDirection && rawDirection !== "asc" && rawDirection !== "desc") throw new RelayError("invalid_sort_direction", "direction must be asc or desc", 400);
  return {
    query: one(params?.q).toLowerCase().slice(0, 100),
    page: /^\d+$/.test(rawPage) ? Math.max(1, Math.min(10_000, Number(rawPage))) : 1,
    pageSize: normalizeTablePageSize(rawPageSize),
    sort: allowedSorts.includes(rawSort as TeamDirectorySort) ? rawSort as TeamDirectorySort : "createdAt",
    direction: rawDirection === "desc" ? "desc" : "asc"
  };
}

export function adminTeamsHref(state: AdminTeamsSearchState, overrides: Partial<AdminTeamsSearchState> = {}) {
  const next = { ...state, ...overrides };
  const params = new URLSearchParams();
  if (next.query) params.set("q", next.query);
  if (next.page > 1) params.set("page", String(next.page));
  if (next.pageSize !== 20) params.set("pageSize", String(next.pageSize));
  if (next.sort !== "createdAt") params.set("sort", next.sort);
  if (next.direction !== "asc") params.set("direction", next.direction);
  const query = params.toString();
  return `/owner/teams${query ? `?${query}` : ""}`;
}

export function buildAdminTeamsAggregate(repo: UiSyncQueryPort, search: AdminTeamsSearchState = parseAdminTeamsSearch()): AdminTeamsAggregate {
  const page = repo.pageAdminTeamDirectory({
    query: search.query,
    page: search.page,
    pageSize: search.pageSize,
    sort: search.sort,
    direction: search.direction
  });
  const blockers = repo.listTeamDeleteBlockersForTeams(page.rows.map((team) => team.id));
  const rows: AdminTeamDirectoryRow[] = page.rows.map((team) => {
    const status = repo.getActiveTeamDeletion?.(team.id) ? "Soft deleted" : displayStatus(team.status);
    return {
      initials: initialsForName(team.name),
      name: team.name,
      id: team.id,
      ownerId: team.ownerId,
      status,
      statusTone: status === "Active" ? "good" : "warn",
      members: String(team.memberCount),
      accessCoverage: accessCoverage(team.teamAccessCount, team.inheritedAccessCount),
      canManageMemberApiKeyLimit: Boolean(team.teamOwnerCanManageMemberApiKeyLimit),
      canManageMemberCredit: Boolean(team.teamOwnerCanManageMemberCredit),
      teamOwnerCanCreateCustomProvider: Boolean(team.teamOwnerCanCreateCustomProvider),
      teamOwnerCanCreateAccessPoint: Boolean(team.teamOwnerCanCreateAccessPoint),
      deleteBlockers: blockers.get(team.id) ?? [],
      deletionLifecycle: repo.getActiveTeamDeletion?.(team.id) ?? null,
      createdAt: formatDate(team.createdAt),
      createdAtIso: team.createdAt
    };
  });
  const snapshot = repo.getAdminTeamDirectoryMetrics();
  const totalTokens = snapshot.totalTokens;
  const totalBudget = snapshot.totalBudget;
  const totalCost = snapshot.totalCost;
  const budgetUsagePercent = totalBudget > 0 ? Math.min(100, (totalCost / totalBudget) * 100) : 0;

  return {
    metrics: [
      {
        label: "Total Teams",
        value: String(snapshot.totalTeams),
        detail: `${snapshot.activeTeams} enabled`,
        ...(snapshot.totalTeams > 0 ? { tone: "good" as const } : {})
      },
      {
        label: "Active Members",
        value: formatInteger(snapshot.activeUsers),
        detail: `${formatInteger(snapshot.apiKeyCount)} API keys`,
        ...(snapshot.activeUsers > 0 ? { tone: "good" as const } : {})
      },
      {
        label: "Avg. Token Burn",
        value: snapshot.totalTeams > 0 ? formatCompactNumber(totalTokens / snapshot.totalTeams) : "0",
        detail: `${formatCompactNumber(totalTokens)} total`,
        ...(totalTokens > 0 ? { tone: "warn" as const } : {})
      },
      {
        label: "Budget Usage",
        value: totalBudget > 0 ? formatPercent(budgetUsagePercent) : "No cap",
        detail: totalBudget > 0 ? `${formatCurrency(totalCost)} of ${formatCurrency(totalBudget)}` : "No team amount caps",
        tone: budgetUsagePercent >= 90 ? "bad" : budgetUsagePercent >= 70 ? "warn" : "good"
      }
    ],
    rows,
    query: search.query,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
    search: { ...search, page: page.page }
  };
}

export async function buildAdminTeamsAggregateAsync(
  repo: UiQueryPort,
  search: AdminTeamsSearchState = parseAdminTeamsSearch(),
): Promise<AdminTeamsAggregate> {
  const [page, snapshot] = await Promise.all([
    repo.pageAdminTeamDirectory({
      query: search.query,
      page: search.page,
      pageSize: search.pageSize,
      sort: search.sort,
      direction: search.direction,
    }),
    repo.getAdminTeamDirectoryMetrics(),
  ]);
  const [blockers, deletionLifecycles] = await Promise.all([
    repo.listTeamDeleteBlockersForTeams(page.rows.map((team) => team.id)),
    Promise.all(page.rows.map(async (team) => [team.id, await repo.getActiveTeamDeletion(team.id)] as const)),
  ]);
  const deletions = new Map(deletionLifecycles);
  const rows: AdminTeamDirectoryRow[] = page.rows.map((team) => {
    const deletionLifecycle = deletions.get(team.id) ?? null;
    const status = deletionLifecycle ? "Soft deleted" : displayStatus(team.status);
    return {
      initials: initialsForName(team.name),
      name: team.name,
      id: team.id,
      ownerId: team.ownerId,
      status,
      statusTone: status === "Active" ? "good" : "warn",
      members: String(team.memberCount),
      accessCoverage: accessCoverage(team.teamAccessCount, team.inheritedAccessCount),
      canManageMemberApiKeyLimit: Boolean(team.teamOwnerCanManageMemberApiKeyLimit),
      canManageMemberCredit: Boolean(team.teamOwnerCanManageMemberCredit),
      teamOwnerCanCreateCustomProvider: Boolean(team.teamOwnerCanCreateCustomProvider),
      teamOwnerCanCreateAccessPoint: Boolean(team.teamOwnerCanCreateAccessPoint),
      deleteBlockers: blockers.get(team.id) ?? [],
      deletionLifecycle,
      createdAt: formatDate(team.createdAt),
      createdAtIso: team.createdAt,
    };
  });
  const budgetUsagePercent = snapshot.totalBudget > 0 ? Math.min(100, (snapshot.totalCost / snapshot.totalBudget) * 100) : 0;
  return {
    metrics: [
      { label: "Total Teams", value: String(snapshot.totalTeams), detail: `${snapshot.activeTeams} enabled`, ...(snapshot.totalTeams > 0 ? { tone: "good" as const } : {}) },
      { label: "Active Members", value: formatInteger(snapshot.activeUsers), detail: `${formatInteger(snapshot.apiKeyCount)} API keys`, ...(snapshot.activeUsers > 0 ? { tone: "good" as const } : {}) },
      { label: "Avg. Token Burn", value: snapshot.totalTeams > 0 ? formatCompactNumber(snapshot.totalTokens / snapshot.totalTeams) : "0", detail: `${formatCompactNumber(snapshot.totalTokens)} total`, ...(snapshot.totalTokens > 0 ? { tone: "warn" as const } : {}) },
      { label: "Budget Usage", value: snapshot.totalBudget > 0 ? formatPercent(budgetUsagePercent) : "No cap", detail: snapshot.totalBudget > 0 ? `${formatCurrency(snapshot.totalCost)} of ${formatCurrency(snapshot.totalBudget)}` : "No team amount caps", tone: budgetUsagePercent >= 90 ? "bad" : budgetUsagePercent >= 70 ? "warn" : "good" },
    ],
    rows,
    query: search.query,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
    search: { ...search, page: page.page },
  };
}

export function buildOwnerUsersAggregate(repo: UiSyncQueryPort, contexts: SyncIdentityTenancyReaders, query = ""): OwnerUsersAggregate {
  const teams = contexts.tenancy.listTeams();
  const users = contexts.identity.listUsers();
  const apiKeys = contexts.identity.listApiKeys();
  const lastSeenAtByUser = repo.listLatestRequestStartedAtByUser();
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));

  const rows: OwnerUserOverviewRow[] = users.map((user) => {
    const userKeys = apiKeys.filter((apiKey) => apiKey.userId === user.id);
    const status = displayConsoleUserStatus(user.status);
    const profile = userProfile(contexts, user.id, user.email, teamNames);

    return {
      id: user.id,
      teamId: profile.teamId,
      teamName: profile.teamName,
      name: displayNameFromEmail(user.email),
      email: user.email,
      role: profile.role,
      roleDetails: profile.roleDetails,
      status,
      statusTone: status === "Active" ? "good" : "warn",
      adminNote: user.adminNote,
      apiKeyLimit: user.apiKeyLimit,
      userCanCreateCustomProvider: user.userCanCreateCustomProvider,
      userCanCreateAccessPoint: user.userCanCreateAccessPoint,
      apiKeys: String(userKeys.length),
      lastSeen: formatLastSeen(lastSeenAtByUser.get(user.id) ?? null),
      lastSeenAt: lastSeenAtByUser.get(user.id) ?? null,
      createdAt: formatDate(user.createdAt),
      createdAtIso: user.createdAt
    };
  });

  const normalizedQuery = normalizeQuery(query);
  const filteredRows = rows.filter((user) =>
    matchesQuery(normalizedQuery, [user.name, user.email, user.id, user.teamId, user.teamName, user.role, user.roleDetails, user.status])
  );
  const activeUsers = users.filter((user) => isEnabled(user.status)).length;
  const owners = users.filter((user) => contexts.tenancy.teamRolesForUser(user.id).length > 0).length;
  const usersWithKeys = new Set(apiKeys.map((apiKey) => apiKey.userId)).size;

  return {
    metrics: [
      {
        label: "Total Users",
        value: formatInteger(users.length),
        detail: `${formatInteger(activeUsers)} active`,
        ...(users.length > 0 ? { tone: "good" as const } : {})
      },
      {
        label: "Users With Keys",
        value: formatInteger(usersWithKeys),
        detail: `${formatInteger(apiKeys.length)} total keys`,
        ...(usersWithKeys > 0 ? { tone: "good" as const } : {})
      },
      {
        label: "Team Owners",
        value: formatInteger(owners),
        detail: "Owner role accounts",
        tone: owners > 0 ? "good" : "warn"
      },
      {
        label: "Search Results",
        value: formatInteger(filteredRows.length),
        detail: normalizedQuery ? `Filtered by "${normalizedQuery}"` : "Showing all users"
      }
    ],
    rows: filteredRows,
    query: normalizedQuery
  };
}

export function buildOwnerUsersPageAggregate(repo: UiSyncQueryPort, input: { query?: string; page?: number; pageSize?: TablePageSize } = {}): OwnerUsersPageAggregate {
  const query = normalizeQuery(input.query ?? "");
  const page = repo.pageOwnerUserDirectory({ query, ...(input.page === undefined ? {} : { page: input.page }), ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }) });
  const metrics = repo.getOwnerUserDirectoryMetrics();
  const rows: OwnerUserOverviewRow[] = page.items.map((user) => {
    const role: ConsoleUser["role"] = user.isPlatformOwner ? "Admin" : user.hasTeamRole ? "Owner" : "User";
    const status = displayConsoleUserStatus(user.status);
    return {
      id: user.id,
      teamId: user.teamId,
      teamName: user.teamName || displayNameFromEmail(user.email),
      name: displayNameFromEmail(user.email),
      email: user.email,
      role,
      roleDetails: user.roleDetails,
      status,
      statusTone: status === "Active" ? "good" : "warn",
      adminNote: user.adminNote,
      apiKeyLimit: user.apiKeyLimit,
      userCanCreateCustomProvider: user.userCanCreateCustomProvider,
      userCanCreateAccessPoint: user.userCanCreateAccessPoint,
      apiKeys: String(user.apiKeyCount),
      lastSeen: formatLastSeen(user.lastSeenAt),
      lastSeenAt: user.lastSeenAt,
      createdAt: formatDate(user.createdAt),
      createdAtIso: user.createdAt
    };
  });
  return {
    metrics: [
      { label: "Total Users", value: formatInteger(metrics.totalUsers), detail: `${formatInteger(metrics.activeUsers)} active`, ...(metrics.totalUsers > 0 ? { tone: "good" as const } : {}) },
      { label: "Users With Keys", value: formatInteger(metrics.usersWithKeys), detail: `${formatInteger(metrics.totalApiKeys)} total keys`, ...(metrics.usersWithKeys > 0 ? { tone: "good" as const } : {}) },
      { label: "Team Owners", value: formatInteger(metrics.teamOwners), detail: "Owner role accounts", tone: metrics.teamOwners > 0 ? "good" : "warn" },
      { label: "Search Results", value: formatInteger(page.total), detail: query ? `Filtered by "${query}"` : "Showing all users" }
    ],
    rows,
    query,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages
  };
}

export async function buildOwnerUsersPageAggregateAsync(
  repo: Pick<UiQueryPort, "pageOwnerUserDirectory" | "getOwnerUserDirectoryMetrics">,
  input: { query?: string; page?: number; pageSize?: TablePageSize } = {},
): Promise<OwnerUsersPageAggregate> {
  const query = normalizeQuery(input.query ?? "");
  const [page, metrics] = await Promise.all([
    repo.pageOwnerUserDirectory({ query, ...(input.page === undefined ? {} : { page: input.page }), ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }) }),
    repo.getOwnerUserDirectoryMetrics(),
  ]);
  const rows: OwnerUserOverviewRow[] = page.items.map((user) => {
    const role: ConsoleUser["role"] = user.isPlatformOwner ? "Admin" : user.hasTeamRole ? "Owner" : "User";
    const status = displayConsoleUserStatus(user.status);
    return {
      id: user.id,
      teamId: user.teamId,
      teamName: user.teamName || displayNameFromEmail(user.email),
      name: displayNameFromEmail(user.email),
      email: user.email,
      role,
      roleDetails: user.roleDetails,
      status,
      statusTone: status === "Active" ? "good" : "warn",
      adminNote: user.adminNote,
      apiKeyLimit: user.apiKeyLimit,
      userCanCreateCustomProvider: user.userCanCreateCustomProvider,
      userCanCreateAccessPoint: user.userCanCreateAccessPoint,
      apiKeys: String(user.apiKeyCount),
      lastSeen: formatLastSeen(user.lastSeenAt),
      lastSeenAt: user.lastSeenAt,
      createdAt: formatDate(user.createdAt),
      createdAtIso: user.createdAt,
    };
  });
  return {
    metrics: [
      { label: "Total Users", value: formatInteger(metrics.totalUsers), detail: `${formatInteger(metrics.activeUsers)} active`, ...(metrics.totalUsers > 0 ? { tone: "good" as const } : {}) },
      { label: "Users With Keys", value: formatInteger(metrics.usersWithKeys), detail: `${formatInteger(metrics.totalApiKeys)} total keys`, ...(metrics.usersWithKeys > 0 ? { tone: "good" as const } : {}) },
      { label: "Team Owners", value: formatInteger(metrics.teamOwners), detail: "Owner role accounts", tone: metrics.teamOwners > 0 ? "good" : "warn" },
      { label: "Search Results", value: formatInteger(page.total), detail: query ? `Filtered by "${query}"` : "Showing all users" },
    ],
    rows,
    query,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
  };
}

export function ownerUsersHref(query: string, page = 1, pageSize: TablePageSize = 20) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 20) params.set("pageSize", String(pageSize));
  const search = params.toString();
  return `/owner/users${search ? `?${search}` : ""}`;
}

export function ownerKeysHref(query: string, page = 1, pageSize: TablePageSize = 20) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 20) params.set("pageSize", String(pageSize));
  const search = params.toString();
  return `/owner/keys${search ? `?${search}` : ""}`;
}

export function buildAdminKeysAggregate(repo: UiSyncQueryPort, contexts: SyncIdentityTenancyReaders, query = ""): AdminKeysAggregate {
  const teams = contexts.tenancy.listTeams();
  const users = contexts.identity.listUsers();
  const apiKeys = contexts.identity.listApiKeys();
  const lastUsedAtByApiKey = repo.listLatestRequestStartedAtByApiKey();
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));
  const userById = new Map(users.map((user) => [user.id, user]));

  const rows: AdminApiKeyOverviewRow[] = apiKeys.map((apiKey) => {
    const user = userById.get(apiKey.userId);
    const userName = user ? displayNameFromEmail(user.email) : apiKey.userId;
    const userEmail = user?.email ?? apiKey.userId;
    const keyBudget = activeAmountBudgetForScope(repo, `user:${apiKey.userId}`);
    const usage = repo.usageSummary({ apiKeyId: apiKey.id });
    const planUsage = usagePercentForBudget(usage.calculatedCost, keyBudget?.limitValue ?? null);
    const status = displayApiKeyStatus(apiKey.status);

    return {
      id: apiKey.id,
      scopeSummary: contexts.tenancy.listEffectiveSubscriptionScopesForUser(apiKey.userId).join(", "),
      userId: apiKey.userId,
      userName,
      userEmail,
      name: apiKey.name,
      prefix: apiKey.keyPrefix,
      status,
      statusTone: status === "Active" ? "good" : status === "Disabled" ? "warn" : "bad",
      scope: `key:${apiKey.id}`,
      planUsage,
      usageTone: toneForUsage(planUsage),
      budget: formatBudgetLabel(keyBudget?.limitValue ?? null, keyBudget?.windowLabel ?? null),
      lastUsed: formatLastSeen(lastUsedAtByApiKey.get(apiKey.id) ?? null),
      lastUsedAt: lastUsedAtByApiKey.get(apiKey.id) ?? null,
      createdAt: formatDate(apiKey.createdAt),
      createdAtIso: apiKey.createdAt
    };
  });

  const normalizedQuery = normalizeQuery(query);
  const filteredRows = rows.filter((apiKey) =>
    matchesQuery(normalizedQuery, [apiKey.name, apiKey.id, apiKey.prefix, apiKey.status, apiKey.scopeSummary, apiKey.userId, apiKey.userName, apiKey.userEmail])
  );
  const activeKeys = apiKeys.filter((apiKey) => isEnabled(apiKey.status)).length;
  const revokedKeys = apiKeys.filter((apiKey) => apiKey.status.toLowerCase() === "revoked").length;
  const usedKeys = lastUsedAtByApiKey.size;

  return {
    metrics: [
      {
        label: "Total Keys",
        value: formatInteger(apiKeys.length),
        detail: `${formatInteger(activeKeys)} active`,
        ...(apiKeys.length > 0 ? { tone: "good" as const } : {})
      },
      {
        label: "Used Keys",
        value: formatInteger(usedKeys),
        detail: "Seen in request logs",
        ...(usedKeys > 0 ? { tone: "good" as const } : {})
      },
      {
        label: "Revoked Keys",
        value: formatInteger(revokedKeys),
        detail: "Access disabled",
        tone: revokedKeys > 0 ? "warn" : "good"
      },
      {
        label: "Search Results",
        value: formatInteger(filteredRows.length),
        detail: normalizedQuery ? `Filtered by "${normalizedQuery}"` : "Showing all keys"
      }
    ],
    rows: filteredRows,
    query: normalizedQuery
  };
}

export function buildAdminKeysPageAggregate(repo: UiSyncQueryPort, input: { query?: string; page?: number; pageSize?: TablePageSize } = {}): AdminKeysPageAggregate {
  const query = normalizeQuery(input.query ?? "");
  const page = repo.pageOwnerApiKeyDirectory({ query, ...(input.page === undefined ? {} : { page: input.page }), ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }) });
  const metrics = repo.getOwnerApiKeyDirectoryMetrics();
  const rows: AdminApiKeyOverviewRow[] = page.items.map((apiKey) => {
    const planUsage = usagePercentForBudget(apiKey.calculatedCost, apiKey.budgetLimit);
    const status = displayApiKeyStatus(apiKey.status);
    return {
      id: apiKey.id,
      scopeSummary: apiKey.scopeSummary,
      userId: apiKey.userId,
      userName: displayNameFromEmail(apiKey.userEmail),
      userEmail: apiKey.userEmail,
      name: apiKey.name,
      prefix: apiKey.keyPrefix,
      status,
      statusTone: status === "Active" ? "good" : status === "Disabled" ? "warn" : "bad",
      scope: `key:${apiKey.id}`,
      planUsage,
      usageTone: toneForUsage(planUsage),
      budget: formatBudgetLabel(apiKey.budgetLimit, apiKey.budgetWindowType === "fixed" ? `${formatDuration(apiKey.budgetWindowSeconds ?? 0)} fixed` : apiKey.budgetWindowType ? "plan" : null),
      lastUsed: formatLastSeen(apiKey.lastUsedAt),
      lastUsedAt: apiKey.lastUsedAt,
      createdAt: formatDate(apiKey.createdAt),
      createdAtIso: apiKey.createdAt
    };
  });
  return {
    metrics: [
      { label: "Total Keys", value: formatInteger(metrics.totalKeys), detail: `${formatInteger(metrics.activeKeys)} active`, ...(metrics.totalKeys > 0 ? { tone: "good" as const } : {}) },
      { label: "Used Keys", value: formatInteger(metrics.usedKeys), detail: "Seen in request logs", ...(metrics.usedKeys > 0 ? { tone: "good" as const } : {}) },
      { label: "Revoked Keys", value: formatInteger(metrics.revokedKeys), detail: "Access disabled", tone: metrics.revokedKeys > 0 ? "warn" : "good" },
      { label: "Search Results", value: formatInteger(page.total), detail: query ? `Filtered by "${query}"` : "Showing all keys" }
    ],
    rows, query, page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages
  };
}

export async function buildAdminKeysPageAggregateAsync(
  repo: UiQueryPort,
  input: { query?: string; page?: number; pageSize?: TablePageSize } = {},
): Promise<AdminKeysPageAggregate> {
  const query = normalizeQuery(input.query ?? "");
  const [page, metrics] = await Promise.all([
    repo.pageOwnerApiKeyDirectory({ query, ...(input.page === undefined ? {} : { page: input.page }), ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }) }),
    repo.getOwnerApiKeyDirectoryMetrics(),
  ]);
  const rows: AdminApiKeyOverviewRow[] = page.items.map((apiKey) => {
    const planUsage = usagePercentForBudget(apiKey.calculatedCost, apiKey.budgetLimit);
    const status = displayApiKeyStatus(apiKey.status);
    return {
      id: apiKey.id,
      scopeSummary: apiKey.scopeSummary,
      userId: apiKey.userId,
      userName: displayNameFromEmail(apiKey.userEmail),
      userEmail: apiKey.userEmail,
      name: apiKey.name,
      prefix: apiKey.keyPrefix,
      status,
      statusTone: status === "Active" ? "good" : status === "Disabled" ? "warn" : "bad",
      scope: `key:${apiKey.id}`,
      planUsage,
      usageTone: toneForUsage(planUsage),
      budget: formatBudgetLabel(apiKey.budgetLimit, apiKey.budgetWindowType === "fixed" ? `${formatDuration(apiKey.budgetWindowSeconds ?? 0)} fixed` : apiKey.budgetWindowType ? "plan" : null),
      lastUsed: formatLastSeen(apiKey.lastUsedAt),
      lastUsedAt: apiKey.lastUsedAt,
      createdAt: formatDate(apiKey.createdAt),
      createdAtIso: apiKey.createdAt,
    };
  });
  return {
    metrics: [
      { label: "Total Keys", value: formatInteger(metrics.totalKeys), detail: `${formatInteger(metrics.activeKeys)} active`, ...(metrics.totalKeys > 0 ? { tone: "good" as const } : {}) },
      { label: "Used Keys", value: formatInteger(metrics.usedKeys), detail: "Seen in request logs", ...(metrics.usedKeys > 0 ? { tone: "good" as const } : {}) },
      { label: "Revoked Keys", value: formatInteger(metrics.revokedKeys), detail: "Access disabled", tone: metrics.revokedKeys > 0 ? "warn" : "good" },
      { label: "Search Results", value: formatInteger(page.total), detail: query ? `Filtered by "${query}"` : "Showing all keys" },
    ],
    rows,
    query,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
  };
}

export function buildAdminCreditsAggregate(
  repo: UiSyncQueryPort,
  input: { query?: string; page?: number; pageSize?: TablePageSize; scopePage?: number; scopePageSize?: TablePageSize } = {},
): AdminCreditsAggregate {
  const normalizedQuery = normalizeQuery(input.query ?? "");
  const userPage = repo.pageAdminCreditUserAccounts({ query: normalizedQuery, ...(input.page === undefined ? {} : { page: input.page }), ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }) });
  const scopePage = repo.pageAdminNonUserCreditAccounts({ ...(input.scopePage === undefined ? {} : { page: input.scopePage }), ...(input.scopePageSize === undefined ? {} : { pageSize: input.scopePageSize }) });
  const summary = repo.getAdminCreditDirectorySummary();
  const rows: AdminCreditUserRow[] = userPage.items.map((row) => ({
    id: row.userId,
    userId: row.userId,
    userName: displayNameFromEmail(row.userEmail),
    userEmail: row.userEmail,
    teamId: row.teamId ?? "",
    teamName: row.teamName ?? row.teamId ?? displayNameFromEmail(row.userEmail),
    accountId: row.accountId ?? "No account",
    balance: formatCreditCurrency(creditUnitsToUsd(row.balanceSnapUnits)),
    balanceValue: creditUnitsToUsd(row.balanceSnapUnits),
    transferOutEnabled: row.transferOutEnabled,
    accountStatus: row.accountStatus,
    latestLedgerAt: row.latestLedgerAt ? formatDateTime(row.latestLedgerAt) : "Never",
    latestLedgerAtIso: row.latestLedgerAt,
  }));
  return {
    metrics: [
      {
        label: "User Balance",
        value: formatCreditCurrency(creditUnitsToUsd(summary.userBalanceUnits)),
        detail: `${formatInteger(summary.userAccountCount)} user accounts`,
        ...(summary.userAccountCount > 0 ? { tone: "good" as const } : {})
      },
      {
        label: "Negative Users",
        value: formatInteger(summary.negativeUserCount),
        detail: "Users below zero",
        tone: summary.negativeUserCount > 0 ? "bad" : "good"
      },
      {
        label: "Team/Global Balance",
        value: formatCreditCurrency(creditUnitsToUsd(summary.nonUserBalanceUnits)),
        detail: `${formatInteger(summary.nonUserAccountCount)} non-user accounts`
      },
      {
        label: "Transfer Disabled",
        value: formatInteger(summary.transferDisabledUserCount),
        detail: "User scopes blocked"
      }
    ],
    rows,
    query: normalizedQuery,
    scopeSummary: scopePage.items.map((account) => ({
      id: account.id,
      scopeRef: account.scopeRef,
      balance: formatCreditCurrency(creditUnitsToUsd(account.balanceSnapUnits)),
      status: account.status,
      latestLedgerAt: account.latestLedgerAt ? formatDateTime(account.latestLedgerAt) : "Never",
      latestLedgerAtIso: account.latestLedgerAt,
    })),
    page: userPage.page,
    pageSize: userPage.pageSize,
    total: userPage.total,
    totalPages: userPage.totalPages,
    scopePage: scopePage.page,
    scopePageSize: scopePage.pageSize,
    scopeTotal: scopePage.total,
    scopeTotalPages: scopePage.totalPages,
  };
}

export async function buildAdminCreditsAggregateAsync(
  billingQueries: Pick<UiQueryPort, "pageAdminCreditUserAccounts" | "pageAdminNonUserCreditAccounts" | "getAdminCreditDirectorySummary">,
  input: { query?: string; page?: number; pageSize?: TablePageSize; scopePage?: number; scopePageSize?: TablePageSize } = {},
): Promise<AdminCreditsAggregate> {
  const normalizedQuery = normalizeQuery(input.query ?? "");
  const [userPage, scopePage, summary] = await Promise.all([
    billingQueries.pageAdminCreditUserAccounts({ query: normalizedQuery, ...(input.page === undefined ? {} : { page: input.page }), ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }) }),
    billingQueries.pageAdminNonUserCreditAccounts({ ...(input.scopePage === undefined ? {} : { page: input.scopePage }), ...(input.scopePageSize === undefined ? {} : { pageSize: input.scopePageSize }) }),
    billingQueries.getAdminCreditDirectorySummary(),
  ]);
  const rows: AdminCreditUserRow[] = userPage.items.map((row) => ({
    id: row.userId,
    userId: row.userId,
    userName: displayNameFromEmail(row.userEmail),
    userEmail: row.userEmail,
    teamId: row.teamId ?? "",
    teamName: row.teamName ?? row.teamId ?? displayNameFromEmail(row.userEmail),
    accountId: row.accountId ?? "No account",
    balance: formatCreditCurrency(creditUnitsToUsd(row.balanceSnapUnits)),
    balanceValue: creditUnitsToUsd(row.balanceSnapUnits),
    transferOutEnabled: row.transferOutEnabled,
    accountStatus: row.accountStatus,
    latestLedgerAt: row.latestLedgerAt ? formatDateTime(row.latestLedgerAt) : "Never",
    latestLedgerAtIso: row.latestLedgerAt,
  }));
  return {
    metrics: [
      { label: "User Balance", value: formatCreditCurrency(creditUnitsToUsd(summary.userBalanceUnits)), detail: `${formatInteger(summary.userAccountCount)} user accounts`, ...(summary.userAccountCount > 0 ? { tone: "good" as const } : {}) },
      { label: "Negative Users", value: formatInteger(summary.negativeUserCount), detail: "Users below zero", tone: summary.negativeUserCount > 0 ? "bad" : "good" },
      { label: "Team/Global Balance", value: formatCreditCurrency(creditUnitsToUsd(summary.nonUserBalanceUnits)), detail: `${formatInteger(summary.nonUserAccountCount)} non-user accounts` },
      { label: "Transfer Disabled", value: formatInteger(summary.transferDisabledUserCount), detail: "User scopes blocked" },
    ],
    rows,
    query: normalizedQuery,
    scopeSummary: scopePage.items.map((account) => ({
      id: account.id,
      scopeRef: account.scopeRef,
      balance: formatCreditCurrency(creditUnitsToUsd(account.balanceSnapUnits)),
      status: account.status,
      latestLedgerAt: account.latestLedgerAt ? formatDateTime(account.latestLedgerAt) : "Never",
      latestLedgerAtIso: account.latestLedgerAt,
    })),
    page: userPage.page,
    pageSize: userPage.pageSize,
    total: userPage.total,
    totalPages: userPage.totalPages,
    scopePage: scopePage.page,
    scopePageSize: scopePage.pageSize,
    scopeTotal: scopePage.total,
    scopeTotalPages: scopePage.totalPages,
  };
}

export function buildAdminTeamDetail(repo: UiSyncQueryPort, contexts: SyncIdentityTenancyReaders, teamId: string, input: AdminTeamDetailInput = {}): AdminTeamDetail | null {
  const storedTeam = contexts.tenancy.getTeam(teamId);
  if (!storedTeam) return null;

  const counts = repo.getTeamDetailCounts(teamId);
  const memberPage = repo.pageTeamMemberSummaries(teamId, input.userPage, input.userPageSize);
  const selectedAudienceMember = input.audienceMemberId
    ? repo.getTeamMemberSummary(teamId, input.audienceMemberId)
    : undefined;
  const memberRows = selectedAudienceMember && !memberPage.items.some((member) => member.id === selectedAudienceMember.id)
    ? [...memberPage.items, selectedAudienceMember]
    : memberPage.items;
  const accessPointPage = repo.pageScopedAccessPointDirectory(`team:${teamId}`, input.accessPointPage, input.accessPointPageSize);
  const planPage = repo.pagePlanSubscriptionsForScope(`team:${teamId}`, input.planPage, input.planStatus, input.planPageSize);
  const team = buildAdminTeamRow(repo, storedTeam, counts);
  const accessPoints = accessPointPage.items
    .map((accessPoint) => {
      const enabledPrice = accessPoint.enabledPrice;
      return {
        id: accessPoint.id,
        name: accessPoint.name,
        description: accessPoint.description,
        apiFamily: accessPoint.apiFamily,
        exposedModel: accessPoint.exposedModel,
        targetModel: accessPoint.targetModel,
        targetType: accessPoint.targetType,
        targetLabel: accessPoint.targetType === "provider-model"
          ? `${accessPoint.targetProviderId ?? "unknown"} / ${accessPoint.targetProviderModelName ?? "unknown"}`
          : accessPoint.targetAccessPointName
            ? `${accessPoint.targetAccessPointName} (${accessPoint.targetModel})`
            : accessPoint.targetId ?? "unknown",
        status: accessPoint.status,
        priority: accessPoint.priority,
        fallbackOrder: accessPoint.fallbackOrder,
        price: enabledPrice ? priceTripletFromPer1M(enabledPrice) : "No enabled price"
      };
    });
  const users = memberRows.map((member) => {
    return {
      id: member.id,
      teamId,
      name: displayNameFromEmail(member.email),
      email: member.email,
      role: member.isPlatformOwner ? "Admin" : storedTeam.ownerId === member.id ? "Owner" : "User",
      status: displayStatus(member.status),
      apiKeys: String(member.apiKeyCount),
      apiKeyLimit: member.apiKeyLimit,
      lastSeen: member.lastSeenAt ? formatDateTime(member.lastSeenAt) : "Never",
      lastSeenAt: member.lastSeenAt,
      createdAt: formatDate(member.createdAt),
      createdAtIso: member.createdAt
    };
  });
  const membershipRoles = memberRows.map((member) => ({
    userId: member.id,
    email: member.email,
    roles: JSON.parse(member.membershipRolesJson) as string[]
  }));
  const plans = planPage.items.map((subscription): TeamPlanRow => ({
    id: subscription.id,
    planTemplateId: subscription.planId,
    templateName: subscription.templateName
      ? `${subscription.templateName} v${subscription.templateVersion ?? "?"}`
      : `Missing template (${subscription.planId})`,
    billingMode: subscription.billingMode ? planBillingModeLabel(subscription.billingMode) : "Unknown",
    planStatus: subscription.planStatus === "enabled" || subscription.planStatus === "closed" || subscription.planStatus === "disabled"
      ? subscription.planStatus
      : "missing",
    status: subscription.subscriptionLifecycle,
    priority: subscription.priority,
    effectiveStart: subscription.effectiveStart,
    effectiveEnd: subscription.effectiveEnd,
    duration: subscription.durationSeconds === null ? "Unknown" : formatDuration(subscription.durationSeconds),
    price: subscription.purchaseAmount === null ? "Unknown" : formatCurrency(subscription.purchaseAmount),
    budgetSummary: teamPlanBudgetSummary(subscription.budgetLimitPreviewJson, subscription.budgetLimitCount),
    includedAccessPoints: teamPlanAccessPointSummary(subscription.accessPointPreviewJson, subscription.accessPointCount),
  }));

  return {
    team,
    users,
    membershipRoles,
    accessPoints,
    plans,
    pages: {
      users: pageMetadata(memberPage),
      accessPoints: pageMetadata(accessPointPage),
      plans: pageMetadata(planPage),
    },
  };
}

export async function buildAdminTeamDetailAsync(
  repo: UiQueryPort,
  contexts: AsyncIdentityTenancyReaders,
  teamId: string,
  input: AdminTeamDetailInput = {},
): Promise<AdminTeamDetail | null> {
  const storedTeam = await contexts.tenancy.getTeam(teamId);
  if (!storedTeam) return null;

  const [counts, memberPage, selectedAudienceMember, accessPointPage, planPage] = await Promise.all([
    repo.getTeamDetailCounts(teamId),
    repo.pageTeamMemberSummaries(teamId, input.userPage, input.userPageSize),
    input.audienceMemberId && input.audienceMemberId !== storedTeam.ownerId
      ? repo.getTeamMemberSummary(teamId, input.audienceMemberId)
      : Promise.resolve(undefined),
    repo.pageScopedAccessPointDirectory(`team:${teamId}`, input.accessPointPage, input.accessPointPageSize),
    repo.pagePlanSubscriptionsForScope(`team:${teamId}`, input.planPage, input.planStatus, input.planPageSize),
  ]);
  const memberRows = selectedAudienceMember && !memberPage.items.some((member) => member.id === selectedAudienceMember.id)
    ? [...memberPage.items, selectedAudienceMember]
    : memberPage.items;
  const team = await buildAdminTeamRowAsync(repo, storedTeam, counts);
  const accessPoints = accessPointPage.items.map((accessPoint) => {
    const enabledPrice = accessPoint.enabledPrice;
    return {
      id: accessPoint.id,
      name: accessPoint.name,
      description: accessPoint.description,
      apiFamily: accessPoint.apiFamily,
      exposedModel: accessPoint.exposedModel,
      targetModel: accessPoint.targetModel,
      targetType: accessPoint.targetType,
      targetLabel: accessPoint.targetType === "provider-model"
        ? `${accessPoint.targetProviderId ?? "unknown"} / ${accessPoint.targetProviderModelName ?? "unknown"}`
        : accessPoint.targetType === "access-point" && accessPoint.targetAccessPointName
          ? `${accessPoint.targetAccessPointName} (${accessPoint.targetModel})`
          : accessPoint.targetId ?? "unknown",
      status: accessPoint.status,
      priority: accessPoint.priority,
      fallbackOrder: accessPoint.fallbackOrder,
      price: enabledPrice ? priceTripletFromPer1M(enabledPrice) : "No enabled price",
    };
  });
  const users = memberRows.map((member) => ({
    id: member.id,
    teamId,
    name: displayNameFromEmail(member.email),
    email: member.email,
    role: member.isPlatformOwner ? "Admin" : storedTeam.ownerId === member.id ? "Owner" : "User",
    status: displayStatus(member.status),
    apiKeys: String(member.apiKeyCount),
    apiKeyLimit: member.apiKeyLimit,
    lastSeen: member.lastSeenAt ? formatDateTime(member.lastSeenAt) : "Never",
    lastSeenAt: member.lastSeenAt,
    createdAt: formatDate(member.createdAt),
    createdAtIso: member.createdAt,
  }));
  const membershipRoles = memberRows.map((member) => ({
    userId: member.id,
    email: member.email,
    roles: JSON.parse(member.membershipRolesJson) as string[],
  }));
  const plans = planPage.items.map((subscription): TeamPlanRow => ({
    id: subscription.id,
    planTemplateId: subscription.planId,
    templateName: subscription.templateName
      ? `${subscription.templateName} v${subscription.templateVersion ?? "?"}`
      : `Missing template (${subscription.planId})`,
    billingMode: subscription.billingMode ? planBillingModeLabel(subscription.billingMode) : "Unknown",
    planStatus: subscription.planStatus === "enabled" || subscription.planStatus === "closed" || subscription.planStatus === "disabled"
      ? subscription.planStatus
      : "missing",
    status: subscription.subscriptionLifecycle,
    priority: subscription.priority,
    effectiveStart: subscription.effectiveStart,
    effectiveEnd: subscription.effectiveEnd,
    duration: subscription.durationSeconds === null ? "Unknown" : formatDuration(subscription.durationSeconds),
    price: subscription.purchaseAmount === null ? "Unknown" : formatCurrency(subscription.purchaseAmount),
    budgetSummary: teamPlanBudgetSummary(subscription.budgetLimitPreviewJson, subscription.budgetLimitCount),
    includedAccessPoints: teamPlanAccessPointSummary(subscription.accessPointPreviewJson, subscription.accessPointCount),
  }));
  return {
    team,
    users,
    membershipRoles,
    accessPoints,
    plans,
    pages: {
      users: pageMetadata(memberPage),
      accessPoints: pageMetadata(accessPointPage),
      plans: pageMetadata(planPage),
    },
  };
}

function buildAdminTeamRow(
  repo: UiSyncQueryPort,
  team: Team,
  counts: { memberCount: number; teamAccessCount: number; inheritedAccessCount: number },
): AdminTeamRow {
  const usage = repo.usageSummary({ teamId: team.id });
  const activePlan = activePlanSummaryForScope(repo, `team:${team.id}`);
  const usagePercent = usagePercentForBudget(usage.calculatedCost, activePlan.budget?.limitValue ?? null);
  const status = repo.getActiveTeamDeletion?.(team.id) ? "Soft deleted" : displayStatus(team.status);

  return {
    initials: initialsForName(team.name),
    name: team.name,
    id: team.id,
    ownerId: team.ownerId,
    status,
    statusTone: status === "Active" ? "good" : "warn",
    members: String(counts.memberCount),
    usage: usagePercent,
    usageTone: toneForUsage(usagePercent),
    planName: activePlan.planName,
    planState: activePlan.planState,
    planWindow: activePlan.planWindow,
    planEffectiveStart: activePlan.planEffectiveStart,
    planEffectiveEnd: activePlan.planEffectiveEnd,
    budget: formatBudget(activePlan.budget?.limitValue ?? null),
    budgetState: budgetState(team.status, usagePercent, activePlan.budget?.limitValue ?? null),
    accessCoverage: accessCoverage(counts.teamAccessCount, counts.inheritedAccessCount),
    canManageMemberApiKeyLimit: Boolean(team.teamOwnerCanManageMemberApiKeyLimit),
    canManageMemberCredit: Boolean(team.teamOwnerCanManageMemberCredit),
    teamOwnerCanCreateCustomProvider: Boolean(team.teamOwnerCanCreateCustomProvider),
    teamOwnerCanCreateAccessPoint: Boolean(team.teamOwnerCanCreateAccessPoint),
    deleteBlockers: repo.assessTeamDeletion(team.id).blockers,
    deletionLifecycle: repo.getActiveTeamDeletion?.(team.id) ?? null,
    createdAt: formatDate(team.createdAt),
    createdAtIso: team.createdAt
  };
}

async function buildAdminTeamRowAsync(
  repo: UiQueryPort,
  team: Team,
  counts: { memberCount: number; teamAccessCount: number; inheritedAccessCount: number },
): Promise<AdminTeamRow> {
  const [usage, activePlan, deletionLifecycle, deletionAssessment] = await Promise.all([
    repo.usageSummary({ teamId: team.id }),
    activePlanSummaryForScopeAsync(repo, `team:${team.id}`),
    repo.getActiveTeamDeletion(team.id),
    repo.assessTeamDeletion(team.id),
  ]);
  const usagePercent = usagePercentForBudget(usage.calculatedCost, activePlan.budget?.limitValue ?? null);
  const status = deletionLifecycle ? "Soft deleted" : displayStatus(team.status);
  return {
    initials: initialsForName(team.name),
    name: team.name,
    id: team.id,
    ownerId: team.ownerId,
    status,
    statusTone: status === "Active" ? "good" : "warn",
    members: String(counts.memberCount),
    usage: usagePercent,
    usageTone: toneForUsage(usagePercent),
    planName: activePlan.planName,
    planState: activePlan.planState,
    planWindow: activePlan.planWindow,
    planEffectiveStart: activePlan.planEffectiveStart,
    planEffectiveEnd: activePlan.planEffectiveEnd,
    budget: formatBudget(activePlan.budget?.limitValue ?? null),
    budgetState: budgetState(team.status, usagePercent, activePlan.budget?.limitValue ?? null),
    accessCoverage: accessCoverage(counts.teamAccessCount, counts.inheritedAccessCount),
    canManageMemberApiKeyLimit: Boolean(team.teamOwnerCanManageMemberApiKeyLimit),
    canManageMemberCredit: Boolean(team.teamOwnerCanManageMemberCredit),
    teamOwnerCanCreateCustomProvider: Boolean(team.teamOwnerCanCreateCustomProvider),
    teamOwnerCanCreateAccessPoint: Boolean(team.teamOwnerCanCreateAccessPoint),
    deleteBlockers: deletionAssessment.blockers,
    deletionLifecycle: deletionLifecycle ?? null,
    createdAt: formatDate(team.createdAt),
    createdAtIso: team.createdAt,
  };
}

export function buildOwnerUserDetail(
  repo: UiSyncQueryPort,
  contexts: SyncIdentityTenancyReaders,
  userId: string,
  input: { apiKeyPage?: number; apiKeyPageSize?: TablePageSize; at?: string } = {},
): OwnerUserDetailAggregate | null {
  const user = contexts.identity.getUser(userId);
  if (!user) return null;

  const at = input.at ?? new Date().toISOString();
  const audience = loadUserAudience({
    repo,
    identity: contexts.identity,
    tenancy: contexts.tenancy,
    viewerUserId: user.id,
    targetUserId: user.id,
    ...(input.apiKeyPage === undefined ? {} : { apiKeyPage: input.apiKeyPage }),
    ...(input.apiKeyPageSize === undefined ? {} : { apiKeyPageSize: input.apiKeyPageSize }),
    calculatedAt: at,
  });
  if (!audience?.apiKeys || !audience.credit) return null;
  const platformRoles = contexts.authority.platformRolesForUser(user.id);
  const teamRoles = contexts.tenancy.teamRolesForUser(user.id);

  return {
    user: {
      ...audience.user,
      role: platformRoles.includes("owner") ? "Admin" : teamRoles.length > 0 ? "Owner" : "User",
      roleDetails: [...platformRoles, ...teamRoles].join(", ") || "member",
      isPlatformOwner: platformRoles.includes("owner"),
      adminNote: user.adminNote,
    },
    apiKeys: audience.apiKeys.items,
    apiKeyPage: {
      page: audience.apiKeys.page,
      pageSize: audience.apiKeys.pageSize,
      total: audience.apiKeys.total,
      totalPages: audience.apiKeys.totalPages,
    },
    apiKeySummary: audience.apiKeys.summary,
    credit: audience.credit,
  };
}

export async function buildOwnerUserDetailAsync(
  repo: UiQueryPort,
  contexts: AsyncIdentityTenancyReaders,
  userId: string,
  input: { apiKeyPage?: number; apiKeyPageSize?: TablePageSize; at?: string } = {},
): Promise<OwnerUserDetailAggregate | null> {
  const user = await contexts.identity.getUser(userId);
  if (!user) return null;

  const at = input.at ?? new Date().toISOString();
  const audience = await loadUserAudienceAsync({
    repo,
    identity: contexts.identity,
    tenancy: contexts.tenancy,
    viewerUserId: user.id,
    targetUserId: user.id,
    ...(input.apiKeyPage === undefined ? {} : { apiKeyPage: input.apiKeyPage }),
    ...(input.apiKeyPageSize === undefined ? {} : { apiKeyPageSize: input.apiKeyPageSize }),
    calculatedAt: at,
  });
  if (!audience?.apiKeys || !audience.credit) return null;
  const [platformRoles, teamRoles] = await Promise.all([
    contexts.authority.platformRolesForUser(user.id),
    contexts.tenancy.teamRolesForUser(user.id),
  ]);

  return {
    user: {
      ...audience.user,
      role: platformRoles.includes("owner") ? "Admin" : teamRoles.length > 0 ? "Owner" : "User",
      roleDetails: [...platformRoles, ...teamRoles].join(", ") || "member",
      isPlatformOwner: platformRoles.includes("owner"),
      adminNote: user.adminNote,
    },
    apiKeys: audience.apiKeys.items,
    apiKeyPage: {
      page: audience.apiKeys.page,
      pageSize: audience.apiKeys.pageSize,
      total: audience.apiKeys.total,
      totalPages: audience.apiKeys.totalPages,
    },
    apiKeySummary: audience.apiKeys.summary,
    credit: audience.credit,
  };
}

function activePlanSummaryForScope(repo: UiSyncQueryPort, scopeRef: `team:${string}` | `user:${string}` | "global:") {
  const active = repo.getActivePlanIdentity([scopeRef]);
  if (!active) {
    return {
      planName: "No active plan",
      planState: "Missing",
      planWindow: scopeRef,
      planEffectiveStart: null as string | null,
      planEffectiveEnd: null as string | null,
      budget: null as { limitValue: number; windowLabel: string } | null
    };
  }
  const policy = repo.getPrimarySubscriptionAmountLimit(active.planId);
  return {
    planName: active.planName,
    planState: "Applied",
    planWindow: `${formatDateTime(active.effectiveStart)} - ${active.effectiveEnd ? formatDateTime(active.effectiveEnd) : "No end"}`,
    planEffectiveStart: active.effectiveStart,
    planEffectiveEnd: active.effectiveEnd,
    budget: policy
      ? {
          limitValue: policy.limitValue,
          windowLabel: policy.windowType === "fixed" ? `${formatDuration(policy.windowSeconds ?? 0)} fixed` : "plan"
        }
      : null
  };
}

async function activePlanSummaryForScopeAsync(repo: UiQueryPort, scopeRef: `team:${string}` | `user:${string}` | "global:") {
  const active = await repo.getActivePlanIdentity([scopeRef]);
  if (!active) {
    return {
      planName: "No active plan",
      planState: "Missing",
      planWindow: scopeRef,
      planEffectiveStart: null as string | null,
      planEffectiveEnd: null as string | null,
      budget: null as { limitValue: number; windowLabel: string } | null,
    };
  }
  const limitsByPlan = await repo.listPlanBudgetLimitsForPlans([active.planId]);
  const policy = (limitsByPlan.get(active.planId) ?? [])
    .filter((limit) => limit.limitScope === "subscription" && limit.metric === "amount")
    .sort((left, right) => (left.windowType === "cumulative" ? 0 : 1) - (right.windowType === "cumulative" ? 0 : 1) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
  return {
    planName: active.planName,
    planState: "Applied",
    planWindow: `${formatDateTime(active.effectiveStart)} - ${active.effectiveEnd ? formatDateTime(active.effectiveEnd) : "No end"}`,
    planEffectiveStart: active.effectiveStart,
    planEffectiveEnd: active.effectiveEnd,
    budget: policy
      ? { limitValue: policy.limitValue, windowLabel: policy.windowType === "fixed" ? `${formatDuration(policy.windowSeconds ?? 0)} fixed` : "plan" }
      : null,
  };
}

function activeAmountBudgetForScope(repo: UiSyncQueryPort, scopeRef: `team:${string}` | `user:${string}` | "global:") {
  return activePlanSummaryForScope(repo, scopeRef).budget;
}

function planBillingModeLabel(mode: string) {
  return mode === "paygo" ? "PayGo" : "Prepaid";
}

function teamPlanBudgetSummary(previewJson: string, total: number) {
  if (total === 0) return "No budget limits";
  const preview = JSON.parse(previewJson) as Array<{
    limitScope: string;
    metric: string;
    limitValue: number;
    windowType: string;
    windowSeconds: number | null;
  }>;
  const groups = ["subscription", "user"].flatMap((scope) => {
    const limits = preview.filter((limit) => limit.limitScope === scope);
    if (limits.length === 0) return [];
    const labels = limits.map((limit) => {
      const value = limit.metric === "amount"
        ? formatCurrency(limit.limitValue)
        : `${formatInteger(limit.limitValue)} tokens`;
      const window = limit.windowType === "fixed" ? formatDuration(limit.windowSeconds ?? 0) : "plan";
      return `${limit.metric} ${value}/${window}`;
    });
    return [`${titleCase(scope)}: ${labels.join(", ")}`];
  });
  return `${groups.join(" / ")}${total > preview.length ? `, +${total - preview.length} more` : ""}`;
}

function teamPlanAccessPointSummary(previewJson: string, total: number) {
  if (total === 0) return "0 AccessPoints";
  const preview = JSON.parse(previewJson) as Array<{ name: string; exposedModel: string }>;
  const models = preview.map((accessPoint) => accessPoint.exposedModel).join(", ");
  return `${formatInteger(total)} AccessPoint${total === 1 ? "" : "s"}: ${models}${total > preview.length ? `, +${total - preview.length} more` : ""}`;
}

function usagePercentForBudget(cost: number, amountLimit: number | null) {
  if (!amountLimit || amountLimit <= 0) return 0;
  return Math.min(100, Math.round((cost / amountLimit) * 100));
}

function toneForUsage(usagePercent: number): Tone {
  if (usagePercent > 90) return "bad";
  if (usagePercent > 70) return "warn";
  return "good";
}

function budgetState(teamStatus: string, usagePercent: number, amountLimit: number | null) {
  if (!isEnabled(teamStatus)) return "Inactive";
  if (!amountLimit || amountLimit <= 0) return "No Cap";
  if (usagePercent >= 100) return "Hard Stop";
  if (usagePercent >= 90) return "Critical";
  if (usagePercent >= 70) return "Warning";
  return "Within Limit";
}

function accessCoverage(teamAccessCount: number, inheritedAccessCount: number) {
  if (teamAccessCount > 0) return `${teamAccessCount} team access points`;
  if (inheritedAccessCount > 0) return `${inheritedAccessCount} inherited`;
  return "No access";
}

function priceTripletFromPer1M(price: { inputPer1M: number; cachedInputPer1M: number; cacheWritePer1M: number | null; outputPer1M: number }) {
  return `${formatMoneyPerMillion(price.inputPer1M)} / ${formatMoneyPerMillion(price.cachedInputPer1M)} / ${price.cacheWritePer1M === null ? "Unavailable" : formatMoneyPerMillion(price.cacheWritePer1M)} / ${formatMoneyPerMillion(price.outputPer1M)}`;
}

function pageMetadata(page: { page: number; pageSize: TablePageSize; total: number; totalPages: number }): DetailPageMetadata {
  return {
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
  };
}

function formatMoneyPerMillion(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value);
}

function displayStatus(status: string) {
  if (["active", "enabled", "healthy"].includes(status.toLowerCase())) return "Active";
  if (["disabled", "paused", "revoked"].includes(status.toLowerCase())) return "Disabled";
  return titleCase(status);
}

function userProfile(contexts: SyncIdentityTenancyReaders, userId: string, email: string, teamNames: Map<string, string>): { teamId: string; teamName: string; role: ConsoleUser["role"]; roleDetails: string } {
  const memberships = contexts.tenancy.listAvailableTeamMemberships(userId);
  const teamId = memberships[0]?.teamId ?? "";
  const platformRoles = contexts.authority.platformRolesForUser(userId);
  const teamRoles = contexts.tenancy.teamRolesForUser(userId);
  const role: ConsoleUser["role"] = platformRoles.includes("owner") ? "Admin" : teamRoles.length > 0 ? "Owner" : "User";
  const roleDetails = [...platformRoles, ...teamRoles].join(", ") || "member";
  return {
    teamId,
    teamName: teamNames.get(teamId) ?? teamId ?? displayNameFromEmail(email),
    role,
    roleDetails
  };
}

function displayConsoleUserStatus(status: string): ConsoleUser["status"] {
  return isEnabled(status) ? "Active" : "Disabled";
}

function displayApiKeyStatus(status: string): ConsoleApiKey["status"] {
  if (status.toLowerCase() === "revoked") return "Revoked";
  if (["paused", "disabled"].includes(status.toLowerCase())) return "Disabled";
  return "Active";
}

function isEnabled(status: string) {
  return ["active", "enabled", "healthy"].includes(status.toLowerCase());
}

function initialsForName(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "TM";
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("");
}

function displayNameFromEmail(email: string) {
  const localPart = email.split("@")[0] ?? email;
  return localPart.split(/[._-]+/).filter(Boolean).map(titleCase).join(" ") || email;
}

function formatLastSeen(value: string | null) {
  return value ? formatDateTime(value) : "Never";
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatBudget(value: number | null) {
  if (value === null) return "No cap";
  return formatCurrency(value);
}

function formatBudgetLabel(value: number | null, period: string | null) {
  if (value === null) return "No cap";
  const suffix = period ? `/${period}` : "";
  return `${formatCurrency(value)}${suffix}`;
}

function formatDuration(seconds: number) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${seconds}s`;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
}

function formatCreditCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value);
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: value >= 1000 ? 1 : 0 }).format(value);
}

function formatPercent(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function normalizeQuery(query: string) {
  return query.trim().toLowerCase();
}

function matchesQuery(query: string, values: Array<string | number | null | undefined>) {
  if (!query) return true;
  return values.some((value) => String(value ?? "").toLowerCase().includes(query));
}
