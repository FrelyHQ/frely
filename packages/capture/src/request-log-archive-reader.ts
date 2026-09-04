import { RelayError } from "@frely/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequestLogArchiveManifestV1, scanAndVerifyRequestLogsParquet, sha256Hex } from "./request-log-archive.js";
import type { ArchiveRemote } from "./archive-remote.js";
import type { RequestLog, RequestLogArchiveEntry, RequestLogListFilter } from "./contracts.js";
import { requestLogMatchesFilter } from "./contracts.js";
import type { RequestLogArchiveQueryPort } from "./contracts.js";

type RequestLogArchivePort = Pick<RequestLogArchiveQueryPort, "getVerifiedRequestLogArchiveForMonth">;

export class RequestLogArchiveReader {
  constructor(private readonly repo: RequestLogArchivePort, private readonly remote: ArchiveRemote) {}

  async getRequestLogsForEntries(entries: RequestLogArchiveEntry[]): Promise<Map<string, RequestLog>> {
    const result = new Map<string, RequestLog>();
    const byMonth = new Map<string, RequestLogArchiveEntry[]>();
    for (const entry of entries) {
      const group = byMonth.get(entry.archiveMonth) ?? [];
      group.push(entry);
      byMonth.set(entry.archiveMonth, group);
    }
    try {
      for (const [archiveMonth, requested] of byMonth) {
        const archive = await this.repo.getVerifiedRequestLogArchiveForMonth(archiveMonth);
        if (!archive) throw unavailable();
        const manifestBytes = await this.remote.read(archive.manifestObjectKey);
        if (sha256Hex(manifestBytes) !== archive.manifestSha256) throw unavailable();
        const manifest = parseRequestLogArchiveManifestV1(manifestBytes.toString("utf8"));
        if (manifest.objectKey !== archive.objectKey || manifest.sha256 !== archive.objectSha256 || manifest.recordCount !== archive.rowCount || manifest.uncompressedBytes !== archive.uncompressedBytes) throw unavailable();
        const head = await this.remote.head(archive.objectKey);
        if (head.bytes !== archive.compressedBytes || (head.sha256 !== null && head.sha256 !== archive.objectSha256)) throw unavailable();
        const requestedById = new Map(requested.map((entry) => [entry.requestId, entry]));
        const directory = await mkdtemp(join(tmpdir(), "friday-relay-request-log-archive-"));
        try {
          const path = join(directory, `request-logs-v${manifest.archiveFormatVersion}.parquet`);
          await this.remote.downloadToFile(archive.objectKey, path);
          await scanAndVerifyRequestLogsParquet(path, manifest, (row) => {
            const entry = requestedById.get(row.id);
            if (!entry) return;
            if (row.userId !== entry.userId || row.apiKeyId !== entry.apiKeyId || row.teamId !== entry.teamId || row.startedAt !== entry.startedAt || row.status !== entry.status || row.reqModel !== entry.reqModel || row.ingressHostname !== entry.ingressHostname || row.ingressRouteId !== entry.ingressRouteId) throw unavailable();
            result.set(row.id, row);
          });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        if (requested.some((entry) => !result.has(entry.requestId))) throw unavailable();
      }
      return result;
    } catch (error) {
      if (error instanceof RelayError && error.code === "request_log_archive_unavailable") throw error;
      throw unavailable();
    }
  }
}

export async function queryRequestLogsAcrossStorageAsync(
  repo: Pick<RequestLogArchiveQueryPort, "listRecentRequestLogs" | "listRequestLogArchiveEntries">,
  archiveReader: Pick<RequestLogArchiveReader, "getRequestLogsForEntries">,
  filter: RequestLogListFilter,
  limit = Number.MAX_SAFE_INTEGER,
  offset = 0,
): Promise<RequestLog[]> {
  const normalizedLimit = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.trunc(limit)));
  const normalizedOffset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(offset)));
  const requiredRows = Math.min(Number.MAX_SAFE_INTEGER, normalizedLimit + normalizedOffset);
  const hot = await repo.listRecentRequestLogs(filter, requiredRows);
  if (hot.length >= requiredRows) return hot.slice(normalizedOffset, requiredRows);
  const hotIds = new Set(hot.map((log) => log.id));
  const needsFullArchiveFiltering = filter.providerId !== undefined || filter.model !== undefined || filter.durationOpen !== undefined || filter.durationMsGte !== undefined || filter.durationMsLte !== undefined;
  const entries = (await repo.listRequestLogArchiveEntries({
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(filter.userId === undefined ? {} : { userId: filter.userId }),
    ...(filter.teamId === undefined ? {} : { teamId: filter.teamId }),
    ...(filter.apiKeyId === undefined ? {} : { apiKeyId: filter.apiKeyId }),
    ...(filter.ingressHostname === undefined ? {} : { ingressHostname: filter.ingressHostname }),
    ...(filter.startedAtGte === undefined ? {} : { startedAtGte: filter.startedAtGte }),
    ...(filter.startedAtLte === undefined ? {} : { startedAtLte: filter.startedAtLte }),
    ...(filter.cursorStartedAt === undefined ? {} : { cursorStartedAt: filter.cursorStartedAt }),
    ...(filter.cursorId === undefined ? {} : { cursorId: filter.cursorId }),
  }, needsFullArchiveFiltering ? undefined : Math.min(Number.MAX_SAFE_INTEGER, requiredRows + hot.length))).filter((entry) => !hotIds.has(entry.requestId));
  const archived = entries.length === 0 ? new Map<string, RequestLog>() : await archiveReader.getRequestLogsForEntries(entries);
  const merged = new Map(hot.map((log) => [log.id, log]));
  for (const log of archived.values()) if (requestLogMatchesFilter(log, filter)) merged.set(log.id, log);
  return [...merged.values()]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id))
    .slice(normalizedOffset, normalizedOffset + normalizedLimit);
}

function unavailable(): RelayError {
  return new RelayError("request_log_archive_unavailable", "Archived request logs are temporarily unavailable", 503);
}
