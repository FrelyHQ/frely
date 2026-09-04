import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { ParquetReader, ParquetSchema, ParquetWriter, type FieldDefinition, type ParquetCompression } from "@dsnp/parquetjs";
import { PARQUET_COMPRESSION_METHODS } from "@dsnp/parquetjs/dist/lib/compression.js";
import type { RequestLog } from "./contracts.js";

export type ArchivedRequestLog = RequestLog & { providerAttemptsJson: string };

export const REQUEST_LOG_ARCHIVE_FORMAT_VERSION = 2;
export const REQUEST_LOG_ARCHIVE_SCHEMA_VERSION = 5;
export const REQUEST_LOG_ARCHIVE_COLUMNS = [
  "id", "api_key_id", "user_id", "team_id", "plan_id", "plan_subscription_id", "entry_access_point_id",
  "billing_scope_ref", "provider_id", "request_path", "ingress_hostname", "ingress_route_id", "req_model", "tar_model", "ingress_plugins_json", "pipeline_plugins_json", "provider_attempts_json", "status", "error_code", "credential_failure_reason", "started_at", "ended_at"
] as const;
const REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA4 = REQUEST_LOG_ARCHIVE_COLUMNS.filter((column) => column !== "credential_failure_reason");
const REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA3 = REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA4.filter((column) => column !== "ingress_route_id");
const REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA2 = REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA3.filter((column) => column !== "ingress_hostname");
const REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT1_SCHEMA2 = REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA3.filter((column) => column !== "provider_attempts_json");
const REQUEST_LOG_ARCHIVE_COLUMNS_V1 = REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA2.filter((column) => column !== "provider_attempts_json");
const PRE_PIPELINE_REQUEST_LOG_ARCHIVE_COLUMNS = REQUEST_LOG_ARCHIVE_COLUMNS_V1.filter((column) => column !== "pipeline_plugins_json");
const DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS = [...REQUEST_LOG_ARCHIVE_COLUMNS.slice(0, -2), "error_details_json", ...REQUEST_LOG_ARCHIVE_COLUMNS.slice(-2)];
const DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA4 = [...REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA4.slice(0, -2), "error_details_json", ...REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA4.slice(-2)];
const DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA3 = [...REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA3.slice(0, -2), "error_details_json", ...REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA3.slice(-2)];
const DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA2 = [...REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA2.slice(0, -2), "error_details_json", ...REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA2.slice(-2)];
const DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT1_SCHEMA2 = [...REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT1_SCHEMA2.slice(0, -2), "error_details_json", ...REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT1_SCHEMA2.slice(-2)];
const DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_V1 = [...REQUEST_LOG_ARCHIVE_COLUMNS_V1.slice(0, -2), "error_details_json", ...REQUEST_LOG_ARCHIVE_COLUMNS_V1.slice(-2)];
const PRE_PIPELINE_DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS = DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_V1.filter((column) => column !== "pipeline_plugins_json");
const LEGACY_REQUEST_LOG_ARCHIVE_COLUMNS = PRE_PIPELINE_REQUEST_LOG_ARCHIVE_COLUMNS.filter((column) => column !== "ingress_plugins_json");

export interface RequestLogArchiveManifestV1 {
  manifestVersion: 1;
  archiveFormatVersion: 1 | 2;
  schemaVersion: 1 | 2 | 3 | 4 | 5;
  kind: "request-logs";
  cutoffGte: string;
  cutoffLt: string;
  recordCount: number;
  objectKey: string;
  compressedBytes: number;
  uncompressedBytes: number;
  sha256: string;
  createdAt: string;
}

