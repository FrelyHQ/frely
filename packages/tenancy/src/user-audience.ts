import type { IdentityQueries } from "@frely/identity/server";
import type { TenancyQueries } from "./server.js";
import {
  creditUnitsToUsd,
  type AsyncApplicationOperationPort,
  type ManagementPermissionAction,
  type ApplicationOperationPort,
  type UserApiKeyDirectoryMetrics,
  type UserApiKeyDirectoryRow,
  type DirectoryPageSize,
} from "@frely/application/runtime";

export type UserAudiencePermissionCheck = (
  teamId: string,
  action: ManagementPermissionAction,
) => boolean;

export type UserAudienceAsyncPermissionCheck = (
  teamId: string,
  action: ManagementPermissionAction,
) => Promise<boolean>;

export type UserAudienceAsyncApplicationOperationPort = Pick<AsyncApplicationOperationPort,
  | "userNavigationSummary"
  | "getUserApiKeyDirectoryMetrics"
  | "pageUserApiKeyDirectory"
  | "getUserApiKeyDetail"
  | "usageSummary"
  | "latestRequestStartedAtForApiKey"
  | "getActivePlanIdentity"
  | "listPlanBudgetLimitsForPlans"
  | "latestRequestStartedAtForUser"
  | "findCreditAccountForScope"
  | "listCreditLedgerEventsForAccount"
  | "isCreditTransferOutEnabled"
  | "pageUserAvailableModels"
>;

export type UserAudienceApplicationOperationPort = Pick<ApplicationOperationPort, keyof UserAudienceAsyncApplicationOperationPort | "getPrimarySubscriptionAmountLimit">;

export interface UserAudienceProfile {
  id: string;
  teamId: string;
  name: string;
  email: string;
  role: "Owner" | "User";
  status: "Active" | "Disabled";
  apiKeyLimit: number;
  userCanCreateCustomProvider: number;
  userCanCreateAccessPoint: number;
  apiKeys: string;
  lastSeen: string;
  lastSeenAt: string | null;
  createdAt: string;
  createdAtIso: string;
}

export interface UserAudienceApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  status: "Active" | "Disabled" | "Revoked";
  scope: string;
  planUsage: number;
  budget: string;
  lastUsed: string;
  lastUsedAt: string | null;
  createdAt: string;
  createdAtIso: string;
}

export interface UserAudienceCredit {
  accountId: string;
  scopeRef: string;
  status: string;
  balance: string;
  transferOutEnabled: boolean;
  recentEvents: Array<{
    id: string;
    eventType: string;
    amount: string;
    reason: string;
    actorUserId: string;
    relatedEventId: string;
    createdAt: string;
    createdAtIso: string;
  }>;
}

export interface UserAudienceViewModel {
  audience: {
    viewerUserId: string;
    targetUserId: string;
    perspective: "self" | "teamMember";
    teamId: string | null;
  };
  user: UserAudienceProfile;
  apiKeys: {
    items: UserAudienceApiKey[];
    page: number;
    pageSize: DirectoryPageSize;
    total: number;
    totalPages: number;
    summary: UserApiKeyDirectoryMetrics;
  } | null;
  credit: UserAudienceCredit | null;
  usage: {
    totalTokens: number;
    billableAmount: number;
    calculatedCost: number;
  } | null;
  capabilities: {
    canReadApiKeys: boolean;
    canManageApiKeys: boolean;
    canReadCredit: boolean;
    canReadPlanBudget: boolean;
  };
  calculatedAt: string;
}

export interface UserAudienceApiKeyDetail extends UserAudienceApiKey {
  expiresAt: string;
  revokedAt: string;
  totalTokens: string;
  calculatedCost: string;
}

