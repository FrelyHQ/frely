import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  ParquetReader,
  ParquetSchema,
  ParquetWriter,
  type FieldDefinition,
  type ParquetCompression,
} from "@dsnp/parquetjs";
import { PARQUET_COMPRESSION_METHODS } from "@dsnp/parquetjs/dist/lib/compression.js";
import type { ArchiveRemote } from "./archive-remote.js";

export const REQUEST_CAPTURE_ARCHIVE_CATALOG_SCHEMA_VERSION = 1 as const;

export const REQUEST_CAPTURE_ARCHIVE_CATALOG_COLUMNS = [
  "request_id",
  "started_at",
  "ended_at",
  "status",
  "user_id",
  "team_id",
  "api_key_id",
  "request_path",
  "request_model",
  "pack_object_key",
  "frame_offset",
  "frame_length",
  "frame_uncompressed_length",
  "frame_sha256",
  "record_offset",
  "record_length",
  "record_sha256",
  "capture_schema_version",
] as const;

export interface RequestCaptureArchiveObject {
  objectKey: string;
  bytes: number;
  sha256: string;
}

export interface RequestCaptureArchiveCatalogRow {
  requestId: string;
  startedAt: string;
  endedAt: string;
  status: "completed" | "failed";
  userId: string;
  teamId: string | null;
  apiKeyId: string;
  requestPath: string | null;
  requestModel: string;
  packObjectKey: string;
  frameOffset: number;
  frameLength: number;
  frameUncompressedLength: number;
  frameSha256: string;
  recordOffset: number;
  recordLength: number;
  recordSha256: string;
  captureSchemaVersion: number;
}

export interface RequestCaptureArchiveCatalogFilter {
  requestId?: string;
  status?: "completed" | "failed";
  userId?: string;
  teamId?: string | null;
  apiKeyId?: string;
  requestPath?: string;
  requestModel?: string;
  startedAtGte?: string;
  startedAtLt?: string;
  endedAtGte?: string;
  endedAtLt?: string;
}

export type RequestCaptureArchiveQueryScope =
  | { kind: "request"; requestId: string }
  | { kind: "user"; userId: string }
  | { kind: "platform_owner" };

const QUERY_FILTER_KEYS = new Set([
  "requestId", "status", "userId", "teamId", "apiKeyId", "requestPath", "requestModel",
  "startedAtGte", "startedAtLt", "endedAtGte", "endedAtLt",
]);

export async function writeRequestCaptureArchiveCatalog(
  path: string,
  rows: readonly RequestCaptureArchiveCatalogRow[],
): Promise<number> {
  registerZstd();
  const writer = await ParquetWriter.openFile(requestCaptureArchiveCatalogSchema(), path, {
    rowGroupSize: 4096,
    pageSize: 8192,
    useDataPageV2: true,
  });
  writer.setMetadata("friday-relay.archive-kind", "request-capture-catalog");
  writer.setMetadata("friday-relay.catalog-schema-version", String(REQUEST_CAPTURE_ARCHIVE_CATALOG_SCHEMA_VERSION));
  const ids = new Set<string>();
  try {
    for (const row of rows) {
      assertCatalogRow(row);
      if (ids.has(row.requestId)) throw catalogError("request_capture_archive_catalog_duplicate_request_id");
      ids.add(row.requestId);
      await writer.appendRow(toParquetRow(row));
    }
    await writer.close();
    return rows.length;
  } catch (error) {
    try { await writer.close(); } catch { /* preserve the original error */ }
    throw error;
  }
}

export async function queryRequestCaptureArchiveCatalog(input: {
  remote: ArchiveRemote;
  catalog: RequestCaptureArchiveObject;
  archiveMonth: string;
  pack: RequestCaptureArchiveObject;
  recordCount: number;
  filter: RequestCaptureArchiveCatalogFilter;
  scope: RequestCaptureArchiveQueryScope;
}): Promise<RequestCaptureArchiveCatalogRow[]> {
  assertQuery(input.filter, input.scope);
  const rows = await readCatalogRows(input.remote, input.catalog);
  if (rows.length !== input.recordCount) throw catalogError("request_capture_archive_catalog_row_count_mismatch");
  const ids = new Set<string>();
  const matches: RequestCaptureArchiveCatalogRow[] = [];
  for (const row of rows) {
    assertCatalogRowForBundle(row, input.archiveMonth, input.pack);
    if (ids.has(row.requestId)) throw catalogError("request_capture_archive_catalog_duplicate_request_id");
    ids.add(row.requestId);
    if (!scopeAllows(input.scope, row)) continue;
    if (matchesFilter(row, input.filter)) matches.push(row);
  }
  return matches;
}

