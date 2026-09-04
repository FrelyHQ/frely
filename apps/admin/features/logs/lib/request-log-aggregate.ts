import { requestLogMatchesFilter, type UiQueryPort, type UiSyncQueryPort, type RequestLog, type RequestLogListFilter } from "@frely/ui-application/server";
import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { formatUtcDateTime } from "@frely/ui/lib/date-time";
import { formatIngressPlugins, formatPipelinePlugins, type RequestLogRow, type Tone } from "./request-log-display";
import type { IdentityQueries } from "@frely/identity/server";
import type { TenancyQueries } from "@frely/tenancy/server";

export const REQUEST_LOG_PAGE_SIZE = 20;

export interface RequestLogsAggregate {
  rows: RequestLogRow[];
  providerOptions: { value: string; label: string; description?: string; searchText?: string }[];
  modelOptions: { value: string; label: string; description?: string; searchText?: string }[];
  apiKeyOptions: { id: string; name: string; keyPrefix: string }[];
  ownerOptions: { value: string; label: string; description?: string; searchText?: string }[];
  total: number;
  failed: number;
  queryStatus: string;
  queryProviderId: string;
  queryModel: string;
  queryApiKeyId: string;
  queryOwner: string;
  queryDuration: string;
  queryTimeWindow: string;
  queryStart: string;
  queryEnd: string;
  page: number;
  pageSize: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export function buildRequestLogsAggregate(repo: UiSyncQueryPort, identity: Pick<UiSyncQueryPort, "listUsers" | "listApiKeys">, tenancy: Pick<UiSyncQueryPort, "listTeams">, queryStatus = "", queryTimeWindow = "", queryStart = "", queryPage = 1, queryPageSize = 20, queryProviderId = "", queryModel = "", queryApiKeyId = "", queryOwner = "", queryDuration = "", requestLogsOverride?: RequestLog[]): RequestLogsAggregate {
  const pageSize = normalizeTablePageSize(queryPageSize);
  const providerList = repo.listProviders();
  const userList = identity.listUsers();
  const teamList = tenancy.listTeams();
  const apiKeyList = identity.listApiKeys();
  const allRequestLogs = requestLogsOverride ?? null;
  const providers = new Map(providerList.map((provider) => [provider.id, provider.name]));
  const users = new Map(userList.map((user) => [user.id, user.email]));
  const teams = new Map(teamList.map((team) => [team.id, team.name]));
  const apiKeys = new Map(apiKeyList.map((apiKey) => [apiKey.id, `${apiKey.name} (${apiKey.keyPrefix})`]));
  const normalizedTimeWindow = normalizeTimeWindowQuery(queryTimeWindow);
  const normalizedStatus = normalizeStatusQuery(queryStatus);
  const normalizedStart = normalizeDateQuery(queryStart);
  const normalizedProviderId = providerList.some((provider) => provider.id === queryProviderId) ? queryProviderId : "";
  const normalizedApiKeyId = apiKeyList.some((apiKey) => apiKey.id === queryApiKeyId) ? queryApiKeyId : "";
  const normalizedModel = normalizeTextQuery(queryModel);
  const normalizedOwner = normalizeOwnerQuery(queryOwner, users, teams);
  const normalizedDuration = normalizeDurationFilter(queryDuration);
  const listFilter: RequestLogListFilter = {
    ...timeFilter(normalizedTimeWindow, normalizedStart),
    ...ownerFilter(normalizedOwner),
    ...durationFilter(normalizedDuration),
    ...(normalizedStatus ? { status: normalizedStatus } : {}),
    ...(normalizedProviderId ? { providerId: normalizedProviderId } : {}),
    ...(normalizedApiKeyId ? { apiKeyId: normalizedApiKeyId } : {}),
    ...(normalizedModel ? { model: normalizedModel } : {})
  };
  const countFilter: RequestLogListFilter = {
    ...timeFilter(normalizedTimeWindow, normalizedStart),
    ...ownerFilter(normalizedOwner),
    ...durationFilter(normalizedDuration),
    ...(normalizedProviderId ? { providerId: normalizedProviderId } : {}),
    ...(normalizedApiKeyId ? { apiKeyId: normalizedApiKeyId } : {}),
    ...(normalizedModel ? { model: normalizedModel } : {})
  };
  const matchingRequestLogs = allRequestLogs ? allRequestLogs.filter((log) => requestLogMatchesFilter(log, listFilter)) : null;
  const total = matchingRequestLogs?.length ?? repo.countRequestLogs(listFilter);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(queryPage) || 1), totalPages);
  const requestLogs = matchingRequestLogs
    ? matchingRequestLogs.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id)).slice((page - 1) * pageSize, page * pageSize)
    : repo.listRecentRequestLogs(listFilter, pageSize, (page - 1) * pageSize);
  const rows = requestLogs
    .map((request) => {
      const provider = request.providerId ? providers.get(request.providerId) ?? request.providerId : "Unresolved";
      const errorCode = request.errorCode ?? "None";
      return {
        id: request.id,
        startedAt: request.startedAt,
        time: formatUtcDateTime(request.startedAt, { seconds: true }),
        duration: formatDuration(request.startedAt, request.endedAt),
        status: titleCase(request.status),
        statusTone: statusTone(request.status),
        errorCode,
        ingressPlugins: formatIngressPlugins(request.ingressPluginsJson),
        pipelinePlugins: formatPipelinePlugins(request.pipelinePluginsJson),
        requestPath: request.requestPath ?? "Unknown",
        ingressHostname: request.ingressHostname ?? "Legacy / unavailable",
        ingressRouteId: request.ingressRouteId ?? "Legacy / unavailable",
        provider,
        model: request.tarModel ? `${request.reqModel} -> ${request.tarModel}` : request.reqModel,
        apiKey: apiKeys.get(request.apiKeyId) ?? request.apiKeyId,
        user: users.get(request.userId) ?? request.userId,
        team: request.teamId ? teams.get(request.teamId) ?? request.teamId : "No Team (personal/global)"
      } satisfies RequestLogRow;
    });

  return {
    rows,
    providerOptions: providerList.map((provider) => ({ value: provider.id, label: provider.name, description: provider.kind, searchText: `${provider.id} ${provider.name} ${provider.kind}` })),
    modelOptions: modelOptions(allRequestLogs ?? repo.listRequestLogModels()),
    apiKeyOptions: apiKeyList.map((apiKey) => ({ id: apiKey.id, name: apiKey.name, keyPrefix: apiKey.keyPrefix })),
    ownerOptions: [
      ...userList.map((user) => ({ value: `user:${user.id}`, label: user.email, description: "User", searchText: `${user.id} ${user.email}` })),
      ...teamList.map((team) => ({ value: `team:${team.id}`, label: team.name, description: "Team", searchText: `${team.id} ${team.name}` }))
    ],
    total,
    failed: allRequestLogs ? allRequestLogs.filter((log) => requestLogMatchesFilter(log, { ...countFilter, status: "failed" })).length : repo.countRequestLogs({ ...countFilter, status: "failed" }),
    queryStatus: normalizedStatus,
    queryProviderId: normalizedProviderId,
    queryModel: normalizedModel,
    queryApiKeyId: normalizedApiKeyId,
    queryOwner: normalizedOwner,
    queryDuration: normalizedDuration,
    queryTimeWindow: normalizedTimeWindow,
    queryStart: listFilter.startedAtGte ?? "",
    queryEnd: listFilter.startedAtLte ?? "",
    page,
    pageSize,
    totalPages,
    hasPreviousPage: page > 1,
    hasNextPage: page < totalPages
  };
}