export function loadUserAudience(input: {
  repo: UserAudienceApplicationOperationPort;
  identity: Pick<ApplicationOperationPort, "getUser">;
  tenancy: Pick<ApplicationOperationPort, "getTeam" | "getTeamMembership">;
  viewerUserId: string;
  targetUserId: string;
  teamId?: string;
  apiKeyPage?: number;
  apiKeyPageSize?: DirectoryPageSize;
  apiKeyQuery?: string;
  calculatedAt?: string;
  hasPermission?: UserAudiencePermissionCheck;
}): UserAudienceViewModel | null {
  const { repo, identity, tenancy, viewerUserId, targetUserId } = input;
  const user = identity.getUser(targetUserId);
  if (!user) return null;

  const isSelf = viewerUserId === targetUserId;
  const teamId = isSelf
    ? repo.userNavigationSummary(targetUserId).items[0]?.id ?? null
    : input.teamId ?? null;
  if (!isSelf && !canReadTeamMember(tenancy, viewerUserId, targetUserId, teamId, input.hasPermission)) return null;

  const canReadCredit = isSelf || Boolean(
    teamId && input.hasPermission?.(teamId, "team.credit.read"),
  );
  const canReadPlanBudget = isSelf || Boolean(
    teamId
      && input.hasPermission?.(teamId, "team.usage.read")
      && input.hasPermission?.(teamId, "team.billing.read"),
  );
  const calculatedAt = input.calculatedAt ?? new Date().toISOString();
  const apiKeySummary = isSelf
    ? repo.getUserApiKeyDirectoryMetrics(targetUserId, calculatedAt)
    : null;
  const apiKeyPage = isSelf
    ? repo.pageUserApiKeyDirectory(targetUserId, {
        ...(input.apiKeyPage === undefined ? {} : { page: input.apiKeyPage }),
        ...(input.apiKeyPageSize === undefined ? {} : { pageSize: input.apiKeyPageSize }),
        ...(input.apiKeyQuery === undefined ? {} : { query: input.apiKeyQuery }),
      }, calculatedAt)
    : null;
  const usage = isSelf ? repo.usageSummary({ userId: targetUserId }) : null;
  const lastSeenAt = repo.latestRequestStartedAtForUser(user.id);

  return {
    audience: {
      viewerUserId,
      targetUserId,
      perspective: isSelf ? "self" : "teamMember",
      teamId,
    },
    user: {
      id: user.id,
      teamId: teamId ?? "",
      name: displayNameFromEmail(user.email),
      email: user.email,
      role: teamId && tenancy.getTeam(teamId)?.ownerId === user.id ? "Owner" : "User",
      status: user.status === "enabled" ? "Active" : "Disabled",
      apiKeyLimit: user.apiKeyLimit,
      userCanCreateCustomProvider: user.userCanCreateCustomProvider,
      userCanCreateAccessPoint: user.userCanCreateAccessPoint,
      apiKeys: isSelf && apiKeySummary ? String(apiKeySummary.totalKeys) : "Restricted",
      lastSeen: formatLastSeen(lastSeenAt),
      lastSeenAt,
      createdAt: formatUtcDate(user.createdAt),
      createdAtIso: user.createdAt,
    },
    apiKeys: apiKeyPage && apiKeySummary ? {
      items: apiKeyPage.items.map(audienceApiKey),
      page: apiKeyPage.page,
      pageSize: apiKeyPage.pageSize,
      total: apiKeyPage.total,
      totalPages: apiKeyPage.totalPages,
      summary: apiKeySummary,
    } : null,
    credit: canReadCredit ? audienceCredit(repo, targetUserId, isSelf) : null,
    usage: usage ? {
      totalTokens: usage.totalTokens,
      billableAmount: usage.billableAmount,
      calculatedCost: usage.calculatedCost,
    } : null,
    capabilities: {
      canReadApiKeys: isSelf,
      canManageApiKeys: isSelf,
      canReadCredit,
      canReadPlanBudget,
    },
    calculatedAt,
  };
}

/**
 * PostgreSQL-backed self-audience projection used by Web/Admin callers.
 */