export async function writeRequestLogsParquet(
  path: string,
  rows: Iterable<RequestLog>,
  formatVersion: 1 | 2 = REQUEST_LOG_ARCHIVE_FORMAT_VERSION,
  schemaVersion: 1 | 2 | 3 | 4 | 5 = formatVersion === 2 ? REQUEST_LOG_ARCHIVE_SCHEMA_VERSION : formatVersion,
): Promise<number> {
  registerZstd();
  const includeProviderAttempts = formatVersion >= 2;
  const includeIngressHostname = schemaVersion >= 3 || (formatVersion === 1 && schemaVersion === 2);
  const includeIngressRouteId = formatVersion === 2 && schemaVersion >= 4;
  const includeCredentialFailureReason = formatVersion === 2 && schemaVersion >= 5;
  const writer = await ParquetWriter.openFile(requestLogParquetSchema(includeProviderAttempts, includeIngressHostname, includeIngressRouteId, includeCredentialFailureReason), path, { rowGroupSize: 4096, pageSize: 8192, useDataPageV2: true });
  writer.setMetadata("friday-relay.archive-format-version", String(formatVersion));
  writer.setMetadata("friday-relay.schema-version", String(schemaVersion));
  let count = 0;
  let previous: RequestLog | undefined;
  const ids = new Set<string>();
  try {
    for (const row of rows) {
      if (ids.has(row.id)) throw archiveError("request_log_archive_duplicate_id");
      assertRequestLog(row, previous);
      const parquetRow = toParquetRow(row);
      if (!includeProviderAttempts) delete parquetRow.provider_attempts_json;
      if (!includeIngressHostname) delete parquetRow.ingress_hostname;
      if (!includeIngressRouteId) delete parquetRow.ingress_route_id;
      if (!includeCredentialFailureReason) delete parquetRow.credential_failure_reason;
      await writer.appendRow(parquetRow);
      previous = row;
      ids.add(row.id);
      count += 1;
    }
    await writer.close();
    return count;
  } catch (error) {
    try { await writer.close(); } catch { /* preserve original failure */ }
    throw error;
  }
}

export async function readRequestLogsParquet(file: string | Buffer, manifest?: RequestLogArchiveManifestV1): Promise<ArchivedRequestLog[]> {
  registerZstd();
  let reader: ParquetReader | undefined;
  try {
    reader = typeof file === "string" ? await ParquetReader.openFile(file) : await ParquetReader.openBuffer(file);
    const fields = reader.getSchema().fieldList.filter((field) => !field.isNested).map((field) => field.name);
    if (!archiveColumnsMatch(fields, manifest)) throw archiveError("request_log_archive_schema_mismatch");
    const cursor = reader.getCursor();
    const rows: ArchivedRequestLog[] = [];
    while (true) {
      const value = await cursor.next();
      if (value === null) break;
      rows.push(fromParquetRow(value as Record<string, unknown>));
    }
    assertRequestLogs(rows);
    return rows;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw archiveError("request_log_archive_parquet_invalid");
  } finally {
    await reader?.close();
  }
}

export async function scanAndVerifyRequestLogsParquet(path: string, manifest: RequestLogArchiveManifestV1, onRow: (row: RequestLog) => void): Promise<number> {
  const [fileStat, digest] = await Promise.all([stat(path), sha256File(path)]);
  if (fileStat.size !== manifest.compressedBytes || digest !== manifest.sha256) throw archiveError("request_log_archive_object_mismatch");
  registerZstd();
  let reader: ParquetReader | undefined;
  try {
    reader = await ParquetReader.openFile(path);
    if (metadataUncompressedBytes(reader) !== manifest.uncompressedBytes) throw archiveError("request_log_archive_uncompressed_size_mismatch");
    const fields = reader.getSchema().fieldList.filter((field) => !field.isNested).map((field) => field.name);
    if (!archiveColumnsMatch(fields, manifest)) throw archiveError("request_log_archive_schema_mismatch");
    const cursor = reader.getCursor();
    let count = 0;
    let previous: RequestLog | undefined;
    const ids = new Set<string>();
    while (true) {
      const value = await cursor.next();
      if (value === null) break;
      const row = fromParquetRow(value as Record<string, unknown>);
      if (ids.has(row.id)) throw archiveError("request_log_archive_duplicate_id");
      assertRequestLog(row, previous);
      if (row.startedAt < manifest.cutoffGte || row.startedAt >= manifest.cutoffLt) throw archiveError("request_log_archive_cutoff_mismatch");
      onRow(row);
      ids.add(row.id);
      previous = row;
      count += 1;
    }
    if (count !== manifest.recordCount) throw archiveError("request_log_archive_row_count_mismatch");
    return count;
  } finally {
    await reader?.close();
  }
}

export async function verifyRequestLogsParquet(file: string | Buffer, manifest: RequestLogArchiveManifestV1): Promise<RequestLog[]> {
  const bytes = typeof file === "string" ? await import("node:fs/promises").then((module) => module.readFile(file)) : file;
  if (bytes.byteLength !== manifest.compressedBytes || sha256Hex(bytes) !== manifest.sha256) throw archiveError("request_log_archive_object_mismatch");
  const rows = await readRequestLogsParquet(file, manifest);
  if (rows.length !== manifest.recordCount) throw archiveError("request_log_archive_row_count_mismatch");
  if (rows.some((row) => row.startedAt < manifest.cutoffGte || row.startedAt >= manifest.cutoffLt)) throw archiveError("request_log_archive_cutoff_mismatch");
  return rows;
}

