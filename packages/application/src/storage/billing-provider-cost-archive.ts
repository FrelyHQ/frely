import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { ParquetReader, ParquetSchema, ParquetWriter, type FieldDefinition, type ParquetCompression } from "@dsnp/parquetjs";
import { PARQUET_COMPRESSION_METHODS } from "@dsnp/parquetjs/dist/lib/compression.js";
import type { BillingProviderCostEvent } from "./application-operation-port.js";

export const BILLING_PROVIDER_COST_ARCHIVE_FORMAT_VERSION = 2;
export const BILLING_PROVIDER_COST_ARCHIVE_SCHEMA_VERSION = 2;
export const BILLING_PROVIDER_COST_ARCHIVE_COLUMNS = [
  "id", "request_id", "provider_attempt_id", "operation_kind", "provider_owner_scope_ref", "provider_id", "provider_model_name",
  "provider_model_cost_id", "cost_tier_key", "cost_snapshot_json", "input_tokens", "cached_input_tokens",
  "cache_write_tokens", "output_tokens", "amount", "created_at"
] as const;
const BILLING_PROVIDER_COST_ARCHIVE_COLUMNS_V1 = BILLING_PROVIDER_COST_ARCHIVE_COLUMNS.filter((column) => column !== "provider_attempt_id");

export interface BillingProviderCostArchiveManifestV1 {
  manifestVersion: 1;
  archiveFormatVersion: 1 | 2;
  schemaVersion: 1 | 2;
  kind: "billing-provider-cost-events";
  cutoffGte: string;
  cutoffLt: string;
  recordCount: number;
  objectKey: string;
  compressedBytes: number;
  uncompressedBytes: number;
  sha256: string;
  createdAt: string;
}

export async function writeBillingProviderCostEventsParquet(path: string, rows: Iterable<BillingProviderCostEvent>): Promise<number> {
  registerZstd();
  const writer = await ParquetWriter.openFile(providerCostParquetSchema(), path, { rowGroupSize: 4096, pageSize: 8192, useDataPageV2: true });
  writer.setMetadata("friday-relay.archive-format-version", String(BILLING_PROVIDER_COST_ARCHIVE_FORMAT_VERSION));
  writer.setMetadata("friday-relay.schema-version", String(BILLING_PROVIDER_COST_ARCHIVE_SCHEMA_VERSION));
  let count = 0;
  let previous: BillingProviderCostEvent | undefined;
  const ids = new Set<string>();
  try {
    for (const row of rows) {
      if (ids.has(row.id)) throw archiveError("billing_provider_cost_archive_duplicate_id");
      assertRow(row, previous);
      await writer.appendRow(toParquetRow(row));
      ids.add(row.id);
      previous = row;
      count += 1;
    }
    await writer.close();
    return count;
  } catch (error) {
    try { await writer.close(); } catch { /* preserve original failure */ }
    throw error;
  }
}

export async function readBillingProviderCostEventsParquet(file: string | Buffer): Promise<BillingProviderCostEvent[]> {
  registerZstd();
  let reader: ParquetReader | undefined;
  try {
    reader = typeof file === "string" ? await ParquetReader.openFile(file) : await ParquetReader.openBuffer(file);
    assertColumns(reader);
    const cursor = reader.getCursor();
    const rows: BillingProviderCostEvent[] = [];
    while (true) {
      const value = await cursor.next();
      if (value === null) break;
      rows.push(fromParquetRow(value as Record<string, unknown>));
    }
    assertRows(rows);
    return rows;
  } catch (error) {
    if (isArchiveError(error)) throw error;
    throw archiveError("billing_provider_cost_archive_parquet_invalid");
  } finally { await reader?.close(); }
}

export async function scanAndVerifyBillingProviderCostEventsParquet(path: string, manifest: BillingProviderCostArchiveManifestV1, onRow: (row: BillingProviderCostEvent) => void): Promise<number> {
  const [fileStat, digest] = await Promise.all([stat(path), billingProviderCostSha256File(path)]);
  if (fileStat.size !== manifest.compressedBytes || digest !== manifest.sha256) throw archiveError("billing_provider_cost_archive_object_mismatch");
  registerZstd();
  let reader: ParquetReader | undefined;
  try {
    reader = await ParquetReader.openFile(path);
    if (metadataUncompressedBytes(reader) !== manifest.uncompressedBytes) throw archiveError("billing_provider_cost_archive_uncompressed_size_mismatch");
    assertColumns(reader);
    const cursor = reader.getCursor();
    let count = 0;
    let previous: BillingProviderCostEvent | undefined;
    const ids = new Set<string>();
    while (true) {
      const value = await cursor.next();
      if (value === null) break;
      const row = fromParquetRow(value as Record<string, unknown>);
      if (ids.has(row.id)) throw archiveError("billing_provider_cost_archive_duplicate_id");
      assertRow(row, previous);
      if (row.createdAt < manifest.cutoffGte || row.createdAt >= manifest.cutoffLt) throw archiveError("billing_provider_cost_archive_cutoff_mismatch");
      onRow(row);
      ids.add(row.id);
      previous = row;
      count += 1;
    }
    if (count !== manifest.recordCount) throw archiveError("billing_provider_cost_archive_row_count_mismatch");
    return count;
  } finally { await reader?.close(); }
}

