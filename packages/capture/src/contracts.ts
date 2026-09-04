import type { ProviderCredentialFailureReason } from "@frely/core";

export interface RequestLog {
  id: string;
  apiKeyId: string;
  userId: string;
  teamId: string | null;
  planId: string | null;
  planSubscriptionId: string | null;
  entryAccessPointId: string | null;
  billingScopeRef: string | null;
  providerId: string | null;
  requestPath: string | null;
  ingressHostname: string | null;
  ingressRouteId: string | null;
  reqModel: string;
  tarModel: string | null;
  ingressPluginsJson: string;
  pipelinePluginsJson: string;
  status: string;
  errorCode: string | null;
  credentialFailureReason: ProviderCredentialFailureReason | null;
  startedAt: string;
  endedAt: string | null;
}

export interface RequestLogArchiveEntry {
  requestId: string;
  userId: string;
  apiKeyId: string;
  teamId: string | null;
  startedAt: string;
  status: string;
  reqModel: string;
  ingressHostname: string | null;
  ingressRouteId: string | null;
  archiveMonth: string;
}

export interface RequestLogArchive {
  archiveMonth: string;
  formatVersion: number;
  schemaVersion: number;
  status: "generated" | "uploaded" | "verified" | "purged";
  rowCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
  objectKey: string;
  objectSha256: string;
  manifestObjectKey: string;
  manifestSha256: string;
  createdAt: string;
  uploadedAt: string | null;
  verifiedAt: string | null;
  purgedAt: string | null;
}

export interface RequestCaptureSetting {
  id: string;
  enabled: boolean;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface RequestCaptureDownloadSlot {
  slotId: number;
  ownerToken: string;
  acquiredAt: string;
}

export interface RequestLogListFilter {
  status?: string;
  userId?: string;
  teamId?: string;
  providerId?: string;
  apiKeyId?: string;
  ingressHostname?: string;
  model?: string;
  durationMsGte?: number;
  durationMsLte?: number;
  durationOpen?: boolean;
  startedAtGte?: string;
  startedAtLte?: string;
  cursorStartedAt?: string;
  cursorId?: string;
}

export type RequestLogArchiveEntryFilter = Pick<RequestLogListFilter,
  "status" | "userId" | "teamId" | "apiKeyId" | "ingressHostname" | "model" |
  "startedAtGte" | "startedAtLte" | "cursorStartedAt" | "cursorId"
>;

export interface RequestCaptureSettingPort {
  getRequestCaptureSetting(): RequestCaptureSetting;
  isRequestCaptureEnabled(): boolean;
  setRequestCaptureEnabled(enabled: boolean, updatedBy?: string | null): RequestCaptureSetting;
}

export interface RequestLogArchiveQueryPort {
  getVerifiedRequestLogArchiveForMonth(archiveMonth: string): Promise<RequestLogArchive | null | undefined>;
  listRecentRequestLogs(filter: RequestLogListFilter, limit?: number): Promise<RequestLog[]>;
  listRequestLogArchiveEntries(filter?: RequestLogArchiveEntryFilter, limit?: number): Promise<RequestLogArchiveEntry[]>;
}

export function requestLogMatchesFilter(log: RequestLog, filter: RequestLogListFilter): boolean {
  if (filter.status && log.status !== filter.status) return false;
  if (filter.userId && log.userId !== filter.userId) return false;
  if (filter.teamId && log.teamId !== filter.teamId) return false;
  if (filter.providerId && log.providerId !== filter.providerId) return false;
  if (filter.apiKeyId && log.apiKeyId !== filter.apiKeyId) return false;
  if (filter.ingressHostname && log.ingressHostname !== filter.ingressHostname) return false;
  if (filter.model) {
    const model = filter.model.toLocaleLowerCase();
    if (!log.reqModel.toLocaleLowerCase().includes(model) && !log.tarModel?.toLocaleLowerCase().includes(model)) return false;
  }
  if (filter.durationOpen) {
    if (log.endedAt !== null) return false;
  } else if (filter.durationMsGte !== undefined || filter.durationMsLte !== undefined) {
    if (!log.endedAt) return false;
    const duration = Math.round(Date.parse(log.endedAt) - Date.parse(log.startedAt));
    if (filter.durationMsGte !== undefined && duration < filter.durationMsGte) return false;
    if (filter.durationMsLte !== undefined && duration > filter.durationMsLte) return false;
  }
  if (filter.startedAtGte && log.startedAt < filter.startedAtGte) return false;
  if (filter.startedAtLte && log.startedAt > filter.startedAtLte) return false;
  if (filter.cursorStartedAt && filter.cursorId && !(log.startedAt < filter.cursorStartedAt || (log.startedAt === filter.cursorStartedAt && log.id < filter.cursorId))) return false;
  return true;
}