export async function buildRequestLogsAggregateAsync(
  repo: Pick<UiQueryPort, "listProviders" | "countRequestLogs" | "listRecentRequestLogs" | "listRequestLogModels">,
  identity: Pick<IdentityQueries, "listUsers" | "listApiKeys">,
  tenancy: Pick<TenancyQueries, "listTeams">,
  queryStatus = "",
  queryTimeWindow = "",
  queryStart = "",
  queryPage = 1,
  queryPageSize = 20,
  queryProviderId = "",
  queryModel = "",
  queryApiKeyId = "",
  queryOwner = "",
  queryDuration = "",
  requestLogsOverride?: RequestLog[],
): Promise<RequestLogsAggregate> {
  const pageSize = normalizeTablePageSize(queryPageSize);
  const [providerList, userList, teamList, apiKeyList] = await Promise.all([
    repo.listProviders(),
    identity.listUsers(),
    tenancy.listTeams(),
    identity.listApiKeys(),
  ]);
  const allRequestLogs = requestLogsOverride ?? null;
  const providers = new Map(providerList.map((provider) => [provider.id, provider.name]));
  const users = new Map(userList.map((user) => [user.id, user.email]));
  const teams = new Map(teamList.map((team) => [team.id, team.name]));
  const apiKeys = new Map(apiKeyList.map((apiKey) => [apiKey.id, `${apiKey.name} (${apiKey.keyPrefix})`]));
  const normalizedTimeWindow = normalizeTimeWindowQuery(queryTimeWindow);
  const normalizedStatus = normalizeStatusQuery(queryStatus);
  const normalizedStart = normalizeDateQuery(queryStart);
  const normalizedProviderId = providerList.some((provider) => provider.id === queryProviderId) ? queryProviderId : "";
  const normalizedApiKeyId = apiKeyList.some((apiKey) => apiKey.id === queryApiKeyId) ? queryApiKeyId : "";
  const normalizedModel = normalizeTextQuery(queryModel);
  const normalizedOwner = normalizeOwnerQuery(queryOwner, users, teams);
  const normalizedDuration = normalizeDurationFilter(queryDuration);
  const listFilter: RequestLogListFilter = {
    ...timeFilter(normalizedTimeWindow, normalizedStart),
    ...ownerFilter(normalizedOwner),
    ...durationFilter(normalizedDuration),
    ...(normalizedStatus ? { status: normalizedStatus } : {}),
    ...(normalizedProviderId ? { providerId: normalizedProviderId } : {}),
    ...(normalizedApiKeyId ? { apiKeyId: normalizedApiKeyId } : {}),
    ...(normalizedModel ? { model: normalizedModel } : {}),
  };
  const countFilter: RequestLogListFilter = {
    ...timeFilter(normalizedTimeWindow, normalizedStart),
    ...ownerFilter(normalizedOwner),
    ...durationFilter(normalizedDuration),
    ...(normalizedProviderId ? { providerId: normalizedProviderId } : {}),
    ...(normalizedApiKeyId ? { apiKeyId: normalizedApiKeyId } : {}),
    ...(normalizedModel ? { model: normalizedModel } : {}),
  };
  const matchingRequestLogs = allRequestLogs ? allRequestLogs.filter((log) => requestLogMatchesFilter(log, listFilter)) : null;
  const total = matchingRequestLogs?.length ?? await repo.countRequestLogs(listFilter);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(queryPage) || 1), totalPages);
  const requestLogs = matchingRequestLogs
    ? matchingRequestLogs.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id)).slice((page - 1) * pageSize, page * pageSize)
    : await repo.listRecentRequestLogs(listFilter, pageSize, (page - 1) * pageSize);
  const rows = requestLogs.map((request) => {
    const provider = request.providerId ? providers.get(request.providerId) ?? request.providerId : "Unresolved";
    const errorCode = request.errorCode ?? "None";
    return {
      id: request.id,
      startedAt: request.startedAt,
      time: formatUtcDateTime(request.startedAt, { seconds: true }),
      duration: formatDuration(request.startedAt, request.endedAt),
      status: titleCase(request.status),
      statusTone: statusTone(request.status),
      errorCode,
      ingressPlugins: formatIngressPlugins(request.ingressPluginsJson),
      pipelinePlugins: formatPipelinePlugins(request.pipelinePluginsJson),
      requestPath: request.requestPath ?? "Unknown",
      ingressHostname: request.ingressHostname ?? "Legacy / unavailable",
      ingressRouteId: request.ingressRouteId ?? "Legacy / unavailable",
      provider,
      model: request.tarModel ? `${request.reqModel} -> ${request.tarModel}` : request.reqModel,
      apiKey: apiKeys.get(request.apiKeyId) ?? request.apiKeyId,
      user: users.get(request.userId) ?? request.userId,
      team: request.teamId ? teams.get(request.teamId) ?? request.teamId : "No Team (personal/global)",
    } satisfies RequestLogRow;
  });
  const modelValues = allRequestLogs ?? await repo.listRecentRequestLogs({}, 10_000);
  const failed = allRequestLogs
    ? allRequestLogs.filter((log) => requestLogMatchesFilter(log, { ...countFilter, status: "failed" })).length
    : await repo.countRequestLogs({ ...countFilter, status: "failed" });
  return {
    rows,
    providerOptions: providerList.map((provider) => ({ value: provider.id, label: provider.name, description: provider.kind, searchText: `${provider.id} ${provider.name} ${provider.kind}` })),
    modelOptions: modelOptions(allRequestLogs ?? modelValues),
    apiKeyOptions: apiKeyList.map((apiKey) => ({ id: apiKey.id, name: apiKey.name, keyPrefix: apiKey.keyPrefix })),
    ownerOptions: [
      ...userList.map((user) => ({ value: `user:${user.id}`, label: user.email, description: "User", searchText: `${user.id} ${user.email}` })),
      ...teamList.map((team) => ({ value: `team:${team.id}`, label: team.name, description: "Team", searchText: `${team.id} ${team.name}` })),
    ],
    total,
    failed,
    queryStatus: normalizedStatus,
    queryProviderId: normalizedProviderId,
    queryModel: normalizedModel,
    queryApiKeyId: normalizedApiKeyId,
    queryOwner: normalizedOwner,
    queryDuration: normalizedDuration,
    queryTimeWindow: normalizedTimeWindow,
    queryStart: listFilter.startedAtGte ?? "",
    queryEnd: listFilter.startedAtLte ?? "",
    page,
    pageSize,
    totalPages,
    hasPreviousPage: page > 1,
    hasNextPage: page < totalPages,
  };
}

