import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { ParquetReader, ParquetSchema, ParquetWriter, type FieldDefinition, type ParquetCompression } from "@dsnp/parquetjs";
import { PARQUET_COMPRESSION_METHODS } from "@dsnp/parquetjs/dist/lib/compression.js";

export const HISTORY_FACT_ARCHIVE_SCHEMA_VERSION = 1;

export interface HistoryFactRecord {
  id: string;
  requestId: string | null;
  occurredAt: string;
  payloadJson: string;
}

export interface HistoryFactArchiveManifestV1 {
  manifestVersion: 1;
  schemaVersion: 1;
  kind: "history-facts";
  domain: string;
  cutoffGte: string;
  cutoffLt: string;
  recordCount: number;
  objectKey: string;
  compressedBytes: number;
  uncompressedBytes: number;
  sha256: string;
  sourceSnapshotSha256: string;
  createdAt: string;
}

export async function writeHistoryFactsParquet(path: string, rows: Iterable<HistoryFactRecord>): Promise<{ count: number; sourceSnapshotSha256: string }> {
  return writeHistoryFactsParquetFromAsync(path, (async function* () { yield* rows; })());
}

/** Stream history facts into the same deterministic Parquet format without
 * materialising a complete month in memory. */
export async function writeHistoryFactsParquetFromAsync(path: string, rows: AsyncIterable<HistoryFactRecord>): Promise<{ count: number; sourceSnapshotSha256: string }> {
  registerZstd();
  const writer = await ParquetWriter.openFile(historyFactParquetSchema(), path, { rowGroupSize: 4096, pageSize: 8192, useDataPageV2: true });
  writer.setMetadata("friday-relay.schema-version", String(HISTORY_FACT_ARCHIVE_SCHEMA_VERSION));
  const digest = createHash("sha256");
  let count = 0;
  let previous: HistoryFactRecord | undefined;
  const ids = new Set<string>();
  try {
    for await (const row of rows) {
      assertRecord(row, previous);
      if (ids.has(row.id)) throw archiveError("history_fact_archive_duplicate_id");
      await writer.appendRow({ id: row.id, request_id: row.requestId, occurred_at: row.occurredAt, payload_json: row.payloadJson });
      updateSourceDigest(digest, row);
      ids.add(row.id);
      previous = row;
      count += 1;
    }
    await writer.close();
    return { count, sourceSnapshotSha256: digest.digest("hex") };
  } catch (error) {
    try { await writer.close(); } catch { /* preserve original failure */ }
    throw error;
  }
}

export async function scanAndVerifyHistoryFactsParquet(path: string, manifest: HistoryFactArchiveManifestV1, onRow: (row: HistoryFactRecord) => void = () => {}): Promise<number> {
  const [fileStat, objectSha256] = await Promise.all([stat(path), historyFactSha256File(path)]);
  if (fileStat.size !== manifest.compressedBytes || objectSha256 !== manifest.sha256) throw archiveError("history_fact_archive_object_mismatch");
  registerZstd();
  const reader = await ParquetReader.openFile(path);
  const digest = createHash("sha256");
  let count = 0;
  let previous: HistoryFactRecord | undefined;
  const ids = new Set<string>();
  try {
    const uncompressedBytes = reader.metadata?.row_groups.reduce((total, group) => total + group.columns.reduce((sum, column) => sum + Number(column.meta_data?.total_uncompressed_size?.valueOf() ?? 0), 0), 0) ?? 0;
    if (uncompressedBytes !== manifest.uncompressedBytes) throw archiveError("history_fact_archive_uncompressed_size_mismatch");
    const fields = reader.getSchema().fieldList.filter((field) => !field.isNested).map((field) => field.name);
    const expected = ["id", "request_id", "occurred_at", "payload_json"];
    if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) throw archiveError("history_fact_archive_schema_mismatch");
    const cursor = reader.getCursor();
    while (true) {
      const raw = await cursor.next();
      if (raw === null) break;
      const row = fromParquetRow(raw as Record<string, unknown>);
      assertRecord(row, previous);
      if (ids.has(row.id)) throw archiveError("history_fact_archive_duplicate_id");
      if (row.occurredAt < manifest.cutoffGte || row.occurredAt >= manifest.cutoffLt) throw archiveError("history_fact_archive_cutoff_mismatch");
      updateSourceDigest(digest, row);
      onRow(row);
      count += 1;
      ids.add(row.id);
      previous = row;
    }
  } finally {
    await reader.close();
  }
  if (count !== manifest.recordCount) throw archiveError("history_fact_archive_row_count_mismatch");
  if (digest.digest("hex") !== manifest.sourceSnapshotSha256) throw archiveError("history_fact_archive_source_snapshot_mismatch");
  return count;
}