export async function loadUserAudienceAsync(input: {
  repo: UserAudienceAsyncApplicationOperationPort;
  identity: Pick<IdentityQueries, "getUser">;
  tenancy: Pick<TenancyQueries, "getTeam" | "getMembership">;
  viewerUserId: string;
  targetUserId: string;
  teamId?: string;
  apiKeyPage?: number;
  apiKeyPageSize?: DirectoryPageSize;
  apiKeyQuery?: string;
  calculatedAt?: string;
  hasPermission?: UserAudienceAsyncPermissionCheck;
}): Promise<UserAudienceViewModel | null> {
  const { repo, identity, tenancy, viewerUserId, targetUserId } = input;
  const user = await identity.getUser(targetUserId);
  if (!user) return null;

  const isSelf = viewerUserId === targetUserId;
  if (!isSelf) {
    const teamId = input.teamId ?? null;
    if (!teamId) return null;
    const team = teamId ? await tenancy.getTeam(teamId) : undefined;
    if (!team || team.status !== "enabled") return null;
    const [viewerMembership, targetMembership] = await Promise.all([
      tenancy.getMembership(teamId, viewerUserId),
      tenancy.getMembership(teamId, targetUserId),
    ]);
    if (!viewerMembership || !targetMembership || !(await input.hasPermission?.(teamId, "team.member.read"))) return null;
    const canReadCredit = Boolean(await input.hasPermission?.(teamId, "team.credit.read"));
    const canReadPlanBudget = Boolean(
      await input.hasPermission?.(teamId, "team.usage.read")
      && await input.hasPermission?.(teamId, "team.billing.read"),
    );
    const lastSeenAt = await repo.latestRequestStartedAtForUser(user.id);
    return {
      audience: { viewerUserId, targetUserId, perspective: "teamMember", teamId },
      user: {
        id: user.id,
        teamId,
        name: displayNameFromEmail(user.email),
        email: user.email,
        role: team.ownerId === user.id ? "Owner" : "User",
        status: user.status === "enabled" ? "Active" : "Disabled",
        apiKeyLimit: user.apiKeyLimit,
        userCanCreateCustomProvider: user.userCanCreateCustomProvider,
        userCanCreateAccessPoint: user.userCanCreateAccessPoint,
        apiKeys: "Restricted",
        lastSeen: formatLastSeen(lastSeenAt),
        lastSeenAt,
        createdAt: formatUtcDate(user.createdAt),
        createdAtIso: user.createdAt,
      },
      apiKeys: null,
      credit: canReadCredit ? await audienceCreditAsync(repo, targetUserId) : null,
      usage: null,
      capabilities: {
        canReadApiKeys: false,
        canManageApiKeys: false,
        canReadCredit,
        canReadPlanBudget,
      },
      calculatedAt: input.calculatedAt ?? new Date().toISOString(),
    };
  }
  const calculatedAt = input.calculatedAt ?? new Date().toISOString();
  const navigation = await repo.userNavigationSummary(targetUserId);
  const primaryTeam = navigation.items[0];
  const teamId = primaryTeam?.id ?? null;
  const [apiKeySummary, apiKeyPage, usage, lastSeenAt, credit] = await Promise.all([
    repo.getUserApiKeyDirectoryMetrics(targetUserId, calculatedAt),
    repo.pageUserApiKeyDirectory(targetUserId, {
      ...(input.apiKeyPage === undefined ? {} : { page: input.apiKeyPage }),
      ...(input.apiKeyPageSize === undefined ? {} : { pageSize: input.apiKeyPageSize }),
      ...(input.apiKeyQuery === undefined ? {} : { query: input.apiKeyQuery }),
    }, calculatedAt),
    repo.usageSummary({ userId: targetUserId }),
    repo.latestRequestStartedAtForUser(user.id),
    audienceCreditAsync(repo, targetUserId),
  ]);

  return {
    audience: {
      viewerUserId,
      targetUserId,
      perspective: "self",
      teamId,
    },
    user: {
      id: user.id,
      teamId: teamId ?? "",
      name: displayNameFromEmail(user.email),
      email: user.email,
      role: primaryTeam?.ownerId === user.id ? "Owner" : "User",
      status: user.status === "enabled" ? "Active" : "Disabled",
      apiKeyLimit: user.apiKeyLimit,
      userCanCreateCustomProvider: user.userCanCreateCustomProvider,
      userCanCreateAccessPoint: user.userCanCreateAccessPoint,
      apiKeys: String(apiKeySummary.totalKeys),
      lastSeen: formatLastSeen(lastSeenAt),
      lastSeenAt,
      createdAt: formatUtcDate(user.createdAt),
      createdAtIso: user.createdAt,
    },
    apiKeys: {
      items: apiKeyPage.items.map(audienceApiKey),
      page: apiKeyPage.page,
      pageSize: apiKeyPage.pageSize,
      total: apiKeyPage.total,
      totalPages: apiKeyPage.totalPages,
      summary: apiKeySummary,
    },
    credit,
    usage: {
      totalTokens: usage.totalTokens,
      billableAmount: usage.billableAmount,
      calculatedCost: usage.calculatedCost,
    },
    capabilities: {
      canReadApiKeys: true,
      canManageApiKeys: true,
      canReadCredit: true,
      canReadPlanBudget: true,
    },
    calculatedAt,
  };
}

export function loadUserAudienceApiKeyDetail(
  repo: UserAudienceApplicationOperationPort,
  targetUserId: string,
  apiKeyId: string,
): UserAudienceApiKeyDetail | null {
  const apiKey = repo.getUserApiKeyDetail(targetUserId, apiKeyId);
  if (!apiKey) return null;
  const lastUsedAt = repo.latestRequestStartedAtForApiKey(apiKey.id);
  const budget = activeAmountBudget(repo, targetUserId);
  const usage = repo.usageSummary({ apiKeyId: apiKey.id });
  const planUsage = usagePercentForBudget(usage.calculatedCost, budget.limitValue);

  return {
    id: apiKey.id,
    userId: apiKey.userId,
    name: apiKey.name,
    prefix: apiKey.keyPrefix,
    status: apiKeyStatus(apiKey.status),
    scope: `key:${apiKey.id}`,
    planUsage,
    budget: formatBudgetLabel(budget.limitValue, budget.windowLabel),
    lastUsed: formatLastSeen(lastUsedAt),
    lastUsedAt,
    createdAt: formatUtcDate(apiKey.createdAt),
    createdAtIso: apiKey.createdAt,
    expiresAt: formatOptionalDateTime(apiKey.expiresAt),
    revokedAt: formatOptionalDateTime(apiKey.revokedAt),
    totalTokens: formatInteger(usage.totalTokens),
    calculatedCost: formatCurrency(usage.calculatedCost),
  };
}