function normalizeStatusQuery(value: string) {
  const normalized = value.trim().toLowerCase();
  return ["started", "pending", "completed", "failed"].includes(normalized) ? normalized : "";
}

function normalizeTimeWindowQuery(value: string) {
  const normalized = value.trim().toLowerCase();
  return durationMs(normalized) > 0 ? normalized : "";
}

function normalizeDateQuery(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? "" : trimmed;
}

function normalizeTextQuery(value: string) {
  return value.trim().slice(0, 120);
}

function normalizeOwnerQuery(value: string, users: Map<string, string>, teams: Map<string, string>) {
  const trimmed = value.trim();
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice("user:".length);
    return users.has(id) ? trimmed : "";
  }
  if (trimmed.startsWith("team:")) {
    const id = trimmed.slice("team:".length);
    return teams.has(id) ? trimmed : "";
  }
  return "";
}

function normalizeDurationFilter(value: string) {
  return ["open", "lt1s", "1s-5s", "5s-30s", "30s+"].includes(value) ? value : "";
}

function ownerFilter(owner: string): RequestLogListFilter {
  if (owner.startsWith("user:")) return { userId: owner.slice("user:".length) };
  if (owner.startsWith("team:")) return { teamId: owner.slice("team:".length) };
  return {};
}

function durationFilter(duration: string): RequestLogListFilter {
  if (duration === "open") return { durationOpen: true };
  if (duration === "lt1s") return { durationMsLte: 999 };
  if (duration === "1s-5s") return { durationMsGte: 1000, durationMsLte: 5000 };
  if (duration === "5s-30s") return { durationMsGte: 5000, durationMsLte: 30000 };
  if (duration === "30s+") return { durationMsGte: 30000 };
  return {};
}