export async function readAndVerifyRequestCaptureArchiveCatalog(input: {
  remote: ArchiveRemote;
  catalog: RequestCaptureArchiveObject;
  archiveMonth: string;
  pack: RequestCaptureArchiveObject;
  recordCount: number;
}): Promise<RequestCaptureArchiveCatalogRow[]> {
  const rows = await readCatalogRows(input.remote, input.catalog);
  if (rows.length !== input.recordCount) throw catalogError("request_capture_archive_catalog_row_count_mismatch");
  const ids = new Set<string>();
  let previous: RequestCaptureArchiveCatalogRow | undefined;
  for (const row of rows) {
    assertCatalogRowForBundle(row, input.archiveMonth, input.pack);
    if (ids.has(row.requestId)) throw catalogError("request_capture_archive_catalog_duplicate_request_id");
    if (previous && (row.startedAt < previous.startedAt || (row.startedAt === previous.startedAt && row.requestId <= previous.requestId))) {
      throw catalogError("request_capture_archive_catalog_order_invalid");
    }
    ids.add(row.requestId);
    previous = row;
  }
  return rows;
}

function requestCaptureArchiveCatalogSchema(): ParquetSchema {
  const text = (): FieldDefinition => ({ type: "UTF8", compression: "ZSTD" as ParquetCompression });
  const optionalText = (): FieldDefinition => ({ ...text(), optional: true });
  const integer = (): FieldDefinition => ({ type: "INT64", compression: "ZSTD" as ParquetCompression });
  return new ParquetSchema({
    request_id: text(),
    started_at: text(),
    ended_at: text(),
    status: text(),
    user_id: text(),
    team_id: optionalText(),
    api_key_id: text(),
    request_path: optionalText(),
    request_model: text(),
    pack_object_key: text(),
    frame_offset: integer(),
    frame_length: integer(),
    frame_uncompressed_length: integer(),
    frame_sha256: text(),
    record_offset: integer(),
    record_length: integer(),
    record_sha256: text(),
    capture_schema_version: integer(),
  });
}

async function readCatalogRows(
  remote: ArchiveRemote,
  catalog: RequestCaptureArchiveObject,
): Promise<RequestCaptureArchiveCatalogRow[]> {
  const bytes = await remote.read(catalog.objectKey);
  if (bytes.length !== catalog.bytes || createHash("sha256").update(bytes).digest("hex") !== catalog.sha256) {
    throw catalogError("request_capture_archive_catalog_mismatch");
  }
  registerZstd();
  let reader: ParquetReader | undefined;
  try {
    reader = await ParquetReader.openBuffer(bytes);
    const fields = reader.getSchema().fieldList.filter((field) => !field.isNested).map((field) => field.name);
    if (fields.length !== REQUEST_CAPTURE_ARCHIVE_CATALOG_COLUMNS.length
      || fields.some((field, index) => field !== REQUEST_CAPTURE_ARCHIVE_CATALOG_COLUMNS[index])) {
      throw catalogError("request_capture_archive_catalog_schema_invalid");
    }
    const metadata = reader.getMetadata();
    if (metadata["friday-relay.archive-kind"] !== "request-capture-catalog"
      || metadata["friday-relay.catalog-schema-version"] !== String(REQUEST_CAPTURE_ARCHIVE_CATALOG_SCHEMA_VERSION)) {
      throw catalogError("request_capture_archive_catalog_schema_invalid");
    }
    // The explicit projection prevents any future, non-allowlisted column from
    // being read or returned even if a malformed Catalog reaches this point.
    const cursor = reader.getCursor(REQUEST_CAPTURE_ARCHIVE_CATALOG_COLUMNS as unknown as unknown[][]);
    const rows: RequestCaptureArchiveCatalogRow[] = [];
    while (true) {
      const value = await cursor.next();
      if (value === null) break;
      rows.push(fromParquetRow(value as Record<string, unknown>));
    }
    return rows;
  } catch (error) {
    if (hasCatalogCode(error)) throw error;
    throw catalogError("request_capture_archive_catalog_invalid");
  } finally {
    await reader?.close();
  }
}