export function parseRequestLogArchiveManifestV1(value: string | unknown): RequestLogArchiveManifestV1 {
  let raw: Record<string, unknown>;
  try { raw = (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>; }
  catch { throw archiveError("request_log_archive_manifest_invalid"); }
  const formatVersion = raw.archiveFormatVersion;
  const schemaVersion = raw.schemaVersion;
  if (!raw || raw.manifestVersion !== 1 || !(
    (formatVersion === 1 && (schemaVersion === 1 || schemaVersion === 2))
    || (formatVersion === 2 && (schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5))
  ) || raw.kind !== "request-logs") throw archiveError("request_log_archive_manifest_invalid");
  const result: RequestLogArchiveManifestV1 = {
    manifestVersion: 1, archiveFormatVersion: formatVersion as 1 | 2, schemaVersion: schemaVersion as 1 | 2 | 3 | 4 | 5, kind: "request-logs",
    cutoffGte: stringValue(raw.cutoffGte), cutoffLt: stringValue(raw.cutoffLt), recordCount: integerValue(raw.recordCount),
    objectKey: stringValue(raw.objectKey), compressedBytes: integerValue(raw.compressedBytes), sha256: stringValue(raw.sha256), createdAt: stringValue(raw.createdAt)
    , uncompressedBytes: integerValue(raw.uncompressedBytes)
  };
  const allowedKeys = new Set(["manifestVersion", "archiveFormatVersion", "schemaVersion", "kind", "cutoffGte", "cutoffLt", "recordCount", "objectKey", "compressedBytes", "uncompressedBytes", "sha256", "createdAt"]);
  if (
    Object.keys(raw).some((key) => !allowedKeys.has(key))
    || !/^[a-f0-9]{64}$/.test(result.sha256)
    || !/^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(result.cutoffGte)
    || !/^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(result.cutoffLt)
    || Number.isNaN(Date.parse(result.createdAt))
  ) throw archiveError("request_log_archive_manifest_invalid");
  return result;
}

export function sha256Hex(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function requestLogParquetUncompressedBytes(path: string): Promise<number> {
  registerZstd();
  const reader = await ParquetReader.openFile(path);
  try { return metadataUncompressedBytes(reader); } finally { await reader.close(); }
}

function metadataUncompressedBytes(reader: ParquetReader): number {
  return reader.metadata?.row_groups.reduce((total, group) => total + group.columns.reduce((sum, column) => sum + Number(column.meta_data?.total_uncompressed_size?.valueOf() ?? 0), 0), 0) ?? 0;
}

function requestLogParquetSchema(includeProviderAttempts: boolean, includeIngressHostname: boolean, includeIngressRouteId: boolean, includeCredentialFailureReason: boolean): ParquetSchema {
  const required = (): FieldDefinition => ({ type: "UTF8", compression: "ZSTD" as ParquetCompression });
  const optional = (): FieldDefinition => ({ ...required(), optional: true });
  const fields: Record<string, FieldDefinition> = {
    id: required(), api_key_id: required(), user_id: required(), team_id: optional(), plan_id: optional(), plan_subscription_id: optional(),
    entry_access_point_id: optional(), billing_scope_ref: optional(), provider_id: optional(), request_path: optional(),
    ...(includeIngressHostname ? { ingress_hostname: optional() } : {}),
    ...(includeIngressRouteId ? { ingress_route_id: optional() } : {}),
    req_model: required(),
    tar_model: optional(), ingress_plugins_json: required(), pipeline_plugins_json: required(),
    ...(includeProviderAttempts ? { provider_attempts_json: required() } : {}),
    status: required(), error_code: optional(), ...(includeCredentialFailureReason ? { credential_failure_reason: optional() } : {}), started_at: required(), ended_at: required()
  };
  return new ParquetSchema(fields);
}

function registerZstd(): void {
  PARQUET_COMPRESSION_METHODS.ZSTD ??= {
    deflate: (value: Uint8Array) => zstdCompressSync(value),
    inflate: (value: Uint8Array) => zstdDecompressSync(value)
  };
}

function toParquetRow(row: RequestLog & { providerAttemptsJson?: string }): Record<string, unknown> {
  return {
    id: row.id, api_key_id: row.apiKeyId, user_id: row.userId, team_id: row.teamId, plan_id: row.planId,
    plan_subscription_id: row.planSubscriptionId, entry_access_point_id: row.entryAccessPointId, billing_scope_ref: row.billingScopeRef,
    provider_id: row.providerId, request_path: row.requestPath, ingress_hostname: row.ingressHostname, ingress_route_id: row.ingressRouteId, req_model: row.reqModel, tar_model: row.tarModel, ingress_plugins_json: row.ingressPluginsJson ?? "[]", pipeline_plugins_json: pipelineSnapshotJson(row.pipelinePluginsJson, row.ingressPluginsJson), provider_attempts_json: providerAttemptsJson(row.providerAttemptsJson), status: row.status,
    error_code: row.errorCode, credential_failure_reason: row.credentialFailureReason, started_at: row.startedAt, ended_at: row.endedAt
  };
}

function fromParquetRow(row: Record<string, unknown>): ArchivedRequestLog {
  const archivedProviderAttemptsJson = providerAttemptsJson(row.provider_attempts_json);
  return {
    id: stringValue(row.id), apiKeyId: stringValue(row.api_key_id), userId: stringValue(row.user_id), teamId: nullableString(row.team_id),
    planId: nullableString(row.plan_id), planSubscriptionId: nullableString(row.plan_subscription_id), entryAccessPointId: nullableString(row.entry_access_point_id),
    billingScopeRef: nullableString(row.billing_scope_ref), providerId: nullableString(row.provider_id), requestPath: nullableString(row.request_path), ingressHostname: nullableString(row.ingress_hostname), ingressRouteId: nullableString(row.ingress_route_id),
    reqModel: stringValue(row.req_model), tarModel: nullableString(row.tar_model), ingressPluginsJson: row.ingress_plugins_json === undefined ? "[]" : stringValue(row.ingress_plugins_json), pipelinePluginsJson: pipelineSnapshotJson(row.pipeline_plugins_json, row.ingress_plugins_json), status: stringValue(row.status), errorCode: nullableString(row.error_code), credentialFailureReason: credentialFailureReason(row.credential_failure_reason),
    startedAt: stringValue(row.started_at), endedAt: nullableString(row.ended_at), providerAttemptsJson: archivedProviderAttemptsJson
  };
}

function assertRequestLogs(rows: RequestLog[]): void { let previous: RequestLog | undefined; const ids = new Set<string>(); for (const row of rows) { if (ids.has(row.id)) throw archiveError("request_log_archive_duplicate_id"); assertRequestLog(row, previous); ids.add(row.id); previous = row; } }
function assertRequestLog(row: RequestLog, previous?: RequestLog): void {
  if (!row.endedAt || row.status === "started") throw archiveError("request_log_archive_nonterminal_row");
  if (row.credentialFailureReason !== null && row.status !== "failed") throw archiveError("request_log_archive_value_invalid");
  if ((JSON.parse(pipelineSnapshotJson(row.pipelinePluginsJson, row.ingressPluginsJson)) as { planRevision?: unknown }).planRevision === "pending") throw archiveError("request_log_archive_pipeline_snapshot_pending");
  if (previous && (row.startedAt < previous.startedAt || (row.startedAt === previous.startedAt && row.id <= previous.id))) throw archiveError("request_log_archive_order_invalid");
}
function stringValue(value: unknown): string { if (typeof value !== "string") throw archiveError("request_log_archive_value_invalid"); return value; }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : stringValue(value); }
function credentialFailureReason(value: unknown): RequestLog["credentialFailureReason"] {
  const reason = nullableString(value);
  if (reason === null || reason === "auth_unauthorized" || reason === "auth_unavailable" || reason === "auth_not_found" || reason === "model_cooldown") return reason;
  throw archiveError("request_log_archive_value_invalid");
}
function archiveColumnsMatch(fields: string[], manifest?: RequestLogArchiveManifestV1): boolean {
  const baseColumns = manifest
    ? manifest.archiveFormatVersion === 2 && manifest.schemaVersion === 5
      ? [REQUEST_LOG_ARCHIVE_COLUMNS, DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS]
      : manifest.archiveFormatVersion === 2 && manifest.schemaVersion === 4
        ? [REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA4, DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA4]
        : manifest.archiveFormatVersion === 2 && manifest.schemaVersion === 3
        ? [REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA3, DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA3]
        : manifest.archiveFormatVersion === 2
          ? [REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA2, DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA2]
          : manifest.schemaVersion === 2
            ? [REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT1_SCHEMA2, DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT1_SCHEMA2]
            : [REQUEST_LOG_ARCHIVE_COLUMNS_V1, DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_V1, PRE_PIPELINE_REQUEST_LOG_ARCHIVE_COLUMNS, PRE_PIPELINE_DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS, LEGACY_REQUEST_LOG_ARCHIVE_COLUMNS]
    : [
      REQUEST_LOG_ARCHIVE_COLUMNS,
      REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA4,
      REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA3,
      REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA2,
      REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT1_SCHEMA2,
      REQUEST_LOG_ARCHIVE_COLUMNS_V1,
      DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS,
      DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA4,
      DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA3,
      DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT2_SCHEMA2,
      DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_FORMAT1_SCHEMA2,
      DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS_V1,
      PRE_PIPELINE_REQUEST_LOG_ARCHIVE_COLUMNS,
      PRE_PIPELINE_DIAGNOSTIC_REQUEST_LOG_ARCHIVE_COLUMNS,
      LEGACY_REQUEST_LOG_ARCHIVE_COLUMNS,
    ];
  return baseColumns.some((columns) => fields.length === columns.length && fields.every((name, index) => name === columns[index]));
}
function providerAttemptsJson(value: unknown): string {
  const text = value === undefined ? "[]" : stringValue(value);
  try {
    if (!Array.isArray(JSON.parse(text))) throw new Error();
  } catch {
    throw archiveError("request_log_archive_value_invalid");
  }
  return text;
}
const pipelineSnapshotHooks = new Set(["request.ingress", "request.decode", "request.normalize", "request.estimate", "policy.pre-resolution", "access.candidates", "access.select", "policy.post-resolution", "pricing.quote", "provider.request", "provider.invoke", "response.decode", "response.transform", "stream.transform", "usage.measure", "billing.calculate", "response.egress", "observability"]);
const pipelineSnapshotOutcomes = new Set(["applied", "noop", "denied", "failed", "fallback"]);
function pipelineSnapshotJson(value: unknown, legacyIngressValue: unknown): string {
  if (value !== undefined && value !== null) {
    const json = stringValue(value);
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const revisions = (candidate: unknown): candidate is string => typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate);
      const seen = new Set<string>();
      if (!parsed || Object.keys(parsed).some((key) => !["schemaVersion", "planRevision", "invocations"].includes(key)) || parsed.schemaVersion !== 1 || !revisions(parsed.planRevision) || !Array.isArray(parsed.invocations) || parsed.invocations.length > 128 || Buffer.byteLength(json, "utf8") > 32768 || parsed.invocations.some((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return true;
        const invocation = item as Record<string, unknown>;
        if (Object.keys(invocation).some((key) => !["pluginId", "behaviorVersion", "hook", "instanceRevision", "outcome"].includes(key))
          || typeof invocation.pluginId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(invocation.pluginId) || invocation.pluginId.length > 96
          || !Number.isSafeInteger(invocation.behaviorVersion) || (invocation.behaviorVersion as number) < 1
          || typeof invocation.hook !== "string" || !pipelineSnapshotHooks.has(invocation.hook)
          || !revisions(invocation.instanceRevision) || !pipelineSnapshotOutcomes.has(String(invocation.outcome))) return true;
        const key = `${invocation.pluginId}\u0000${invocation.hook}`;
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      })) throw new Error();
      return json;
    } catch { throw archiveError("request_log_archive_value_invalid"); }
  }
  let ingress: unknown = [];
  try { ingress = legacyIngressValue === undefined ? [] : JSON.parse(stringValue(legacyIngressValue)); } catch { throw archiveError("request_log_archive_value_invalid"); }
  const invocations = Array.isArray(ingress) ? ingress.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id) || row.id.length > 96 || !Number.isSafeInteger(row.version) || (row.version as number) < 1 || !(row.success === true || row.success === false || row.success === null)) return [];
    return [{ pluginId: row.id, behaviorVersion: row.version, hook: "request.ingress", instanceRevision: "legacy", outcome: row.success === true ? "applied" : row.success === false ? "failed" : "noop" }];
  }).slice(0, 128) : [];
  return JSON.stringify({ schemaVersion: 1, planRevision: "legacy", invocations });
}
function integerValue(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw archiveError("request_log_archive_value_invalid"); return value as number; }
function archiveError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