export async function loadUserAudienceApiKeyDetailAsync(
  repo: UserAudienceAsyncApplicationOperationPort,
  targetUserId: string,
  apiKeyId: string,
): Promise<UserAudienceApiKeyDetail | null> {
  const apiKey = await repo.getUserApiKeyDetail(targetUserId, apiKeyId);
  if (!apiKey) return null;
  const [lastUsedAt, budget, usage] = await Promise.all([
    repo.latestRequestStartedAtForApiKey(apiKey.id),
    activeAmountBudgetAsync(repo, targetUserId),
    repo.usageSummary({ apiKeyId: apiKey.id }),
  ]);
  const planUsage = usagePercentForBudget(usage.calculatedCost, budget.limitValue);

  return {
    id: apiKey.id,
    userId: apiKey.userId,
    name: apiKey.name,
    prefix: apiKey.keyPrefix,
    status: apiKeyStatus(apiKey.status),
    scope: `key:${apiKey.id}`,
    planUsage,
    budget: formatBudgetLabel(budget.limitValue, budget.windowLabel),
    lastUsed: formatLastSeen(lastUsedAt),
    lastUsedAt,
    createdAt: formatUtcDate(apiKey.createdAt),
    createdAtIso: apiKey.createdAt,
    expiresAt: formatOptionalDateTime(apiKey.expiresAt),
    revokedAt: formatOptionalDateTime(apiKey.revokedAt),
    totalTokens: formatInteger(usage.totalTokens),
    calculatedCost: formatCurrency(usage.calculatedCost),
  };
}

function canReadTeamMember(
  tenancy: Pick<ApplicationOperationPort, "getTeam" | "getTeamMembership">,
  viewerUserId: string,
  targetUserId: string,
  teamId: string | null,
  hasPermission: UserAudiencePermissionCheck | undefined,
): boolean {
  if (!teamId || !hasPermission) return false;
  const team = tenancy.getTeam(teamId);
  if (!team || team.status !== "enabled") return false;
  const viewerIsOwner = team.ownerId === viewerUserId;
  if (!viewerIsOwner && !tenancy.getTeamMembership(teamId, viewerUserId)) return false;
  const targetIsOwner = team.ownerId === targetUserId;
  if (!targetIsOwner && !tenancy.getTeamMembership(teamId, targetUserId)) return false;
  return hasPermission(teamId, "team.member.read");
}

function audienceApiKey(apiKey: UserApiKeyDirectoryRow): UserAudienceApiKey {
  return {
    id: apiKey.id,
    userId: apiKey.userId,
    name: apiKey.name,
    prefix: apiKey.keyPrefix,
    status: apiKeyStatus(apiKey.status),
    scope: `key:${apiKey.id}`,
    planUsage: usagePercentForBudget(apiKey.calculatedCost, apiKey.budgetLimit),
    budget: formatBudgetLabel(
      apiKey.budgetLimit,
      apiKey.budgetWindowType === "fixed" && apiKey.budgetWindowSeconds
        ? formatDuration(apiKey.budgetWindowSeconds)
        : apiKey.budgetWindowType === "cumulative" ? "plan" : null,
    ),
    lastUsed: formatLastSeen(apiKey.lastUsedAt),
    lastUsedAt: apiKey.lastUsedAt,
    createdAt: formatUtcDate(apiKey.createdAt),
    createdAtIso: apiKey.createdAt,
  };
}