export function parseBillingProviderCostArchiveManifestV1(value: string | unknown): BillingProviderCostArchiveManifestV1 {
  let raw: Record<string, unknown>;
  try { raw = (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>; }
  catch { throw archiveError("billing_provider_cost_archive_manifest_invalid"); }
  const allowed = new Set(["manifestVersion", "archiveFormatVersion", "schemaVersion", "kind", "cutoffGte", "cutoffLt", "recordCount", "objectKey", "compressedBytes", "uncompressedBytes", "sha256", "createdAt"]);
  const formatVersion = raw.archiveFormatVersion;
  const schemaVersion = raw.schemaVersion;
  if (!raw || Object.keys(raw).some((key) => !allowed.has(key)) || raw.manifestVersion !== 1 || !((formatVersion === 1 && schemaVersion === 1) || (formatVersion === 2 && schemaVersion === 2)) || raw.kind !== "billing-provider-cost-events") throw archiveError("billing_provider_cost_archive_manifest_invalid");
  const result: BillingProviderCostArchiveManifestV1 = {
    manifestVersion: 1, archiveFormatVersion: formatVersion as 1 | 2, schemaVersion: schemaVersion as 1 | 2, kind: "billing-provider-cost-events",
    cutoffGte: stringValue(raw.cutoffGte), cutoffLt: stringValue(raw.cutoffLt), recordCount: integerValue(raw.recordCount),
    objectKey: stringValue(raw.objectKey), compressedBytes: integerValue(raw.compressedBytes), uncompressedBytes: integerValue(raw.uncompressedBytes),
    sha256: stringValue(raw.sha256), createdAt: stringValue(raw.createdAt)
  };
  if (!/^[a-f0-9]{64}$/.test(result.sha256) || !/^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(result.cutoffGte) || !/^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(result.cutoffLt) || Number.isNaN(Date.parse(result.createdAt))) throw archiveError("billing_provider_cost_archive_manifest_invalid");
  return result;
}

export async function billingProviderCostParquetUncompressedBytes(path: string): Promise<number> {
  registerZstd();
  const reader = await ParquetReader.openFile(path);
  try { return metadataUncompressedBytes(reader); } finally { await reader.close(); }
}

export async function billingProviderCostSha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function billingProviderCostSha256Hex(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

function providerCostParquetSchema(): ParquetSchema {
  const text = (): FieldDefinition => ({ type: "UTF8", compression: "ZSTD" as ParquetCompression });
  const optionalText = (): FieldDefinition => ({ ...text(), optional: true });
  const integer = (): FieldDefinition => ({ type: "INT64", compression: "ZSTD" as ParquetCompression });
  const amount = (): FieldDefinition => ({ type: "DOUBLE", compression: "ZSTD" as ParquetCompression });
  return new ParquetSchema({
    id: text(), request_id: text(), provider_attempt_id: optionalText(), operation_kind: text(), provider_owner_scope_ref: text(), provider_id: text(), provider_model_name: text(),
    provider_model_cost_id: text(), cost_tier_key: text(), cost_snapshot_json: text(), input_tokens: integer(), cached_input_tokens: integer(),
    cache_write_tokens: integer(), output_tokens: integer(), amount: amount(), created_at: text()
  });
}

function registerZstd(): void {
  PARQUET_COMPRESSION_METHODS.ZSTD ??= { deflate: (value: Uint8Array) => zstdCompressSync(value), inflate: (value: Uint8Array) => zstdDecompressSync(value) };
}

function toParquetRow(row: BillingProviderCostEvent): Record<string, unknown> {
  return {
    id: row.id, request_id: row.requestId, provider_attempt_id: row.providerAttemptId, operation_kind: row.operationKind, provider_owner_scope_ref: row.providerOwnerScopeRef,
    provider_id: row.providerId, provider_model_name: row.providerModelName, provider_model_cost_id: row.providerModelCostId,
    cost_tier_key: row.costTierKey, cost_snapshot_json: row.costSnapshotJson, input_tokens: row.inputTokens,
    cached_input_tokens: row.cachedInputTokens, cache_write_tokens: row.cacheWriteTokens, output_tokens: row.outputTokens,
    amount: row.amount, created_at: row.createdAt
  };
}

function fromParquetRow(row: Record<string, unknown>): BillingProviderCostEvent {
  return {
    id: stringValue(row.id), requestId: stringValue(row.request_id), providerAttemptId: nullableString(row.provider_attempt_id), operationKind: stringValue(row.operation_kind),
    providerOwnerScopeRef: stringValue(row.provider_owner_scope_ref), providerId: stringValue(row.provider_id),
    providerModelName: stringValue(row.provider_model_name), providerModelCostId: stringValue(row.provider_model_cost_id),
    costTierKey: stringValue(row.cost_tier_key), costSnapshotJson: jsonValue(row.cost_snapshot_json),
    inputTokens: integerValue(row.input_tokens), cachedInputTokens: integerValue(row.cached_input_tokens),
    cacheWriteTokens: integerValue(row.cache_write_tokens), outputTokens: integerValue(row.output_tokens),
    amount: numberValue(row.amount), createdAt: stringValue(row.created_at)
  };
}

function assertColumns(reader: ParquetReader): void {
  const fields = reader.getSchema().fieldList.filter((field) => !field.isNested).map((field) => field.name);
  const matches = (columns: readonly string[]) => fields.length === columns.length && fields.every((name, index) => name === columns[index]);
  if (!matches(BILLING_PROVIDER_COST_ARCHIVE_COLUMNS) && !matches(BILLING_PROVIDER_COST_ARCHIVE_COLUMNS_V1)) throw archiveError("billing_provider_cost_archive_schema_mismatch");
}
function assertRows(rows: BillingProviderCostEvent[]): void { let previous: BillingProviderCostEvent | undefined; const ids = new Set<string>(); for (const row of rows) { if (ids.has(row.id)) throw archiveError("billing_provider_cost_archive_duplicate_id"); assertRow(row, previous); ids.add(row.id); previous = row; } }
function assertRow(row: BillingProviderCostEvent, previous?: BillingProviderCostEvent): void {
  if (!row.id || !row.requestId || !row.providerId || !row.providerModelCostId || !Number.isFinite(row.amount) || row.amount < 0) throw archiveError("billing_provider_cost_archive_value_invalid");
  for (const count of [row.inputTokens, row.cachedInputTokens, row.cacheWriteTokens, row.outputTokens]) if (!Number.isSafeInteger(count) || count < 0) throw archiveError("billing_provider_cost_archive_value_invalid");
  jsonValue(row.costSnapshotJson);
  if (Number.isNaN(Date.parse(row.createdAt))) throw archiveError("billing_provider_cost_archive_value_invalid");
  if (previous && (row.createdAt < previous.createdAt || (row.createdAt === previous.createdAt && row.id <= previous.id))) throw archiveError("billing_provider_cost_archive_order_invalid");
}
function metadataUncompressedBytes(reader: ParquetReader): number { return reader.metadata?.row_groups.reduce((total, group) => total + group.columns.reduce((sum, column) => sum + Number(column.meta_data?.total_uncompressed_size?.valueOf() ?? 0), 0), 0) ?? 0; }
function stringValue(value: unknown): string { if (typeof value !== "string") throw archiveError("billing_provider_cost_archive_value_invalid"); return value; }
function nullableString(value: unknown): string | null { return value === undefined || value === null ? null : stringValue(value); }
function jsonValue(value: unknown): string { const text = stringValue(value); try { JSON.parse(text); } catch { throw archiveError("billing_provider_cost_archive_value_invalid"); } return text; }
function integerValue(value: unknown): number { const number = typeof value === "bigint" ? Number(value) : value; if (!Number.isSafeInteger(number) || (number as number) < 0) throw archiveError("billing_provider_cost_archive_value_invalid"); return number as number; }
function numberValue(value: unknown): number { const number = typeof value === "bigint" ? Number(value) : Number(value); if (!Number.isFinite(number)) throw archiveError("billing_provider_cost_archive_value_invalid"); return number; }
function isArchiveError(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.startsWith("billing_provider_cost_archive_")); }
function archiveError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