function modelOptions(requestLogs: ReturnType<UiSyncQueryPort["listRequestLogs"]> | string[]) {
  const values = new Set<string>();
  for (const requestLog of requestLogs) {
    if (typeof requestLog === "string") {
      values.add(requestLog);
      continue;
    }
    values.add(requestLog.reqModel);
    if (requestLog.tarModel) values.add(requestLog.tarModel);
  }
  return Array.from(values).sort((left, right) => left.localeCompare(right)).map((model) => ({ value: model, label: model }));
}

function timeFilter(normalizedTimeWindow: string, normalizedStart: string): RequestLogListFilter {
  const filter: RequestLogListFilter = {};
  const duration = durationMs(normalizedTimeWindow);
  if (normalizedStart && duration > 0) {
    filter.startedAtLte = new Date(normalizedStart).toISOString();
    filter.startedAtGte = new Date(Date.parse(filter.startedAtLte) - duration).toISOString();
    return filter;
  }
  return filter;
}

function durationMs(value: string): number {
  if (value === "24h") return 24 * 60 * 60 * 1000;
  if (value === "3d") return 3 * 24 * 60 * 60 * 1000;
  if (value === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (value === "1mo") return 31 * 24 * 60 * 60 * 1000;
  const match = value.match(/^(\d+(?:\.\d+)?)(m|h|d|w|mo)$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = match[2];
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  if (unit === "w") return amount * 7 * 24 * 60 * 60 * 1000;
  if (unit === "mo") return amount * 31 * 24 * 60 * 60 * 1000;
  return 0;
}

function statusTone(status: string): Tone {
  const normalized = status.toLowerCase();
  if (normalized === "completed") return "good";
  if (normalized === "pending") return "warn";
  if (normalized === "failed") return "bad";
  return "neutral";
}

function formatDuration(startedAt: string, endedAt: string | null) {
  if (!endedAt) return "Open";
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "Unknown";
  return `${end - start}ms`;
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
