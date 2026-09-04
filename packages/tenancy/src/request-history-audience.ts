import type { IdentityQueries } from "@frely/identity/server";
import type { AsyncApplicationOperationPort, DirectoryPageSize } from "@frely/application/runtime";
import {
  queryRequestLogsAcrossStorageAsync,
  type RequestLog,
  type RequestLogArchiveReader,
  type RequestLogListFilter,
} from "@frely/capture";

const REQUEST_HISTORY_MODEL_OPTION_LIMIT = 20;

export type UserRequestHistoryStatus = "" | "started" | "completed" | "failed";
export type UserRequestHistoryDuration = "" | "open" | "lt1s" | "1s-5s" | "5s-30s" | "30s+";

export interface UserRequestHistoryFilter {
  status: UserRequestHistoryStatus;
  apiKeyId: string;
  model: string;
  duration: UserRequestHistoryDuration;
  start: string;
  timeWindow: string;
}

export interface UserRequestHistoryRow {
  id: string;
  kind: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  errorCode: string | null;
  requestPath: string | null;
  model: string;
  apiKey: {
    id: string;
    name: string;
    prefix: string;
  };
  capture: {
    requestPresent: boolean;
    responsePresent: boolean;
    downloadable: boolean;
  };
}

export interface UserRequestHistoryAudienceViewModel {
  audience: {
    viewerUserId: string;
    targetUserId: string;
    perspective: "self";
  };
  filter: UserRequestHistoryFilter;
  rows: UserRequestHistoryRow[];
  page: {
    pageSize: DirectoryPageSize;
    acceptedCursor: string;
    nextCursor: string | null;
    hasMore: boolean;
  };
  apiKeyOptions: {
    items: Array<{ id: string; name: string; keyPrefix: string }>;
    page: number;
    pageSize: DirectoryPageSize;
    total: number;
    totalPages: number;
  };
  modelOptions: Array<{ value: string; label: string }>;
  summary: {
    loadedRequests: number;
    downloadableCaptures: number;
  };
  capabilities: {
    canReadRequestHistory: true;
    canReadRequestCapture: true;
  };
  visibleActionIds: Array<
    | "user.request.capture.view"
    | "user.request.capture.download"
    | "user.request.capture.download.batch"
  >;
  calculatedAt: string;
}

export interface UserRequestHistoryCapturePresenceReader {
  getCapturePresenceForRequestLogsAsync(
    logs: RequestLog[],
  ): Promise<Map<string, { requestPresent: boolean; responsePresent: boolean }>>;
}

export interface UserRequestHistoryCaptureSummaryReader {
  listCapturedRequestSummariesForRequestLogsAsync(
    logs: RequestLog[],
  ): Promise<Map<string, { requestId: string; kind: string; reqModel: string; createdAt: string }>>;
}

