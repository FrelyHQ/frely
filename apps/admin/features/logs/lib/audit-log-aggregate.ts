import type { AuditLogDirectoryRow } from "@frely/ui-application/contracts";
import { formatUtcDateTime } from "@frely/ui/lib/date-time";
import type { AuditLogUrlState } from "../table/log-url-state";

type Tone = "good" | "warn" | "bad" | "neutral" | "info";
export const AUDIT_LOG_PAGE_SIZE = 20 as const;

export interface AuditLogRow {
  id: string;
  createdAt: string;
  time: string;
  actor: string;
  source: string;
  action: string;
  resource: string;
  result: string;
  resultTone: Tone;
}

export function buildAuditLogsAggregate(allLogs: AuditLogDirectoryRow[], filters: AuditLogUrlState, pagination?: { total: number; page: number; pageSize: AuditLogUrlState["pageSize"]; totalPages: number }) {
  if (pagination) return { rows: allLogs.map(toAuditLogRow), total: pagination.total, page: pagination.page, pageSize: pagination.pageSize, totalPages: pagination.totalPages, hasPreviousPage: pagination.page > 1, hasNextPage: pagination.page < pagination.totalPages };
  const normalizedActor = filters.actor.toLowerCase();
  const normalizedAction = filters.action.toLowerCase();
  const normalizedResource = filters.resource.toLowerCase();
  const matching = allLogs.filter((event) => {
    if (filters.source && event.source !== filters.source) return false;
    if (filters.result && event.result !== filters.result) return false;
    if (normalizedActor && `${event.actorType} ${event.actorId}`.toLowerCase().indexOf(normalizedActor) < 0) return false;
    if (normalizedAction && event.action.toLowerCase().indexOf(normalizedAction) < 0) return false;
    return !normalizedResource || `${event.resourceType}:${event.resourceId}`.toLowerCase().includes(normalizedResource);
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const total = matching.length;
  const totalPages = Math.max(1, Math.ceil(total / AUDIT_LOG_PAGE_SIZE));
  const page = Math.min(filters.page, totalPages);
  const rows = matching.slice((page - 1) * AUDIT_LOG_PAGE_SIZE, page * AUDIT_LOG_PAGE_SIZE).map(toAuditLogRow);
  return { rows, total, page, pageSize: AUDIT_LOG_PAGE_SIZE, totalPages, hasPreviousPage: page > 1, hasNextPage: page < totalPages };
}

function toAuditLogRow(row: AuditLogDirectoryRow): AuditLogRow {
  return {
    id: row.id,
    createdAt: row.createdAt,
    time: formatUtcDateTime(row.createdAt, { seconds: true }),
    actor: `${titleCase(row.actorType)} ${row.actorId}`,
    source: titleCase(row.source),
    action: titleCaseWords(row.action.replace(/[._]/g, " ")),
    resource: `${row.resourceType}:${row.resourceId}`,
    result: titleCase(row.result),
    resultTone: row.result === "success" ? "good" : row.result === "denied" ? "warn" : "bad"
  };
}

function titleCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase(); }
function titleCaseWords(value: string) { return value.split(/\s+/).filter(Boolean).map(titleCase).join(" "); }
