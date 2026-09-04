import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";

export type SearchParams = Record<string, string | string[] | undefined>;

export interface RequestLogUrlState {
  status: string;
  providerId: string;
  model: string;
  apiKeyId: string;
  owner: string;
  duration: string;
  timeWindow: string;
  start: string;
  page: number;
  pageSize: TablePageSize;
}

export interface AuditLogUrlState {
  actor: string;
  source: string;
  action: string;
  resource: string;
  result: string;
  page: number;
  pageSize: TablePageSize;
}

const requestStatuses = new Set(["started", "pending", "completed", "failed"]);
const requestDurations = new Set(["open", "lt1s", "1s-5s", "5s-30s", "30s+"]);
const auditSources = new Set(["owner", "web", "gateway", "system"]);
const auditResults = new Set(["success", "failure", "denied"]);

export function parseRequestLogUrlState(params?: SearchParams): RequestLogUrlState {
  const status = normalizedEnum(singleValue(params?.status), requestStatuses);
  return {
    status,
    providerId: normalizedText(singleValue(params?.providerId), 160),
    model: normalizedText(singleValue(params?.model), 120),
    apiKeyId: normalizedText(singleValue(params?.apiKeyId), 160),
    owner: normalizedText(singleValue(params?.owner), 200),
    duration: normalizedEnum(singleValue(params?.duration), requestDurations),
    timeWindow: normalizeTimeWindow(singleValue(params?.timeWindow)) || "24h",
    start: normalizeDateTimeLocal(singleValue(params?.start)),
    page: normalizePage(singleValue(params?.page))
    ,pageSize: normalizeTablePageSize(params?.pageSize)
  };
}

export function parseAuditLogUrlState(params?: SearchParams): AuditLogUrlState {
  return {
    actor: normalizedText(singleValue(params?.actor), 160),
    source: normalizedEnum(singleValue(params?.source), auditSources),
    action: normalizedText(singleValue(params?.action), 120),
    resource: normalizedText(singleValue(params?.resource), 160),
    result: normalizedEnum(singleValue(params?.result), auditResults),
    page: normalizePage(singleValue(params?.page))
    ,pageSize: normalizeTablePageSize(params?.pageSize)
  };
}

export function requestLogsHref(state: RequestLogUrlState, overrides: Partial<RequestLogUrlState> = {}) {
  const value = { ...state, ...overrides };
  return href("/owner/request-logs", [
    ["status", value.status], ["providerId", value.providerId], ["model", value.model],
    ["apiKeyId", value.apiKeyId], ["owner", value.owner], ["duration", value.duration],
    ["timeWindow", value.timeWindow], ["start", value.start], ["page", value.page > 1 ? String(value.page) : ""],
    ["pageSize", value.pageSize !== 20 ? String(value.pageSize) : ""]
  ]);
}

export function auditLogsHref(state: AuditLogUrlState, overrides: Partial<AuditLogUrlState> = {}) {
  const value = { ...state, ...overrides };
  return href("/owner/audit-logs", [
    ["actor", value.actor], ["source", value.source], ["action", value.action],
    ["resource", value.resource], ["result", value.result], ["page", value.page > 1 ? String(value.page) : ""],
    ["pageSize", value.pageSize !== 20 ? String(value.pageSize) : ""]
  ]);
}

export function requestLogArchiveTimeFilter(start: string, timeWindow: string): { startedAtGte?: string; startedAtLte?: string } {
  const duration = durationMs(timeWindow);
  if (!duration || !start) return {};
  const endedAt = new Date(start);
  if (Number.isNaN(endedAt.getTime())) return {};
  return { startedAtGte: new Date(endedAt.getTime() - duration).toISOString(), startedAtLte: endedAt.toISOString() };
}

export function requestCaptureDownloadQuery(state: RequestLogUrlState): Record<string, string> {
  return Object.fromEntries([
    ["status", state.status], ["providerId", state.providerId], ["model", state.model],
    ["apiKeyId", state.apiKeyId], ["owner", state.owner], ["duration", state.duration],
    ["timeWindow", state.timeWindow], ["start", state.start]
  ].filter((entry) => Boolean(entry[1])));
}

function href(pathname: string, entries: Array<[string, string]>) {
  const params = new URLSearchParams(entries.filter((entry) => Boolean(entry[1])));
  return params.size ? `${pathname}?${params}` : pathname;
}

function singleValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function normalizedText(value: string, length: number) {
  return value.trim().slice(0, length);
}

function normalizedEnum(value: string, allowed: Set<string>) {
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : "";
}

function normalizePage(value: string) {
  if (!/^\d+$/.test(value)) return 1;
  return Math.max(1, Math.min(10_000, Number(value)));
}

function normalizeTimeWindow(value: string) {
  const normalized = value.trim().toLowerCase();
  return durationMs(normalized) ? normalized : "";
}

function normalizeDateTimeLocal(value: string) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const offsetMs = safeDate.getTimezoneOffset() * 60_000;
  return new Date(safeDate.getTime() - offsetMs).toISOString().slice(0, 16);
}

function durationMs(value: string) {
  if (value === "24h") return 86_400_000;
  if (value === "3d") return 259_200_000;
  if (value === "7d") return 604_800_000;
  if (value === "1mo") return 2_678_400_000;
  const match = value.match(/^(\d+(?:\.\d+)?)(m|h|d|w|mo)$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, mo: 2_678_400_000 } as const;
  return Number.isFinite(amount) && amount > 0 ? amount * units[match[2] as keyof typeof units] : 0;
}