export async function loadUserRequestHistoryAudienceAsync(input: {
  repo: Pick<AsyncApplicationOperationPort, "getUserApiKeyDetail" | "pageUserApiKeyDirectory" | "listApiKeySummariesByIds" | "listRecentRequestLogsForUser" | "listRequestLogArchiveEntries" | "listRecentRequestLogs">;
  identity: Pick<IdentityQueries, "getUser">;
  archiveReader: Pick<RequestLogArchiveReader, "getRequestLogsForEntries">;
  capturePresenceReader: UserRequestHistoryCapturePresenceReader;
  captureSummaryReader: UserRequestHistoryCaptureSummaryReader;
  viewerUserId: string;
  targetUserId: string;
  filter?: Partial<Record<keyof UserRequestHistoryFilter, string>>;
  cursor?: string;
  pageSize?: DirectoryPageSize;
  apiKeyPage?: number;
  apiKeyPageSize?: DirectoryPageSize;
  calculatedAt?: string;
}): Promise<UserRequestHistoryAudienceViewModel | null> {
  const { repo, identity, viewerUserId, targetUserId, archiveReader, capturePresenceReader, captureSummaryReader } = input;
  if (viewerUserId !== targetUserId || !(await identity.getUser(targetUserId))) return null;

  const filter = normalizeRequestHistoryFilter(input.filter);
  const selectedApiKey = filter.apiKeyId
    ? await repo.getUserApiKeyDetail(targetUserId, filter.apiKeyId)
    : null;
  if (filter.apiKeyId && !selectedApiKey) filter.apiKeyId = "";
  const cursor = decodeRequestHistoryCursor(input.cursor);
  const queryFilter: RequestLogListFilter = {
    userId: targetUserId,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.apiKeyId ? { apiKeyId: filter.apiKeyId } : {}),
    ...(filter.model ? { model: filter.model } : {}),
    ...durationFilter(filter.duration),
    ...timeFilter(filter.start, filter.timeWindow),
    ...(cursor ? { cursorStartedAt: cursor.startedAt, cursorId: cursor.id } : {}),
  };
  const pageSize = input.pageSize ?? 20;
  const logsWithSentinel = await queryRequestLogsAcrossStorageAsync(repo, archiveReader, queryFilter, pageSize + 1);
  const logs = logsWithSentinel.slice(0, pageSize);
  const hasMore = logsWithSentinel.length > pageSize;
  const last = logs.at(-1);
  const [presenceById, captureSummaryById] = await Promise.all([
    capturePresenceReader.getCapturePresenceForRequestLogsAsync(logs),
    captureSummaryReader.listCapturedRequestSummariesForRequestLogsAsync(logs),
  ]);
  const apiKeyById = new Map(
    (await repo.listApiKeySummariesByIds(targetUserId, logs.map((log) => log.apiKeyId))).map((apiKey) => [apiKey.id, apiKey]),
  );
  const apiKeyPage = await repo.pageUserApiKeyDirectory(targetUserId, {
    ...(input.apiKeyPage === undefined ? {} : { page: input.apiKeyPage }),
    ...(input.apiKeyPageSize === undefined ? {} : { pageSize: input.apiKeyPageSize }),
  });
  const apiKeyOptions = selectedApiKey && !apiKeyPage.items.some((item) => item.id === selectedApiKey.id)
    ? [selectedApiKey, ...apiKeyPage.items]
    : apiKeyPage.items;
  const rows = logs.map((log) => {
    const apiKey = apiKeyById.get(log.apiKeyId);
    const presence = presenceById.get(log.id) ?? { requestPresent: false, responsePresent: false };
    return {
      id: log.id,
      kind: captureSummaryById.get(log.id)?.kind ?? kindFromRequestPath(log.requestPath) ?? "unknown",
      startedAt: log.startedAt,
      endedAt: log.endedAt,
      status: log.status,
      errorCode: log.errorCode,
      requestPath: log.requestPath,
      model: log.reqModel,
      apiKey: apiKey
        ? { id: apiKey.id, name: apiKey.name, prefix: apiKey.keyPrefix }
        : { id: log.apiKeyId, name: "Unknown key", prefix: "" },
      capture: {
        requestPresent: presence.requestPresent,
        responsePresent: presence.responsePresent,
        downloadable: presence.requestPresent && presence.responsePresent,
      },
    } satisfies UserRequestHistoryRow;
  });

  return {
    audience: { viewerUserId, targetUserId, perspective: "self" },
    filter,
    rows,
    page: {
      pageSize,
      acceptedCursor: cursor ? encodeRequestHistoryCursor(cursor) : "",
      nextCursor: hasMore && last ? encodeRequestHistoryCursor({ startedAt: last.startedAt, id: last.id }) : null,
      hasMore,
    },
    apiKeyOptions: {
      items: apiKeyOptions.map((apiKey) => ({ id: apiKey.id, name: apiKey.name, keyPrefix: apiKey.keyPrefix })),
      page: apiKeyPage.page,
      pageSize: apiKeyPage.pageSize,
      total: apiKeyPage.total,
      totalPages: apiKeyPage.totalPages,
    },
    modelOptions: modelOptions(await repo.listRecentRequestLogsForUser(targetUserId, {}, REQUEST_HISTORY_MODEL_OPTION_LIMIT)),
    summary: { loadedRequests: rows.length, downloadableCaptures: rows.filter((row) => row.capture.downloadable).length },
    capabilities: { canReadRequestHistory: true, canReadRequestCapture: true },
    visibleActionIds: ["user.request.capture.view", "user.request.capture.download", "user.request.capture.download.batch"],
    calculatedAt: input.calculatedAt ?? new Date().toISOString(),
  };
}