function toParquetRow(row: RequestCaptureArchiveCatalogRow): Record<string, unknown> {
  return {
    request_id: row.requestId,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    status: row.status,
    user_id: row.userId,
    ...(row.teamId === null ? {} : { team_id: row.teamId }),
    api_key_id: row.apiKeyId,
    ...(row.requestPath === null ? {} : { request_path: row.requestPath }),
    request_model: row.requestModel,
    pack_object_key: row.packObjectKey,
    frame_offset: row.frameOffset,
    frame_length: row.frameLength,
    frame_uncompressed_length: row.frameUncompressedLength,
    frame_sha256: row.frameSha256,
    record_offset: row.recordOffset,
    record_length: row.recordLength,
    record_sha256: row.recordSha256,
    capture_schema_version: row.captureSchemaVersion,
  };
}

function fromParquetRow(row: Record<string, unknown>): RequestCaptureArchiveCatalogRow {
  const result: RequestCaptureArchiveCatalogRow = {
    requestId: requiredString(row.request_id),
    startedAt: requiredTimestamp(row.started_at),
    endedAt: requiredTimestamp(row.ended_at),
    status: terminalStatus(row.status),
    userId: requiredString(row.user_id),
    teamId: optionalString(row.team_id),
    apiKeyId: requiredString(row.api_key_id),
    requestPath: optionalString(row.request_path),
    requestModel: requiredString(row.request_model),
    packObjectKey: requiredString(row.pack_object_key),
    frameOffset: safeInteger(row.frame_offset),
    frameLength: safeInteger(row.frame_length),
    frameUncompressedLength: safeInteger(row.frame_uncompressed_length),
    frameSha256: requiredSha256(row.frame_sha256),
    recordOffset: safeInteger(row.record_offset),
    recordLength: safeInteger(row.record_length),
    recordSha256: requiredSha256(row.record_sha256),
    captureSchemaVersion: safeInteger(row.capture_schema_version),
  };
  assertCatalogRow(result);
  return result;
}

function assertCatalogRowForBundle(
  row: RequestCaptureArchiveCatalogRow,
  archiveMonth: string,
  pack: RequestCaptureArchiveObject,
): void {
  assertCatalogRow(row);
  if (row.startedAt.slice(0, 7) !== archiveMonth) throw catalogError("request_capture_archive_catalog_month_mismatch");
  if (row.packObjectKey !== pack.objectKey) throw catalogError("request_capture_archive_catalog_pack_mismatch");
  if (row.frameOffset < 8 || row.frameLength < 77 || row.frameOffset + row.frameLength > pack.bytes) {
    throw catalogError("request_capture_archive_locator_out_of_bounds");
  }
  if (row.recordOffset + row.recordLength > row.frameUncompressedLength) {
    throw catalogError("request_capture_archive_locator_out_of_bounds");
  }
}