export function parseHistoryFactArchiveManifestV1(value: string | unknown): HistoryFactArchiveManifestV1 {
  let raw: Record<string, unknown>;
  try { raw = (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>; }
  catch { throw archiveError("history_fact_archive_manifest_invalid"); }
  const allowed = new Set(["manifestVersion", "schemaVersion", "kind", "domain", "cutoffGte", "cutoffLt", "recordCount", "objectKey", "compressedBytes", "uncompressedBytes", "sha256", "sourceSnapshotSha256", "createdAt"]);
  if (!raw || Object.keys(raw).some((key) => !allowed.has(key)) || raw.manifestVersion !== 1 || raw.schemaVersion !== 1 || raw.kind !== "history-facts") throw archiveError("history_fact_archive_manifest_invalid");
  const manifest: HistoryFactArchiveManifestV1 = {
    manifestVersion: 1,
    schemaVersion: 1,
    kind: "history-facts",
    domain: stringValue(raw.domain),
    cutoffGte: stringValue(raw.cutoffGte),
    cutoffLt: stringValue(raw.cutoffLt),
    recordCount: integerValue(raw.recordCount),
    objectKey: stringValue(raw.objectKey),
    compressedBytes: integerValue(raw.compressedBytes),
    uncompressedBytes: integerValue(raw.uncompressedBytes),
    sha256: stringValue(raw.sha256),
    sourceSnapshotSha256: stringValue(raw.sourceSnapshotSha256),
    createdAt: stringValue(raw.createdAt),
  };
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(manifest.domain) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !/^[a-f0-9]{64}$/.test(manifest.sourceSnapshotSha256) || !/^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(manifest.cutoffGte) || !/^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(manifest.cutoffLt) || Number.isNaN(Date.parse(manifest.createdAt))) throw archiveError("history_fact_archive_manifest_invalid");
  return manifest;
}

export async function historyFactParquetUncompressedBytes(path: string): Promise<number> {
  registerZstd();
  const reader = await ParquetReader.openFile(path);
  try { return reader.metadata?.row_groups.reduce((total, group) => total + group.columns.reduce((sum, column) => sum + Number(column.meta_data?.total_uncompressed_size?.valueOf() ?? 0), 0), 0) ?? 0; }
  finally { await reader.close(); }
}

export async function historyFactSha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function historyFactSha256Hex(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

export function historyFactSourceSnapshot(rows: Iterable<HistoryFactRecord>): { count: number; sha256: string } {
  const digest = createHash("sha256");
  let count = 0;
  for (const row of rows) {
    updateSourceDigest(digest, row);
    count += 1;
  }
  return { count, sha256: digest.digest("hex") };
}

function historyFactParquetSchema(): ParquetSchema {
  const text = (): FieldDefinition => ({ type: "UTF8", compression: "ZSTD" as ParquetCompression });
  return new ParquetSchema({ id: text(), request_id: { ...text(), optional: true }, occurred_at: text(), payload_json: text() });
}

function registerZstd(): void {
  PARQUET_COMPRESSION_METHODS.ZSTD ??= { deflate: (value: Uint8Array) => zstdCompressSync(value), inflate: (value: Uint8Array) => zstdDecompressSync(value) };
}

function fromParquetRow(row: Record<string, unknown>): HistoryFactRecord {
  return { id: stringValue(row.id), requestId: nullableString(row.request_id), occurredAt: stringValue(row.occurred_at), payloadJson: jsonValue(row.payload_json) };
}

function assertRecord(row: HistoryFactRecord, previous?: HistoryFactRecord): void {
  if (!row.id || Number.isNaN(Date.parse(row.occurredAt))) throw archiveError("history_fact_archive_value_invalid");
  jsonValue(row.payloadJson);
  if (previous && (row.occurredAt < previous.occurredAt || (row.occurredAt === previous.occurredAt && row.id <= previous.id))) throw archiveError("history_fact_archive_order_invalid");
}

function updateSourceDigest(digest: ReturnType<typeof createHash>, row: HistoryFactRecord): void {
  digest.update(`${JSON.stringify([row.id, row.requestId, row.occurredAt, row.payloadJson])}\n`);
}

function stringValue(value: unknown): string { if (typeof value !== "string") throw archiveError("history_fact_archive_value_invalid"); return value; }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : stringValue(value); }
function jsonValue(value: unknown): string { const text = stringValue(value); try { JSON.parse(text); } catch { throw archiveError("history_fact_archive_value_invalid"); } return text; }
function integerValue(value: unknown): number { const number = typeof value === "bigint" ? Number(value) : value; if (!Number.isSafeInteger(number) || (number as number) < 0) throw archiveError("history_fact_archive_value_invalid"); return number as number; }
function archiveError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