export function requestHistoryBatchDownloadQuery(filter: UserRequestHistoryFilter): Record<string, string> {
  return Object.fromEntries(
    Object.entries(filter).filter(([, value]) => Boolean(value)),
  );
}

function normalizeRequestHistoryFilter(
  value: Partial<Record<keyof UserRequestHistoryFilter, string>> | undefined,
): UserRequestHistoryFilter {
  const status = String(value?.status ?? "").trim().toLowerCase();
  const duration = String(value?.duration ?? "").trim();
  const timeWindow = normalizeTimeWindow(String(value?.timeWindow ?? "")) || "24h";
  return {
    status: ["started", "completed", "failed"].includes(status)
      ? status as UserRequestHistoryStatus
      : "",
    apiKeyId: String(value?.apiKeyId ?? "").trim().slice(0, 200),
    model: String(value?.model ?? "").trim().slice(0, 120),
    duration: ["open", "lt1s", "1s-5s", "5s-30s", "30s+"].includes(duration)
      ? duration as UserRequestHistoryDuration
      : "",
    start: dateTimeLocalValue(String(value?.start ?? "")),
    timeWindow,
  };
}

function durationFilter(duration: UserRequestHistoryDuration): RequestLogListFilter {
  if (duration === "open") return { durationOpen: true };
  if (duration === "lt1s") return { durationMsLte: 999 };
  if (duration === "1s-5s") return { durationMsGte: 1000, durationMsLte: 5000 };
  if (duration === "5s-30s") return { durationMsGte: 5000, durationMsLte: 30_000 };
  if (duration === "30s+") return { durationMsGte: 30_000 };
  return {};
}

function timeFilter(start: string, timeWindow: string): RequestLogListFilter {
  const startedAtLte = dateParamToIso(start);
  const windowMs = durationMs(timeWindow);
  if (!startedAtLte || windowMs <= 0) return {};
  return {
    startedAtGte: new Date(Date.parse(startedAtLte) - windowMs).toISOString(),
    startedAtLte,
  };
}

function dateParamToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function dateTimeLocalValue(value: string): string {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const offsetMs = safeDate.getTimezoneOffset() * 60 * 1000;
  return new Date(safeDate.getTime() - offsetMs).toISOString().slice(0, 16);
}

function normalizeTimeWindow(value: string): string {
  const normalized = value.trim().toLowerCase();
  return durationMs(normalized) > 0 ? normalized : "";
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

function kindFromRequestPath(requestPath: string | null): string | null {
  if (!requestPath) return null;
  if (requestPath.includes("/responses")) return "responses";
  if (requestPath.includes("/chat/completions")) return "chat.completions";
  return null;
}

function modelOptions(logs: Array<{ reqModel: string }>) {
  return Array.from(new Set(logs.map((log) => log.reqModel)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, REQUEST_HISTORY_MODEL_OPTION_LIMIT)
    .map((value) => ({ value, label: value }));
}

interface RequestHistoryCursor {
  version: 1;
  startedAt: string;
  id: string;
}

function encodeRequestHistoryCursor(input: { startedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    startedAt: input.startedAt,
    id: input.id,
  } satisfies RequestHistoryCursor), "utf8").toString("base64url");
}

function decodeRequestHistoryCursor(value: string | undefined): RequestHistoryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<RequestHistoryCursor>;
    if (
      parsed.version !== 1
      || typeof parsed.startedAt !== "string"
      || Number.isNaN(Date.parse(parsed.startedAt))
      || typeof parsed.id !== "string"
      || !parsed.id
    ) return null;
    return { version: 1, startedAt: parsed.startedAt, id: parsed.id };
  } catch {
    return null;
  }
}