function assertCatalogRow(row: RequestCaptureArchiveCatalogRow): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/.test(row.requestId)) throw catalogError("request_capture_archive_catalog_row_invalid");
  requiredTimestamp(row.startedAt);
  requiredTimestamp(row.endedAt);
  if (row.endedAt < row.startedAt || !["completed", "failed"].includes(row.status)) throw catalogError("request_capture_archive_catalog_row_invalid");
  for (const value of [row.userId, row.apiKeyId, row.requestModel, row.packObjectKey]) requiredString(value);
  if (row.teamId !== null) requiredString(row.teamId);
  if (row.requestPath !== null && (!row.requestPath.startsWith("/") || /[?#]/.test(row.requestPath))) {
    throw catalogError("request_capture_archive_catalog_path_invalid");
  }
  for (const value of [row.frameOffset, row.frameLength, row.frameUncompressedLength, row.recordOffset, row.recordLength, row.captureSchemaVersion]) {
    if (!Number.isSafeInteger(value) || value < 0) throw catalogError("request_capture_archive_catalog_row_invalid");
  }
  if (row.frameLength < 1 || row.frameUncompressedLength < 1 || row.recordLength < 1 || row.captureSchemaVersion < 1) {
    throw catalogError("request_capture_archive_catalog_row_invalid");
  }
  requiredSha256(row.frameSha256);
  requiredSha256(row.recordSha256);
}

function assertQuery(filter: RequestCaptureArchiveCatalogFilter, scope: RequestCaptureArchiveQueryScope): void {
  if (Object.keys(filter).some((key) => !QUERY_FILTER_KEYS.has(key))) throw catalogError("request_capture_archive_query_field_invalid");
  if (Object.values(filter).every((value) => value === undefined)) throw catalogError("request_capture_archive_query_empty");
  if (filter.requestId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/.test(filter.requestId)) {
    throw catalogError("request_capture_archive_query_value_invalid");
  }
  for (const value of [filter.userId, filter.apiKeyId, filter.requestModel]) {
    if (value !== undefined) requiredString(value);
  }
  if (filter.teamId !== undefined && filter.teamId !== null) requiredString(filter.teamId);
  if (filter.requestPath !== undefined && (!filter.requestPath.startsWith("/") || /[?#]/.test(filter.requestPath))) {
    throw catalogError("request_capture_archive_query_value_invalid");
  }
  if (filter.status !== undefined && filter.status !== "completed" && filter.status !== "failed") {
    throw catalogError("request_capture_archive_query_value_invalid");
  }
  for (const value of [filter.startedAtGte, filter.startedAtLt, filter.endedAtGte, filter.endedAtLt]) {
    if (value !== undefined) requiredTimestamp(value);
  }
  if (scope.kind === "request" && filter.requestId !== scope.requestId) throw catalogError("request_capture_archive_scope_unauthorized");
  if (scope.kind === "user" && filter.userId !== undefined && filter.userId !== scope.userId) {
    throw catalogError("request_capture_archive_scope_unauthorized");
  }
  if (filter.startedAtGte && filter.startedAtLt && filter.startedAtGte >= filter.startedAtLt) throw catalogError("request_capture_archive_query_range_invalid");
  if (filter.endedAtGte && filter.endedAtLt && filter.endedAtGte >= filter.endedAtLt) throw catalogError("request_capture_archive_query_range_invalid");
}

function scopeAllows(scope: RequestCaptureArchiveQueryScope, row: RequestCaptureArchiveCatalogRow): boolean {
  if (scope.kind === "platform_owner") return true;
  if (scope.kind === "request") return row.requestId === scope.requestId;
  return row.userId === scope.userId;
}

function matchesFilter(row: RequestCaptureArchiveCatalogRow, filter: RequestCaptureArchiveCatalogFilter): boolean {
  if (filter.requestId !== undefined && row.requestId !== filter.requestId) return false;
  if (filter.status !== undefined && row.status !== filter.status) return false;
  if (filter.userId !== undefined && row.userId !== filter.userId) return false;
  if (filter.teamId !== undefined && row.teamId !== filter.teamId) return false;
  if (filter.apiKeyId !== undefined && row.apiKeyId !== filter.apiKeyId) return false;
  if (filter.requestPath !== undefined && row.requestPath !== filter.requestPath) return false;
  if (filter.requestModel !== undefined && row.requestModel !== filter.requestModel) return false;
  if (filter.startedAtGte !== undefined && row.startedAt < filter.startedAtGte) return false;
  if (filter.startedAtLt !== undefined && row.startedAt >= filter.startedAtLt) return false;
  if (filter.endedAtGte !== undefined && row.endedAt < filter.endedAtGte) return false;
  if (filter.endedAtLt !== undefined && row.endedAt >= filter.endedAtLt) return false;
  return true;
}

function registerZstd(): void {
  PARQUET_COMPRESSION_METHODS.ZSTD ??= {
    deflate: (value: Uint8Array) => zstdCompressSync(value, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: 6 },
    }),
    inflate: (value: Uint8Array) => zstdDecompressSync(value),
  };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw catalogError("request_capture_archive_catalog_row_invalid");
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value);
}

function requiredTimestamp(value: unknown): string {
  const result = requiredString(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || Number.isNaN(Date.parse(result))
    || new Date(result).toISOString() !== result) {
    throw catalogError("request_capture_archive_catalog_row_invalid");
  }
  return result;
}

function terminalStatus(value: unknown): "completed" | "failed" {
  if (value !== "completed" && value !== "failed") throw catalogError("request_capture_archive_catalog_row_invalid");
  return value;
}

function safeInteger(value: unknown): number {
  const numeric = typeof value === "bigint" ? Number(value) : typeof value === "object" && value !== null && "toNumber" in value
    ? Number((value as { toNumber(): number }).toNumber())
    : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw catalogError("request_capture_archive_catalog_row_invalid");
  return numeric;
}

function requiredSha256(value: unknown): string {
  const result = requiredString(value);
  if (!/^[a-f0-9]{64}$/.test(result)) throw catalogError("request_capture_archive_catalog_row_invalid");
  return result;
}

function hasCatalogCode(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && typeof error.code === "string" && error.code.startsWith("request_capture_archive_"));
}

function catalogError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