function audienceCredit(repo: UserAudienceApplicationOperationPort, userId: string, includeHistory: boolean): UserAudienceCredit {
  const scopeRef = `user:${userId}` as const;
  const account = repo.findCreditAccountForScope(scopeRef);
  const events = includeHistory && account
    ? repo.listCreditLedgerEventsForAccount(account.id, 20)
    : [];
  return {
    accountId: account?.id ?? "No account",
    scopeRef,
    status: account?.status ?? "not_created",
    balance: formatCreditCurrency(creditUnitsToUsd(account?.balanceSnapUnits ?? 0)),
    transferOutEnabled: repo.isCreditTransferOutEnabled(scopeRef),
    recentEvents: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      amount: formatCreditCurrency(creditUnitsToUsd(event.amountUnits)),
      reason: event.reason ?? "No reason",
      actorUserId: event.actorUserId ?? "system",
      relatedEventId: event.relatedEventId ?? "None",
      createdAt: formatUtcDateTime(event.createdAt),
      createdAtIso: event.createdAt,
    })),
  };
}

async function audienceCreditAsync(repo: UserAudienceAsyncApplicationOperationPort, userId: string): Promise<UserAudienceCredit> {
  const scopeRef = `user:${userId}` as const;
  const account = await repo.findCreditAccountForScope(scopeRef);
  const [events, transferOutEnabled] = await Promise.all([
    account ? repo.listCreditLedgerEventsForAccount(account.id, 20) : Promise.resolve([]),
    repo.isCreditTransferOutEnabled(scopeRef),
  ]);
  return {
    accountId: account?.id ?? "No account",
    scopeRef,
    status: account?.status ?? "not_created",
    balance: formatCreditCurrency(creditUnitsToUsd(account?.balanceSnapUnits ?? 0)),
    transferOutEnabled,
    recentEvents: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      amount: formatCreditCurrency(creditUnitsToUsd(event.amountUnits)),
      reason: event.reason ?? "No reason",
      actorUserId: event.actorUserId ?? "system",
      relatedEventId: event.relatedEventId ?? "None",
      createdAt: formatUtcDateTime(event.createdAt),
      createdAtIso: event.createdAt,
    })),
  };
}

function activeAmountBudget(repo: UserAudienceApplicationOperationPort, userId: string): {
  limitValue: number | null;
  windowLabel: string | null;
} {
  const active = repo.getActivePlanIdentity([`user:${userId}`]);
  if (!active) return { limitValue: null, windowLabel: null };
  const policy = repo.getPrimarySubscriptionAmountLimit(active.planId);
  if (!policy) return { limitValue: null, windowLabel: null };
  return {
    limitValue: policy.limitValue,
    windowLabel: policy.windowType === "fixed"
      ? `${formatDuration(policy.windowSeconds ?? 0)} fixed`
      : "plan",
  };
}

async function activeAmountBudgetAsync(repo: UserAudienceAsyncApplicationOperationPort, userId: string): Promise<{
  limitValue: number | null;
  windowLabel: string | null;
}> {
  const active = await repo.getActivePlanIdentity([`user:${userId}`]);
  if (!active) return { limitValue: null, windowLabel: null };
  const limits = (await repo.listPlanBudgetLimitsForPlans([active.planId])).get(active.planId) ?? [];
  const policy = limits
    .filter((limit) => limit.limitScope === "subscription" && limit.metric === "amount")
    .sort((left, right) =>
      (left.windowType === right.windowType ? 0 : left.windowType === "cumulative" ? -1 : 1)
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id),
    )[0];
  if (!policy) return { limitValue: null, windowLabel: null };
  return {
    limitValue: policy.limitValue,
    windowLabel: policy.windowType === "fixed"
      ? `${formatDuration(policy.windowSeconds ?? 0)} fixed`
      : "plan",
  };
}

function apiKeyStatus(status: string): UserAudienceApiKey["status"] {
  if (status.toLowerCase() === "revoked") return "Revoked";
  if (["paused", "disabled"].includes(status.toLowerCase())) return "Disabled";
  return "Active";
}

function usagePercentForBudget(cost: number, amountLimit: number | null): number {
  if (!amountLimit || amountLimit <= 0) return 0;
  return Math.min(100, Math.round((cost / amountLimit) * 100));
}

function formatBudgetLabel(value: number | null, period: string | null): string {
  if (value === null) return "No cap";
  return `${formatCurrency(value)}${period ? `/${period}` : ""}`;
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${seconds}s`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function formatCreditCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(value);
}

function formatUtcDate(value: string): string {
  return formatDate(value, false);
}

function formatUtcDateTime(value: string): string {
  return formatDate(value, true);
}

function formatDate(value: string, withTime: boolean): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
    timeZone: "UTC",
  }).format(date);
}

function formatLastSeen(value: string | null): string {
  return value ? formatUtcDateTime(value) : "Never";
}

function formatOptionalDateTime(value: string | null): string {
  return value ? formatUtcDateTime(value) : "Never";
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function displayNameFromEmail(email: string): string {
  return email.split("@")[0]?.split(/[._-]/).filter(Boolean).map(titleCase).join(" ") || email;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
