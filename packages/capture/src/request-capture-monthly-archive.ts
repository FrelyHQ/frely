import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { AppConfig } from "@frely/config";
import { FilesystemArchiveRemote, preflightFilesystemArchiveMount, type ArchiveRemote } from "./archive-remote.js";
import {
  REQUEST_CAPTURE_ARCHIVE_CATALOG_SCHEMA_VERSION,
  queryRequestCaptureArchiveCatalog,
  readAndVerifyRequestCaptureArchiveCatalog,
  writeRequestCaptureArchiveCatalog,
  type RequestCaptureArchiveCatalogFilter,
  type RequestCaptureArchiveCatalogRow,
  type RequestCaptureArchiveObject,
  type RequestCaptureArchiveQueryScope,
} from "./request-capture-archive-catalog.js";
import type { RequestLog } from "./contracts.js";
import {
  RequestCaptureV3Storage,
  decodeRequestCaptureV3Record,
  parseRequestCaptureV3Jsonl,
  type RequestCaptureV3Record,
} from "./request-capture-v3.js";
import {
  REQUEST_CAPTURE_V3_MAX_COMPRESSED_BYTES,
  REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES,
  REQUEST_CAPTURE_V3_ZSTD_LEVEL,
} from "./request-capture-v3-limits.js";

export const REQUEST_CAPTURE_MONTHLY_ARCHIVE_FORMAT_VERSION = 3 as const;
export const REQUEST_CAPTURE_MONTHLY_VERIFIER_VERSION = "capture-monthly-v3" as const;
export const REQUEST_LIFECYCLE_ABANDONED_ERROR_CODE = "request_lifecycle_abandoned" as const;

const PACK_MAGIC = Buffer.from("FRCAPV3\0", "ascii");
const LEGACY_PACK_MAGIC = Buffer.from("FRCAPV2\0", "ascii");
const PACK_FRAME_HEADER_BYTES = 76;
const MAX_PACK_FRAME_COMPRESSED_BYTES = REQUEST_CAPTURE_V3_MAX_COMPRESSED_BYTES + 1024 * 1024;
const REQUEST_LOG_PAGE_SIZE = 10_000;
const STAGING_CATALOG_BASE_BYTES = 8 * 1024 * 1024;
const STAGING_CATALOG_MINIMUM_ROW_BYTES = 4 * 1024;
const STAGING_HOT_HEADROOM_BYTES = 1024 * 1024 * 1024;

export interface RequestCaptureMonthlyArchiveManifestV3 {
  manifestVersion: 3;
  archiveFormatVersion: 3;
  catalogSchemaVersion: typeof REQUEST_CAPTURE_ARCHIVE_CATALOG_SCHEMA_VERSION;
  kind: "request-capture-month";
  archiveMonth: string;
  cutoffGte: string;
  cutoffLt: string;
  sourceSnapshotSha256: string;
  recordCount: number;
  frameCount: number;
  frameUncompressedBytes: number;
  uncompressedBytes: number;
  compressedBytes: number;
  catalog: RequestCaptureArchiveObject;
  pack: RequestCaptureArchiveObject;
  createdAt: string;
  verifierVersion: typeof REQUEST_CAPTURE_MONTHLY_VERIFIER_VERSION;
}

export interface RequestCaptureMonthlyArchiveManifestV2 {
  manifestVersion: 2;
  archiveFormatVersion: 2;
  kind: "request-capture-month";
  archiveMonth: string;
  cutoffGte: string;
  cutoffLt: string;
  sourceSnapshotSha256: string;
  recordCount: number;
  frameCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
  pack: RequestCaptureArchiveObject;
  createdAt: string;
  verifierVersion: "capture-monthly-v2";
}

interface ArchiveSourcePort {
  listRecentRequestLogs(filter?: {
    startedAtGte?: string;
    startedAtLte?: string;
  }, limit?: number, offset?: number): Promise<RequestLog[]>;
}

interface HotCaptureSource {
  log: RequestLog;
  path: string;
  compressedBytes: number;
  mtimeMs: number;
}

interface VerifiedHotCaptureSource extends HotCaptureSource {
  record: RequestCaptureV3Record;
  raw: Buffer;
  rawSha256: string;
}

interface DecodedFrame {
  raw: Buffer;
  compressedLength: number;
  rawLength: number;
  recordCount: number;
  frameSha256: string;
}

interface StagedCaptureMonth {
  manifest: RequestCaptureMonthlyArchiveManifestV3;
  packPath: string;
  catalogPath: string;
}

export interface RequestCaptureMonthlyArchivePlan {
  archiveMonth: string;
  cutoff: { gte: string; lt: string };
}

export type RequestCaptureMonthlyArchiveProgressPhase =
  | "month_started"
  | "preflight"
  | "source_inventory"
  | "staging"
  | "cold_pack_promotion"
  | "cold_catalog_promotion"
  | "cold_verify"
  | "manifest_commit"
  | "completed"
  | "month_failed";

export interface RequestCaptureMonthlyArchiveProgress {
  archiveMonth: string;
  phase: RequestCaptureMonthlyArchiveProgressPhase;
  recordsProcessed: number;
  recordsTotal: number;
  sourceCompressedBytesProcessed: number;
  sourceCompressedBytesTotal: number;
  framesCompleted: number;
  compressedBytes: number;
  elapsedMs: number;
  failureCode?: string;
}

export type RequestCaptureMonthlyArchiveProgressReporter = (
  progress: RequestCaptureMonthlyArchiveProgress,
) => void | Promise<void>;

type RequestCaptureMonthlyArchiveProgressValues = Pick<
  RequestCaptureMonthlyArchiveProgress,
  "recordsProcessed" | "recordsTotal" | "sourceCompressedBytesProcessed" | "sourceCompressedBytesTotal" | "framesCompleted" | "compressedBytes"
>;

export interface RequestCaptureMonthlyArchiveRunResult {
  archiveMonth: string;
  recordCount: number;
  frameCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
  sourceSnapshotSha256: string;
  idempotent: boolean;
  localOnly: boolean;
  capacity: RequestCaptureMonthlyArchiveCapacity;
  stagingDirectory?: string;
}

export interface RequestCaptureMonthlyArchiveCapacity {
  requiredHotStagingBytes: number;
  requiredColdBytes: number;
  hotAvailableBytes: number;
  coldAvailableBytes: number | null;
}

export type RequestCaptureMonthlyArchiveCatchUpResult =
  | { archiveMonth: string; status: "archived"; result: RequestCaptureMonthlyArchiveRunResult }
  | { archiveMonth: string; status: "blocked"; failureCode: string };

export interface RequestCaptureMonthlyArchiveVerificationResult {
  manifest: RequestCaptureMonthlyArchiveManifestV3;
  verifiedRecords: number;
  verifiedFrames: number;
}

export interface RequestCaptureMonthlyArchivePurgeResult {
  archiveMonth: string;
  eligibleCount: number;
  removedCount: number;
  alreadyMissingCount: number;
  remainingEligibleCount: number;
}

export interface RequestCaptureVerifiedMonthPurgeResult extends RequestCaptureMonthlyArchivePurgeResult {
  execute: boolean;
  reclaimableBytes: number;
  removedBytes: number;
}

export interface RequestCaptureArchiveQueryInput {
  months: readonly string[];
  filter: RequestCaptureArchiveCatalogFilter;
  scope: RequestCaptureArchiveQueryScope;
}

export type RequestCaptureArchiveQueryRow =
  | (RequestCaptureArchiveCatalogRow & {
      source: "catalog";
      archiveFormatVersion: 3;
      archiveMonth: string;
    })
  | RequestCaptureArchivePackScanRow;

export interface RequestCaptureArchivePackScanRow {
  source: "pack_scan";
  archiveFormatVersion: 2 | 3;
  archiveMonth: string;
  requestId: string;
  capturedAt: string;
  responseCapturedAt: string | null;
  responseStatus: number | null;
  responseErrorCode: string | null;
  userId: string;
  teamId: string | null;
  apiKeyId: string;
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

interface PackScanManifest {
  archiveFormatVersion: 2 | 3;
  archiveMonth: string;
  recordCount: number;
  frameCount: number;
  uncompressedBytes: number;
  frameUncompressedBytes: number;
  pack: RequestCaptureArchiveObject;
}

export function planRequestCaptureArchiveMonth(value: string | undefined, now = new Date()): RequestCaptureMonthlyArchivePlan {
  const currentMonth = now.toISOString().slice(0, 7);
  let archiveMonth = value;
  if (!archiveMonth || archiveMonth === "previous") {
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    archiveMonth = previous.toISOString().slice(0, 7);
  }
  assertArchiveMonth(archiveMonth);
  if (archiveMonth >= currentMonth) throw archiveError("request_capture_archive_month_not_complete");
  const gte = `${archiveMonth}-01T00:00:00.000Z`;
  const lt = new Date(gte);
  lt.setUTCMonth(lt.getUTCMonth() + 1);
  return { archiveMonth, cutoff: { gte, lt: lt.toISOString() } };
}

export async function runRequestCaptureMonthlyArchive(input: {
  config: AppConfig;
  source: ArchiveSourcePort;
  month?: string;
  now?: Date;
  dryRun?: boolean;
  localOnly?: boolean;
  skipMountIdentityCheck?: boolean;
  onProgress?: RequestCaptureMonthlyArchiveProgressReporter;
}): Promise<RequestCaptureMonthlyArchiveRunResult> {
  const startedAtMs = Date.now();
  const plan = planRequestCaptureArchiveMonth(input.month, input.now);
  const report = (phase: RequestCaptureMonthlyArchiveProgressPhase, values: Partial<Omit<RequestCaptureMonthlyArchiveProgress, "archiveMonth" | "phase" | "elapsedMs">> = {}) => reportArchiveProgress(input.onProgress, {
    archiveMonth: plan.archiveMonth,
    phase,
    recordsProcessed: values.recordsProcessed ?? 0,
    recordsTotal: values.recordsTotal ?? 0,
    sourceCompressedBytesProcessed: values.sourceCompressedBytesProcessed ?? 0,
    sourceCompressedBytesTotal: values.sourceCompressedBytesTotal ?? 0,
    framesCompleted: values.framesCompleted ?? 0,
    compressedBytes: values.compressedBytes ?? 0,
    elapsedMs: Math.max(0, Date.now() - startedAtMs),
    ...(values.failureCode ? { failureCode: values.failureCode } : {}),
  });
  await report("preflight");
  if (!input.localOnly && !input.config.requestCapture.archive.enabled) throw archiveError("request_capture_archive_disabled");
  const storage = captureStorage(input.config);
  const hotRoot = resolve(input.config.archive.directory);
  const coldDirectory = input.localOnly ? null : requiredColdDirectory(input.config);
  const remote = coldDirectory
    ? new FilesystemArchiveRemote(coldDirectory, { createRoot: false, enforcePrivateObjects: true })
    : null;

  let coldAvailableBytes: number | null = null;
  if (remote && coldDirectory) {
    const coldPreflight = await preflightFilesystemArchiveMount({
      coldDirectory,
      hotDirectory: hotRoot,
      requireMount: input.skipMountIdentityCheck ? false : input.config.archive.requireColdMount,
      minimumAvailableBytes: 1,
      writeProbe: !input.dryRun,
    });
    coldAvailableBytes = coldPreflight.availableBytes;
    const existing = await readRemoteManifestIfPresent(remote, plan.archiveMonth);
    if (existing) {
      const verified = await verifyRequestCaptureMonthlyArchive({
        remote,
        manifest: existing,
        onProgress: (progress) => report("cold_verify", progress),
      });
      await assertCurrentHotFilesCovered(
        input.source,
        storage,
        remote,
        verified.manifest,
        input.config.requestCapture.hotDays,
        input.now ?? new Date(),
      );
      await report("completed", {
        recordsProcessed: existing.recordCount,
        recordsTotal: existing.recordCount,
        framesCompleted: existing.frameCount,
        compressedBytes: existing.compressedBytes,
      });
      return archiveResult(existing, true, false, {
        requiredHotStagingBytes: 0,
        requiredColdBytes: 0,
        hotAvailableBytes: await filesystemAvailableBytes(hotRoot),
        coldAvailableBytes,
      });
    }
  }

  const sources = await collectHotSources(input.source, storage, plan, async (recordsProcessed) => report("source_inventory", { recordsProcessed }));
  const sourceCompressedBytesTotal = sources.reduce((sum, source) => sum + source.compressedBytes, 0);
  await report("source_inventory", {
    recordsProcessed: sources.length,
    recordsTotal: sources.length,
    sourceCompressedBytesProcessed: sourceCompressedBytesTotal,
    sourceCompressedBytesTotal,
  });
  const stagingBundleUpperBound = inspectStagingBundleUpperBound(
    sources,
    input.config.requestCapture.archive.frameUncompressedBytes,
  );
  const requirements = input.localOnly
    ? {
        requiredHotStagingBytes: stagingBundleUpperBound,
        requiredColdBytes: 0,
      }
    : {
        requiredHotStagingBytes: 0,
        // Production writes one private staged bundle and promotes each large
        // object by same-filesystem rename, so publication never duplicates it.
        requiredColdBytes: stagingBundleUpperBound,
      };
  const hotAvailableBytes = await filesystemAvailableBytes(hotRoot);
  const capacity: RequestCaptureMonthlyArchiveCapacity = {
    ...requirements,
    hotAvailableBytes,
    coldAvailableBytes,
  };
  if (input.dryRun) {
    await report("completed", {
      recordsProcessed: sources.length,
      recordsTotal: sources.length,
      sourceCompressedBytesProcessed: sourceCompressedBytesTotal,
      sourceCompressedBytesTotal,
    });
    return {
      archiveMonth: plan.archiveMonth,
      recordCount: sources.length,
      frameCount: 0,
      uncompressedBytes: 0,
      compressedBytes: sourceCompressedBytesTotal,
      sourceSnapshotSha256: "",
      idempotent: false,
      localOnly: Boolean(input.localOnly),
      capacity,
    };
  }

  if (input.localOnly && hotAvailableBytes < requirements.requiredHotStagingBytes + STAGING_HOT_HEADROOM_BYTES) {
    throw archiveError("request_capture_archive_hot_staging_space_insufficient");
  }

  if (coldDirectory) {
    const coldPreflight = await preflightFilesystemArchiveMount({
      coldDirectory,
      hotDirectory: hotRoot,
      requireMount: input.skipMountIdentityCheck ? false : input.config.archive.requireColdMount,
      minimumAvailableBytes: Math.max(1, requirements.requiredColdBytes),
      writeProbe: true,
    });
    capacity.coldAvailableBytes = coldPreflight.availableBytes;
  }

  const stagingRoot = join(input.localOnly ? hotRoot : requiredColdDirectory(input.config), ".staging");
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const stagingDirectory = await fs.mkdtemp(join(stagingRoot, `capture-month-${plan.archiveMonth}-`));
  await fs.chmod(stagingDirectory, 0o700);
  try {
    const staged = await stageRequestCaptureMonth({
      plan,
      sources,
      stagingDirectory,
      createdAt: (input.now ?? new Date()).toISOString(),
      frameUncompressedBytes: input.config.requestCapture.archive.frameUncompressedBytes,
      zstdLevel: input.config.requestCapture.archive.zstdLevel,
      onProgress: (progress) => report("staging", progress),
    });
    if (sourceSnapshotSha256FromHotSources(sources) !== staged.manifest.sourceSnapshotSha256) {
      throw archiveError("request_capture_archive_source_drift");
    }
    if (input.localOnly) {
      await report("completed", {
        recordsProcessed: staged.manifest.recordCount,
        recordsTotal: staged.manifest.recordCount,
        sourceCompressedBytesProcessed: sourceCompressedBytesTotal,
        sourceCompressedBytesTotal,
        framesCompleted: staged.manifest.frameCount,
        compressedBytes: staged.manifest.compressedBytes,
      });
      return { ...archiveResult(staged.manifest, false, true, capacity), stagingDirectory };
    }
    if (!remote) throw archiveError("request_capture_archive_cold_directory_required");

    // The cold mount receives each large object exactly once in private staging.
    // Promotion is a same-filesystem server-side rename; the small manifest is
    // still the final commit marker after a complete remote readback.
    await report("cold_pack_promotion", archiveProgressFromManifest(staged.manifest, sourceCompressedBytesTotal));
    await remote.promoteStagedFile(staged.manifest.pack.objectKey, staged.packPath, staged.manifest.pack.bytes, staged.manifest.pack.sha256);
    await report("cold_pack_promotion", archiveProgressFromManifest(staged.manifest, sourceCompressedBytesTotal));
    await report("cold_catalog_promotion", archiveProgressFromManifest(staged.manifest, sourceCompressedBytesTotal));
    await remote.promoteStagedFile(staged.manifest.catalog.objectKey, staged.catalogPath, staged.manifest.catalog.bytes, staged.manifest.catalog.sha256);
    await report("cold_catalog_promotion", archiveProgressFromManifest(staged.manifest, sourceCompressedBytesTotal));
    await verifyRequestCaptureMonthlyArchive({
      remote,
      manifest: staged.manifest,
      onProgress: (progress) => report("cold_verify", {
        ...progress,
        sourceCompressedBytesProcessed: sourceCompressedBytesTotal,
        sourceCompressedBytesTotal,
      }),
    });
    const bytes = manifestBytes(staged.manifest);
    await report("manifest_commit", archiveProgressFromManifest(staged.manifest, sourceCompressedBytesTotal));
    await remote.put(captureManifestObjectKey(plan.archiveMonth), bytes, sha256Hex(bytes));
    const committed = await readRemoteManifest(remote, plan.archiveMonth);
    if (!manifestBytes(committed).equals(bytes)) throw archiveError("request_capture_archive_manifest_commit_mismatch");
    if (sourceSnapshotSha256FromHotSources(sources) !== committed.sourceSnapshotSha256) {
      throw archiveError("request_capture_archive_source_drift");
    }
    await report("completed", archiveProgressFromManifest(committed, sourceCompressedBytesTotal));
    return archiveResult(committed, false, false, capacity);
  } finally {
    if (!input.localOnly) await fs.rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function runRequestCaptureMonthlyArchiveCatchUp(
  input: Omit<Parameters<typeof runRequestCaptureMonthlyArchive>[0], "month"> & {
    beforeArchiveMonth?: (month: string) => Promise<void>;
  },
): Promise<RequestCaptureMonthlyArchiveCatchUpResult[]> {
  const first = firstHotCaptureMonth(input.config.archive.directory);
  if (!first) return [];
  const last = planRequestCaptureArchiveMonth("previous", input.now).archiveMonth;
  const results: RequestCaptureMonthlyArchiveCatchUpResult[] = [];
  const { beforeArchiveMonth, onProgress, ...archiveInput } = input;
  for (let month = first; month <= last; month = nextMonth(month)) {
    let lastProgress: RequestCaptureMonthlyArchiveProgress = {
      archiveMonth: month,
      phase: "month_started",
      recordsProcessed: 0,
      recordsTotal: 0,
      sourceCompressedBytesProcessed: 0,
      sourceCompressedBytesTotal: 0,
      framesCompleted: 0,
      compressedBytes: 0,
      elapsedMs: 0,
    };
    try {
      await reportArchiveProgress(onProgress, lastProgress);
      await beforeArchiveMonth?.(month);
      results.push({
        archiveMonth: month,
        status: "archived",
        result: await runRequestCaptureMonthlyArchive({
          ...archiveInput,
          month,
          onProgress: async (progress) => {
            lastProgress = progress;
            await reportArchiveProgress(onProgress, progress);
          },
        }),
      });
    } catch (error) {
      const failureCode = stableArchiveFailureCode(error);
      await reportArchiveProgress(onProgress, {
        ...lastProgress,
        phase: "month_failed",
        failureCode,
      });
      results.push({ archiveMonth: month, status: "blocked", failureCode });
    }
  }
  return results;
}

export async function verifyRequestCaptureMonthlyArchive(input: {
  remote: ArchiveRemote;
  manifest: RequestCaptureMonthlyArchiveManifestV3;
  onProgress?: (progress: RequestCaptureMonthlyArchiveProgressValues) => void | Promise<void>;
}): Promise<RequestCaptureMonthlyArchiveVerificationResult> {
  const manifest = parseRequestCaptureMonthlyArchiveManifest(input.manifest);
  const magic = await input.remote.readRange(manifest.pack.objectKey, 0, PACK_MAGIC.length);
  if (!magic.equals(PACK_MAGIC)) throw archiveError("request_capture_archive_pack_version_invalid");
  const packSha256 = createHash("sha256").update(magic);
  const rows = await readAndVerifyRequestCaptureArchiveCatalog({
    remote: input.remote,
    catalog: manifest.catalog,
    archiveMonth: manifest.archiveMonth,
    pack: manifest.pack,
    recordCount: manifest.recordCount,
  });
  const frames = groupCatalogFrames(rows);
  const sourceSnapshot = createHash("sha256");
  let expectedFrameOffset = PACK_MAGIC.length;
  let verifiedRecords = 0;
  let verifiedUncompressedBytes = 0;
  let frameFailure: unknown;
  await input.onProgress?.({
    recordsProcessed: 0,
    recordsTotal: manifest.recordCount,
    sourceCompressedBytesProcessed: 0,
    sourceCompressedBytesTotal: 0,
    framesCompleted: 0,
    compressedBytes: PACK_MAGIC.length,
  });
  for (const [frameIndex, frame] of frames.entries()) {
    if (frame.offset !== expectedFrameOffset) throw archiveError("request_capture_archive_pack_frame_coverage_invalid");
    const bytes = await input.remote.readRange(manifest.pack.objectKey, frame.offset, frame.length);
    packSha256.update(bytes);
    try {
      const decoded = decodeFrame(bytes, frame.length);
      if (
        decoded.frameSha256 !== frame.sha256
        || decoded.rawLength !== frame.uncompressedLength
        || decoded.rawLength > manifest.frameUncompressedBytes
      ) {
        throw archiveError("request_capture_archive_pack_frame_invalid");
      }
      verifyFrameCatalogRecords(decoded, frame.rows, sourceSnapshot);
      verifiedRecords += frame.rows.length;
      verifiedUncompressedBytes += decoded.rawLength;
    } catch (error) {
      frameFailure ??= error;
    }
    expectedFrameOffset += frame.length;
    await input.onProgress?.({
      recordsProcessed: verifiedRecords,
      recordsTotal: manifest.recordCount,
      sourceCompressedBytesProcessed: 0,
      sourceCompressedBytesTotal: 0,
      framesCompleted: frameIndex + 1,
      compressedBytes: expectedFrameOffset,
    });
  }
  if (packSha256.digest("hex") !== manifest.pack.sha256) throw archiveError("request_capture_archive_object_mismatch");
  if (frameFailure) throw frameFailure;
  if (
    expectedFrameOffset !== manifest.pack.bytes
    || frames.length !== manifest.frameCount
    || verifiedRecords !== manifest.recordCount
    || verifiedUncompressedBytes !== manifest.uncompressedBytes
  ) {
    throw archiveError("request_capture_archive_pack_content_mismatch");
  }
  if (sourceSnapshot.digest("hex") !== manifest.sourceSnapshotSha256) {
    throw archiveError("request_capture_archive_source_snapshot_mismatch");
  }
  return { manifest, verifiedRecords, verifiedFrames: frames.length };
}

export async function verifyConfiguredRequestCaptureMonthlyArchive(input: {
  config: AppConfig;
  month: string;
  skipMountIdentityCheck?: boolean;
}): Promise<RequestCaptureMonthlyArchiveVerificationResult> {
  assertArchiveMonth(input.month);
  const coldDirectory = requiredColdDirectory(input.config);
  await preflightFilesystemArchiveMount({
    coldDirectory,
    hotDirectory: input.config.archive.directory,
    requireMount: input.skipMountIdentityCheck ? false : input.config.archive.requireColdMount,
    writeProbe: false,
  });
  const remote = new FilesystemArchiveRemote(coldDirectory, { createRoot: false, enforcePrivateObjects: true });
  return verifyRequestCaptureMonthlyArchive({ remote, manifest: await readRemoteManifest(remote, input.month) });
}

export async function queryRequestCaptureMonthlyArchives(
  remote: ArchiveRemote,
  input: RequestCaptureArchiveQueryInput,
): Promise<RequestCaptureArchiveCatalogRow[]> {
  const months = [...new Set(input.months)];
  if (months.length === 0) throw archiveError("request_capture_archive_query_month_required");
  months.forEach(assertArchiveMonth);
  const results: RequestCaptureArchiveCatalogRow[] = [];
  const ids = new Set<string>();
  for (const month of months.sort()) {
    const manifest = await readRemoteManifest(remote, month);
    const rows = await queryRequestCaptureArchiveCatalog({
      remote,
      catalog: manifest.catalog,
      archiveMonth: manifest.archiveMonth,
      pack: manifest.pack,
      recordCount: manifest.recordCount,
      filter: input.filter,
      scope: input.scope,
    });
    for (const row of rows) {
      if (ids.has(row.requestId)) throw archiveError("request_capture_archive_duplicate_request_id");
      ids.add(row.requestId);
      results.push(row);
    }
  }
  return results.sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.requestId.localeCompare(right.requestId));
}

/**
 * Offline compatibility query. A committed v3 Catalog remains the preferred
 * path. If that object is absent, or if the month is an archive-format-v2
 * bundle that never had a Catalog, the pack is scanned one frame at a time.
 * Pack scanning only accepts filters whose facts exist in Capture v3 records;
 * it never fabricates Request Log-only metadata.
 */
export async function queryRequestCaptureMonthlyArchivesWithFallback(
  remote: ArchiveRemote,
  input: RequestCaptureArchiveQueryInput,
): Promise<RequestCaptureArchiveQueryRow[]> {
  const months = [...new Set(input.months)];
  if (months.length === 0) throw archiveError("request_capture_archive_query_month_required");
  months.forEach(assertArchiveMonth);
  const results: RequestCaptureArchiveQueryRow[] = [];
  const ids = new Set<string>();
  for (const month of months.sort()) {
    const v3 = await readRemoteManifestIfPresent(remote, month);
    let rows: RequestCaptureArchiveQueryRow[];
    if (v3) {
      try {
        rows = (await queryRequestCaptureArchiveCatalog({
          remote,
          catalog: v3.catalog,
          archiveMonth: v3.archiveMonth,
          pack: v3.pack,
          recordCount: v3.recordCount,
          filter: input.filter,
          scope: input.scope,
        })).map((row) => ({ ...row, source: "catalog", archiveFormatVersion: 3, archiveMonth: month }));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        rows = await queryPackWithoutCatalog(remote, packScanManifest(v3), input.filter, input.scope);
      }
    } else {
      const legacy = await readLegacyRemoteManifest(remote, month);
      rows = await queryPackWithoutCatalog(remote, packScanManifest(legacy), input.filter, input.scope);
    }
    for (const row of rows) {
      if (ids.has(row.requestId)) throw archiveError("request_capture_archive_duplicate_request_id");
      ids.add(row.requestId);
      results.push(row);
    }
  }
  return results.sort((left, right) => queryRowTimestamp(left).localeCompare(queryRowTimestamp(right)) || left.requestId.localeCompare(right.requestId));
}

export async function readRequestCaptureArchiveRecordByRequestId(input: {
  remote: ArchiveRemote;
  month: string;
  requestId: string;
}): Promise<Buffer | null> {
  assertArchiveMonth(input.month);
  const v3 = await readRemoteManifestIfPresent(input.remote, input.month);
  if (v3) {
    try {
      const rows = await queryRequestCaptureArchiveCatalog({
        remote: input.remote,
        catalog: v3.catalog,
        archiveMonth: v3.archiveMonth,
        pack: v3.pack,
        recordCount: v3.recordCount,
        filter: { requestId: input.requestId },
        scope: { kind: "request", requestId: input.requestId },
      });
      return rows[0]
        ? readRequestCaptureArchiveRecord({ remote: input.remote, manifest: v3, locator: rows[0] })
        : null;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      return (await scanPackWithoutCatalog(input.remote, packScanManifest(v3), {
        targetRequestId: input.requestId,
        rowFilter: () => false,
      })).matchedRaw;
    }
  }
  const legacy = await readLegacyRemoteManifestIfPresent(input.remote, input.month);
  if (!legacy) return null;
  return (await scanPackWithoutCatalog(input.remote, packScanManifest(legacy), {
    targetRequestId: input.requestId,
    rowFilter: () => false,
  })).matchedRaw;
}

export async function readRequestCaptureArchiveRecord(input: {
  remote: ArchiveRemote;
  manifest: RequestCaptureMonthlyArchiveManifestV3;
  locator: RequestCaptureArchiveCatalogRow;
}): Promise<Buffer> {
  const manifest = parseRequestCaptureMonthlyArchiveManifest(input.manifest);
  assertLocatorForManifest(input.locator, manifest);
  const frameBytes = await input.remote.readRange(
    manifest.pack.objectKey,
    input.locator.frameOffset,
    input.locator.frameLength,
  );
  const frame = decodeFrame(frameBytes, input.locator.frameLength);
  if (
    frame.frameSha256 !== input.locator.frameSha256
    || frame.rawLength !== input.locator.frameUncompressedLength
    || frame.rawLength > manifest.frameUncompressedBytes
    || input.locator.recordOffset + input.locator.recordLength > frame.raw.length
  ) {
    throw archiveError("request_capture_archive_pack_frame_invalid");
  }
  const raw = Buffer.from(frame.raw.subarray(
    input.locator.recordOffset,
    input.locator.recordOffset + input.locator.recordLength,
  ));
  if (sha256Hex(raw) !== input.locator.recordSha256) throw archiveError("request_capture_archive_record_hash_mismatch");
  const record = parseRequestCaptureV3Jsonl(raw);
  if (record.requestId !== input.locator.requestId || record.schemaVersion !== input.locator.captureSchemaVersion) {
    throw archiveError("request_capture_archive_record_mismatch");
  }
  return raw;
}

export async function copyRequestCaptureArchiveBundle(input: {
  source: ArchiveRemote;
  target: ArchiveRemote;
  month: string;
  stagingDirectory: string;
}): Promise<RequestCaptureMonthlyArchiveVerificationResult> {
  assertArchiveMonth(input.month);
  const manifest = await readRemoteManifest(input.source, input.month);
  await verifyRequestCaptureMonthlyArchive({ remote: input.source, manifest });
  await fs.mkdir(input.stagingDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await fs.mkdtemp(join(input.stagingDirectory, `capture-copy-${input.month}-`));
  await fs.chmod(temporaryDirectory, 0o700);
  try {
    const packPath = join(temporaryDirectory, "captures-pack-v3.zstpack");
    const catalogPath = join(temporaryDirectory, "captures-catalog-v1.parquet");
    await input.source.downloadToFile(manifest.pack.objectKey, packPath);
    await input.source.downloadToFile(manifest.catalog.objectKey, catalogPath);
    await input.target.putFile(manifest.pack.objectKey, packPath, manifest.pack.bytes, manifest.pack.sha256);
    await input.target.putFile(manifest.catalog.objectKey, catalogPath, manifest.catalog.bytes, manifest.catalog.sha256);
    const bytes = manifestBytes(manifest);
    await input.target.put(captureManifestObjectKey(input.month), bytes, sha256Hex(bytes));
    const copied = await readRemoteManifest(input.target, input.month);
    return verifyRequestCaptureMonthlyArchive({ remote: input.target, manifest: copied });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function finalizeRequestCaptureMonthlyArchive(input: {
  config: AppConfig;
  source: ArchiveSourcePort;
  month: string;
  now?: Date;
  skipMountIdentityCheck?: boolean;
}): Promise<RequestCaptureMonthlyArchivePurgeResult> {
  if (!input.config.requestCapture.archive.autoPurge) throw archiveError("request_capture_archive_purge_disabled");
  const verified = await verifyConfiguredRequestCaptureMonthlyArchive({
    config: input.config,
    month: input.month,
    ...(input.skipMountIdentityCheck === undefined ? {} : { skipMountIdentityCheck: input.skipMountIdentityCheck }),
  });
  const storage = captureStorage(input.config);
  const now = input.now ?? new Date();
  const remote = new FilesystemArchiveRemote(requiredColdDirectory(input.config), { createRoot: false, enforcePrivateObjects: true });
  await assertCurrentHotFilesCovered(
    input.source,
    storage,
    remote,
    verified.manifest,
    input.config.requestCapture.hotDays,
    now,
  );

  const cutoff = new Date(now.getTime() - input.config.requestCapture.hotDays * 86_400_000).toISOString();
  const logs = await listMonthRequestLogs(input.source, verified.manifest.cutoffGte, verified.manifest.cutoffLt);
  if (logs.some((log) => log.endedAt === null || !["completed", "failed"].includes(log.status))) {
    throw archiveError("request_capture_archive_month_not_terminal");
  }
  const logsById = requestLogsById(logs);
  const rows = sortCatalogRows(await queryRequestCaptureMonthlyArchives(remote, {
    months: [verified.manifest.archiveMonth],
    filter: { startedAtGte: verified.manifest.cutoffGte, startedAtLt: cutoff },
    scope: { kind: "platform_owner" },
  }));

  const pathsToRemove: string[] = [];
  let alreadyMissingCount = 0;
  for (const locator of rows) {
    const log = logsById.get(locator.requestId);
    if (!log || !catalogMatchesLog(locator, log)) {
      throw archiveError("request_capture_archive_source_inventory_mismatch");
    }
    const path = storage.pathForRequest(log.startedAt, log.id);
    if (!existsSync(path)) {
      alreadyMissingCount += 1;
      continue;
    }
    const source = verifyHotSource(hotSource(log, path));
    const coldRaw = await readRequestCaptureArchiveRecord({ remote, manifest: verified.manifest, locator });
    if (!source.raw.equals(coldRaw)) throw archiveError("request_capture_archive_source_drift");
    pathsToRemove.push(path);
  }

  let removedCount = 0;
  for (let offset = 0; offset < pathsToRemove.length; offset += input.config.requestCapture.archive.purgeBatchSize) {
    for (const path of pathsToRemove.slice(offset, offset + input.config.requestCapture.archive.purgeBatchSize)) {
      try {
        await fs.unlink(path);
        removedCount += 1;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        alreadyMissingCount += 1;
      }
    }
  }
  const eligibleCount = pathsToRemove.length + alreadyMissingCount;
  return {
    archiveMonth: verified.manifest.archiveMonth,
    eligibleCount,
    removedCount,
    alreadyMissingCount,
    remainingEligibleCount: Math.max(0, eligibleCount - removedCount - alreadyMissingCount),
  };
}

export async function purgeVerifiedRequestCaptureMonth(input: {
  config: AppConfig;
  source: ArchiveSourcePort;
  month: string;
  execute?: boolean;
  now?: Date;
  skipMountIdentityCheck?: boolean;
}): Promise<RequestCaptureVerifiedMonthPurgeResult> {
  if (input.config.requestCapture.archive.autoPurge) {
    throw archiveError("request_capture_verified_month_purge_requires_auto_purge_disabled");
  }
  const plan = planRequestCaptureArchiveMonth(input.month, input.now);
  const verified = await verifyConfiguredRequestCaptureMonthlyArchive({
    config: input.config,
    month: plan.archiveMonth,
    ...(input.skipMountIdentityCheck === undefined ? {} : { skipMountIdentityCheck: input.skipMountIdentityCheck }),
  });
  const storage = captureStorage(input.config);
  const remote = new FilesystemArchiveRemote(requiredColdDirectory(input.config), { createRoot: false, enforcePrivateObjects: true });
  const logs = await listMonthRequestLogs(input.source, plan.cutoff.gte, plan.cutoff.lt);
  if (logs.some((log) => log.endedAt === null || !["completed", "failed"].includes(log.status))) {
    throw archiveError("request_capture_archive_month_not_terminal");
  }
  const logsById = requestLogsById(logs);
  const rows = sortCatalogRows(await queryRequestCaptureMonthlyArchives(remote, {
    months: [plan.archiveMonth],
    filter: { startedAtGte: plan.cutoff.gte, startedAtLt: plan.cutoff.lt },
    scope: { kind: "platform_owner" },
  }));
  if (rows.length !== verified.manifest.recordCount) {
    throw archiveError("request_capture_archive_source_inventory_mismatch");
  }
  const archiveSources = rows.map((locator) => {
    const log = logsById.get(locator.requestId);
    if (!log || !catalogMatchesLog(locator, log)) {
      throw archiveError("request_capture_archive_source_inventory_mismatch");
    }
    return { locator, log, path: storage.pathForRequest(log.startedAt, log.id) };
  });
  const expectedPaths = new Set(archiveSources.map((source) => resolve(source.path)));
  const actualPaths = listMonthHotCaptureFiles(storage.config.archiveDirectory, plan.archiveMonth);
  if (actualPaths.some((path) => !expectedPaths.has(resolve(path)))) {
    throw archiveError("request_capture_archive_source_inventory_mismatch");
  }

  const sourceSnapshot = createHash("sha256");
  const sourcesToRemove: HotCaptureSource[] = [];
  let alreadyMissingCount = 0;
  let reclaimableBytes = 0;
  for (const { locator, log, path } of archiveSources) {
    if (!existsSync(path)) {
      alreadyMissingCount += 1;
      updateSourceSnapshotFields(sourceSnapshot, log.startedAt, log.id, locator.recordLength, locator.recordSha256);
      continue;
    }
    const source = hotSource(log, path);
    const verifiedSource = verifyHotSource(source);
    updateSourceSnapshot(sourceSnapshot, verifiedSource);
    sourcesToRemove.push(source);
    reclaimableBytes = checkedArchiveBytes(reclaimableBytes, source.compressedBytes);
  }
  if (sourceSnapshot.digest("hex") !== verified.manifest.sourceSnapshotSha256) {
    throw archiveError("request_capture_archive_source_drift");
  }

  if (!input.execute) {
    return {
      archiveMonth: plan.archiveMonth,
      execute: false,
      eligibleCount: archiveSources.length,
      reclaimableBytes,
      removedCount: 0,
      removedBytes: 0,
      alreadyMissingCount,
      remainingEligibleCount: sourcesToRemove.length,
    };
  }

  let removedCount = 0;
  let removedBytes = 0;
  for (let offset = 0; offset < sourcesToRemove.length; offset += input.config.requestCapture.archive.purgeBatchSize) {
    for (const source of sourcesToRemove.slice(offset, offset + input.config.requestCapture.archive.purgeBatchSize)) {
      assertHotSourceUnchanged(source);
      try {
        await fs.unlink(source.path);
        removedCount += 1;
        removedBytes = checkedArchiveBytes(removedBytes, source.compressedBytes);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        alreadyMissingCount += 1;
      }
    }
  }
  return {
    archiveMonth: plan.archiveMonth,
    execute: true,
    eligibleCount: archiveSources.length,
    reclaimableBytes,
    removedCount,
    removedBytes,
    alreadyMissingCount,
    remainingEligibleCount: Math.max(0, archiveSources.length - removedCount - alreadyMissingCount),
  };
}

export function listConfiguredRequestCaptureArchiveMonths(config: AppConfig): string[] {
  const root = requiredColdDirectory(config);
  const coldRoot = join(root, "cold", "v3");
  if (!existsSync(coldRoot)) return [];
  const months: string[] = [];
  for (const year of readdirSync(coldRoot, { withFileTypes: true })) {
    if (!year.isDirectory() || !/^year=\d{4}$/.test(year.name)) continue;
    for (const month of readdirSync(join(coldRoot, year.name), { withFileTypes: true })) {
      if (!month.isDirectory() || !/^month=\d{2}$/.test(month.name)) continue;
      const value = `${year.name.slice(5)}-${month.name.slice(6)}`;
      if (existsSync(resolve(root, captureManifestObjectKey(value)))) months.push(value);
    }
  }
  return months.sort();
}

export class RequestCaptureMonthlyArchiveReader {
  readonly root: string;
  readonly hotRoot: string | null;
  readonly requireMount: boolean;
  readonly remote: ArchiveRemote;

  constructor(coldDirectory: string, options: { hotDirectory?: string; requireMount?: boolean } = {}) {
    this.root = resolve(coldDirectory);
    this.hotRoot = options.hotDirectory ? resolve(options.hotDirectory) : null;
    this.requireMount = options.requireMount ?? false;
    this.remote = new FilesystemArchiveRemote(this.root, { createRoot: false, enforcePrivateObjects: true });
  }

  async query(input: RequestCaptureArchiveQueryInput): Promise<RequestCaptureArchiveQueryRow[]> {
    assertColdReaderRoot(this.root, this.hotRoot, this.requireMount);
    return queryRequestCaptureMonthlyArchivesWithFallback(this.remote, input);
  }

  async readRawRecord(startedAt: string, requestId: string): Promise<Buffer | null> {
    const month = startedAt.slice(0, 7);
    assertArchiveMonth(month);
    assertColdReaderRoot(this.root, this.hotRoot, this.requireMount);
    return readRequestCaptureArchiveRecordByRequestId({ remote: this.remote, month, requestId });
  }

  async readExchange(startedAt: string, requestId: string) {
    const raw = await this.readRawRecord(startedAt, requestId);
    return raw ? decodeRequestCaptureV3Record(parseRequestCaptureV3Jsonl(raw)) : null;
  }

  async readCompressedRecord(startedAt: string, requestId: string): Promise<Buffer | null> {
    const raw = await this.readRawRecord(startedAt, requestId);
    return raw
      ? zstdCompressSync(raw, { params: { [zlibConstants.ZSTD_c_compressionLevel]: REQUEST_CAPTURE_V3_ZSTD_LEVEL } })
      : null;
  }
}

async function stageRequestCaptureMonth(input: {
  plan: RequestCaptureMonthlyArchivePlan;
  sources: HotCaptureSource[];
  stagingDirectory: string;
  createdAt: string;
  frameUncompressedBytes: number;
  zstdLevel: number;
  onProgress?: (progress: RequestCaptureMonthlyArchiveProgressValues) => void | Promise<void>;
}): Promise<StagedCaptureMonth> {
  const packPath = join(input.stagingDirectory, "captures-pack-v3.zstpack");
  const catalogPath = join(input.stagingDirectory, "captures-catalog-v1.parquet");
  const handle = await fs.open(packPath, "wx", 0o600);
  const sourceSnapshot = createHash("sha256");
  const packHash = createHash("sha256");
  const catalogRows: RequestCaptureArchiveCatalogRow[] = [];
  let packBytes = 0;
  let uncompressedBytes = 0;
  let frameCount = 0;
  let frameSources: VerifiedHotCaptureSource[] = [];
  let frameRawBytes = 0;
  let processedRecords = 0;
  let processedSourceCompressedBytes = 0;
  let lastProgressAtMs = 0;
  const sourceCompressedBytesTotal = input.sources.reduce((sum, source) => sum + source.compressedBytes, 0);

  const writePackBytes = async (bytes: Buffer): Promise<void> => {
    await writeFully(handle, bytes);
    packHash.update(bytes);
    packBytes += bytes.length;
  };
  const flushFrame = async (): Promise<void> => {
    if (frameSources.length === 0) return;
    const frameOffset = packBytes;
    const raw = Buffer.concat(frameSources.map((source) => source.raw), frameRawBytes);
    const compressed = zstdCompressSync(raw, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: input.zstdLevel },
    });
    if (compressed.length > MAX_PACK_FRAME_COMPRESSED_BYTES) throw archiveError("request_capture_archive_pack_frame_too_large");
    const header = encodeFrameHeader(compressed, raw, frameSources.length);
    const frameSha256 = sha256Hex(Buffer.concat([header, compressed], header.length + compressed.length));
    await writePackBytes(header);
    await writePackBytes(compressed);
    const frameLength = header.length + compressed.length;
    let recordOffset = 0;
    for (const source of frameSources) {
      catalogRows.push({
        requestId: source.log.id,
        startedAt: source.log.startedAt,
        endedAt: source.log.endedAt as string,
        status: source.log.status as "completed" | "failed",
        userId: source.log.userId,
        teamId: source.log.teamId,
        apiKeyId: source.log.apiKeyId,
        requestPath: normalizeRequestPath(source.log.requestPath),
        requestModel: source.log.reqModel,
        packObjectKey: "pending",
        frameOffset,
        frameLength,
        frameUncompressedLength: raw.length,
        frameSha256,
        recordOffset,
        recordLength: source.raw.length,
        recordSha256: source.rawSha256,
        captureSchemaVersion: source.record.schemaVersion,
      });
      recordOffset += source.raw.length;
    }
    frameCount += 1;
    frameSources = [];
    frameRawBytes = 0;
  };

  try {
    await writePackBytes(PACK_MAGIC);
    for (const sourceInput of input.sources) {
      const source = verifyHotSource(sourceInput);
      if (source.raw.length > input.frameUncompressedBytes) throw archiveError("request_capture_archive_record_exceeds_frame_limit");
      updateSourceSnapshot(sourceSnapshot, source);
      if (frameSources.length > 0 && frameRawBytes + source.raw.length > input.frameUncompressedBytes) await flushFrame();
      frameSources.push(source);
      frameRawBytes += source.raw.length;
      uncompressedBytes += source.raw.length;
      processedRecords += 1;
      processedSourceCompressedBytes += sourceInput.compressedBytes;
      const nowMs = Date.now();
      if (processedRecords === input.sources.length || processedRecords % 1_000 === 0 || nowMs - lastProgressAtMs >= 15_000) {
        lastProgressAtMs = nowMs;
        await input.onProgress?.({
          recordsProcessed: processedRecords,
          recordsTotal: input.sources.length,
          sourceCompressedBytesProcessed: processedSourceCompressedBytes,
          sourceCompressedBytesTotal,
          framesCompleted: frameCount,
          compressedBytes: packBytes,
        });
      }
    }
    await flushFrame();
    await input.onProgress?.({
      recordsProcessed: processedRecords,
      recordsTotal: input.sources.length,
      sourceCompressedBytesProcessed: processedSourceCompressedBytes,
      sourceCompressedBytesTotal,
      framesCompleted: frameCount,
      compressedBytes: packBytes,
    });
    await handle.sync();
  } finally {
    await handle.close();
  }

  const packSha256 = packHash.digest("hex");
  const packObjectKey = capturePackObjectKey(input.plan.archiveMonth, packSha256);
  for (const row of catalogRows) row.packObjectKey = packObjectKey;
  const catalogCount = await writeRequestCaptureArchiveCatalog(catalogPath, catalogRows);
  if (catalogCount !== input.sources.length) throw archiveError("request_capture_archive_catalog_row_count_mismatch");
  await fs.chmod(catalogPath, 0o600);
  const [catalogStat, catalogSha256] = await Promise.all([fs.stat(catalogPath), sha256File(catalogPath)]);
  const manifest: RequestCaptureMonthlyArchiveManifestV3 = {
    manifestVersion: 3,
    archiveFormatVersion: 3,
    catalogSchemaVersion: REQUEST_CAPTURE_ARCHIVE_CATALOG_SCHEMA_VERSION,
    kind: "request-capture-month",
    archiveMonth: input.plan.archiveMonth,
    cutoffGte: input.plan.cutoff.gte,
    cutoffLt: input.plan.cutoff.lt,
    sourceSnapshotSha256: sourceSnapshot.digest("hex"),
    recordCount: input.sources.length,
    frameCount,
    frameUncompressedBytes: input.frameUncompressedBytes,
    uncompressedBytes,
    compressedBytes: packBytes,
    catalog: {
      objectKey: captureCatalogObjectKey(input.plan.archiveMonth, catalogSha256),
      bytes: catalogStat.size,
      sha256: catalogSha256,
    },
    pack: { objectKey: packObjectKey, bytes: packBytes, sha256: packSha256 },
    createdAt: input.createdAt,
    verifierVersion: REQUEST_CAPTURE_MONTHLY_VERIFIER_VERSION,
  };
  await fs.writeFile(join(input.stagingDirectory, "captures-manifest-v3.json"), manifestBytes(manifest), { flag: "wx", mode: 0o600 });
  return { manifest, packPath, catalogPath };
}

async function collectHotSources(
  repository: ArchiveSourcePort,
  storage: RequestCaptureV3Storage,
  plan: RequestCaptureMonthlyArchivePlan,
  onPage?: (recordsProcessed: number) => void | Promise<void>,
): Promise<HotCaptureSource[]> {
  const logs = await listMonthRequestLogs(repository, plan.cutoff.gte, plan.cutoff.lt);
  if (logs.some((log) => log.endedAt === null || !["completed", "failed"].includes(log.status))) {
    throw archiveError("request_capture_archive_month_not_terminal");
  }
  const logsById = requestLogsById(logs);
  const actualPaths = listMonthHotCaptureFiles(storage.config.archiveDirectory, plan.archiveMonth);
  const sources = actualPaths.map((path) => {
    const requestId = basename(path, ".jsonl.zst");
    const log = logsById.get(requestId);
    if (!log || resolve(storage.pathForRequest(log.startedAt, log.id)) !== resolve(path)) {
      throw archiveError("request_capture_archive_source_inventory_mismatch");
    }
    return hotSource(log, path);
  }).sort((left, right) => left.log.startedAt.localeCompare(right.log.startedAt) || left.log.id.localeCompare(right.log.id));
  await onPage?.(sources.length);
  return sources;
}

function hotSource(log: RequestLog, path: string): HotCaptureSource {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw archiveError("request_capture_archive_source_not_file");
  assertPrivateMode(stat.mode, 0o600, "request_capture_file_permissions_invalid");
  return { log, path, compressedBytes: stat.size, mtimeMs: stat.mtimeMs };
}

async function listMonthRequestLogs(
  repository: ArchiveSourcePort,
  cutoffGte: string,
  cutoffLt: string,
  onPage?: (recordsProcessed: number) => void | Promise<void>,
): Promise<RequestLog[]> {
  const rows: RequestLog[] = [];
  const startedAtLte = new Date(Date.parse(cutoffLt) - 1).toISOString();
  for (let offset = 0; ; offset += REQUEST_LOG_PAGE_SIZE) {
    const page = await repository.listRecentRequestLogs({ startedAtGte: cutoffGte, startedAtLte }, REQUEST_LOG_PAGE_SIZE, offset);
    rows.push(...page);
    await onPage?.(rows.length);
    if (page.length < REQUEST_LOG_PAGE_SIZE) break;
  }
  return rows.sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
}

function verifyHotSource(source: HotCaptureSource): VerifiedHotCaptureSource {
  const stat = lstatSync(source.path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw archiveError("request_capture_archive_source_not_file");
  assertPrivateMode(stat.mode, 0o600, "request_capture_file_permissions_invalid");
  if (stat.size !== source.compressedBytes || stat.mtimeMs !== source.mtimeMs || stat.size > REQUEST_CAPTURE_V3_MAX_COMPRESSED_BYTES) {
    throw archiveError("request_capture_archive_source_drift");
  }
  const compressed = readFileSync(source.path);
  let raw: Buffer;
  try { raw = zstdDecompressSync(compressed); }
  catch { throw archiveError("request_capture_archive_source_invalid"); }
  if (raw.length > REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES) throw archiveError("request_capture_archive_source_too_large");
  const record = parseRequestCaptureV3Jsonl(raw);
  if (
    record.requestId !== source.log.id
    || record.ownership.userId !== source.log.userId
    || !captureTeamIdentityMatchesRequestLog(record.ownership.teamId, source.log.teamId)
    || record.ownership.apiKeyId !== source.log.apiKeyId
    || record.model !== source.log.reqModel
  ) {
    throw archiveError("request_capture_archive_source_request_mismatch");
  }
  return { ...source, record, raw, rawSha256: sha256Hex(raw) };
}

function assertHotSourceUnchanged(source: HotCaptureSource): void {
  const stat = lstatSync(source.path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw archiveError("request_capture_archive_source_not_file");
  assertPrivateMode(stat.mode, 0o600, "request_capture_file_permissions_invalid");
  if (stat.size !== source.compressedBytes || stat.mtimeMs !== source.mtimeMs) {
    throw archiveError("request_capture_archive_source_drift");
  }
}

function captureTeamIdentityMatchesRequestLog(capturedTeamId: string | null, requestLogTeamId: string | null): boolean {
  return capturedTeamId === requestLogTeamId
    || (capturedTeamId === null && requestLogTeamId !== null);
}

async function assertCurrentHotFilesCovered(
  repository: ArchiveSourcePort,
  storage: RequestCaptureV3Storage,
  remote: ArchiveRemote,
  manifest: RequestCaptureMonthlyArchiveManifestV3,
  hotDays: number,
  now: Date,
): Promise<void> {
  const logs = await listMonthRequestLogs(repository, manifest.cutoffGte, manifest.cutoffLt);
  if (logs.some((log) => log.endedAt === null || !["completed", "failed"].includes(log.status))) {
    throw archiveError("request_capture_archive_month_not_terminal");
  }
  const logsById = requestLogsById(logs);
  const rows = sortCatalogRows(await queryRequestCaptureMonthlyArchives(remote, {
    months: [manifest.archiveMonth],
    filter: { startedAtGte: manifest.cutoffGte, startedAtLt: manifest.cutoffLt },
    scope: { kind: "platform_owner" },
  }));
  if (rows.length !== manifest.recordCount) throw archiveError("request_capture_archive_source_inventory_mismatch");
  const archiveSources = rows.map((locator) => {
    const log = logsById.get(locator.requestId);
    if (!log || !catalogMatchesLog(locator, log)) {
      throw archiveError("request_capture_archive_source_inventory_mismatch");
    }
    return { locator, log, path: storage.pathForRequest(log.startedAt, log.id) };
  });
  const expectedPaths = new Set(archiveSources.map((source) => resolve(source.path)));
  const actualPaths = listMonthHotCaptureFiles(storage.config.archiveDirectory, manifest.archiveMonth);
  if (actualPaths.some((path) => !expectedPaths.has(resolve(path)))) {
    throw archiveError("request_capture_archive_source_inventory_mismatch");
  }
  const cutoff = new Date(now.getTime() - hotDays * 86_400_000).toISOString();
  const sourceSnapshot = createHash("sha256");
  for (const { locator, log, path } of archiveSources) {
    if (!existsSync(path)) {
      if (log.startedAt >= cutoff) throw archiveError("request_capture_archive_noneligible_source_missing");
      updateSourceSnapshotFields(sourceSnapshot, log.startedAt, log.id, locator.recordLength, locator.recordSha256);
      continue;
    }
    updateSourceSnapshot(sourceSnapshot, verifyHotSource(hotSource(log, path)));
  }
  if (sourceSnapshot.digest("hex") !== manifest.sourceSnapshotSha256) {
    throw archiveError("request_capture_archive_source_drift");
  }
}

export function parseRequestCaptureMonthlyArchiveManifest(value: string | unknown): RequestCaptureMonthlyArchiveManifestV3 {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch { throw archiveError("request_capture_archive_manifest_invalid"); }
  }
  const row = strictObject(parsed, [
    "manifestVersion", "archiveFormatVersion", "catalogSchemaVersion", "kind", "archiveMonth", "cutoffGte", "cutoffLt",
    "sourceSnapshotSha256", "recordCount", "frameCount", "frameUncompressedBytes", "uncompressedBytes", "compressedBytes", "catalog", "pack",
    "createdAt", "verifierVersion",
  ]);
  if (
    row.manifestVersion !== 3
    || row.archiveFormatVersion !== 3
    || row.catalogSchemaVersion !== REQUEST_CAPTURE_ARCHIVE_CATALOG_SCHEMA_VERSION
    || row.kind !== "request-capture-month"
    || row.verifierVersion !== REQUEST_CAPTURE_MONTHLY_VERIFIER_VERSION
  ) {
    throw archiveError("request_capture_archive_manifest_version_invalid");
  }
  const archiveMonth = requiredString(row.archiveMonth);
  const plan = planRequestCaptureArchiveMonth(archiveMonth, new Date(`${nextMonth(archiveMonth)}-02T00:00:00.000Z`));
  if (row.cutoffGte !== plan.cutoff.gte || row.cutoffLt !== plan.cutoff.lt) throw archiveError("request_capture_archive_manifest_cutoff_invalid");
  const catalog = archiveObject(row.catalog);
  const pack = archiveObject(row.pack);
  if (catalog.objectKey !== captureCatalogObjectKey(archiveMonth, catalog.sha256)
    || pack.objectKey !== capturePackObjectKey(archiveMonth, pack.sha256)) {
    throw archiveError("request_capture_archive_manifest_key_invalid");
  }
  const manifest: RequestCaptureMonthlyArchiveManifestV3 = {
    manifestVersion: 3,
    archiveFormatVersion: 3,
    catalogSchemaVersion: REQUEST_CAPTURE_ARCHIVE_CATALOG_SCHEMA_VERSION,
    kind: "request-capture-month",
    archiveMonth,
    cutoffGte: requiredTimestamp(row.cutoffGte),
    cutoffLt: requiredTimestamp(row.cutoffLt),
    sourceSnapshotSha256: requiredSha256(row.sourceSnapshotSha256),
    recordCount: nonNegativeInteger(row.recordCount),
    frameCount: nonNegativeInteger(row.frameCount),
    frameUncompressedBytes: positiveInteger(row.frameUncompressedBytes),
    uncompressedBytes: nonNegativeInteger(row.uncompressedBytes),
    compressedBytes: nonNegativeInteger(row.compressedBytes),
    catalog,
    pack,
    createdAt: requiredTimestamp(row.createdAt),
    verifierVersion: REQUEST_CAPTURE_MONTHLY_VERIFIER_VERSION,
  };
  if (manifest.pack.bytes !== manifest.compressedBytes) throw archiveError("request_capture_archive_manifest_size_invalid");
  if ((manifest.recordCount === 0) !== (manifest.frameCount === 0)) throw archiveError("request_capture_archive_manifest_count_invalid");
  return manifest;
}

export function parseRequestCaptureMonthlyArchiveManifestV2(value: string | unknown): RequestCaptureMonthlyArchiveManifestV2 {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch { throw archiveError("request_capture_archive_manifest_invalid"); }
  }
  const row = strictObject(parsed, [
    "manifestVersion", "archiveFormatVersion", "kind", "archiveMonth", "cutoffGte", "cutoffLt",
    "sourceSnapshotSha256", "recordCount", "frameCount", "uncompressedBytes", "compressedBytes", "pack",
    "createdAt", "verifierVersion",
  ]);
  if (
    row.manifestVersion !== 2
    || row.archiveFormatVersion !== 2
    || row.kind !== "request-capture-month"
    || row.verifierVersion !== "capture-monthly-v2"
  ) {
    throw archiveError("request_capture_archive_manifest_version_invalid");
  }
  const archiveMonth = requiredString(row.archiveMonth);
  const plan = planRequestCaptureArchiveMonth(archiveMonth, new Date(`${nextMonth(archiveMonth)}-02T00:00:00.000Z`));
  if (row.cutoffGte !== plan.cutoff.gte || row.cutoffLt !== plan.cutoff.lt) {
    throw archiveError("request_capture_archive_manifest_cutoff_invalid");
  }
  const pack = archiveObject(row.pack);
  if (pack.objectKey !== legacyCapturePackObjectKey(archiveMonth, pack.sha256)) {
    throw archiveError("request_capture_archive_manifest_key_invalid");
  }
  const manifest: RequestCaptureMonthlyArchiveManifestV2 = {
    manifestVersion: 2,
    archiveFormatVersion: 2,
    kind: "request-capture-month",
    archiveMonth,
    cutoffGte: requiredTimestamp(row.cutoffGte),
    cutoffLt: requiredTimestamp(row.cutoffLt),
    sourceSnapshotSha256: requiredSha256(row.sourceSnapshotSha256),
    recordCount: nonNegativeInteger(row.recordCount),
    frameCount: nonNegativeInteger(row.frameCount),
    uncompressedBytes: nonNegativeInteger(row.uncompressedBytes),
    compressedBytes: nonNegativeInteger(row.compressedBytes),
    pack,
    createdAt: requiredTimestamp(row.createdAt),
    verifierVersion: "capture-monthly-v2",
  };
  if (manifest.pack.bytes !== manifest.compressedBytes) throw archiveError("request_capture_archive_manifest_size_invalid");
  if ((manifest.recordCount === 0) !== (manifest.frameCount === 0)) throw archiveError("request_capture_archive_manifest_count_invalid");
  return manifest;
}

export async function readRequestCaptureArchiveManifest(
  remote: ArchiveRemote,
  month: string,
): Promise<RequestCaptureMonthlyArchiveManifestV3> {
  return readRemoteManifest(remote, month);
}

function captureStorage(config: AppConfig): RequestCaptureV3Storage {
  return new RequestCaptureV3Storage({
    archiveDirectory: config.archive.directory,
    ...(config.archive.coldDirectory ? { coldDirectory: config.archive.coldDirectory } : {}),
    requireColdMount: config.archive.requireColdMount,
    hotDays: config.requestCapture.hotDays,
  });
}

function requiredColdDirectory(config: AppConfig): string {
  if (!config.archive.coldDirectory) throw archiveError("request_capture_archive_cold_directory_required");
  return resolve(config.archive.coldDirectory);
}

function captureObjectPrefix(month: string): string {
  const [year, value] = month.split("-");
  return `cold/v3/year=${year}/month=${value}/capture`;
}

function legacyCaptureObjectPrefix(month: string): string {
  const [year, value] = month.split("-");
  return `cold/v2/year=${year}/month=${value}/capture`;
}

export function captureManifestObjectKey(month: string): string {
  assertArchiveMonth(month);
  return `${captureObjectPrefix(month)}/captures-manifest-v3.json`;
}

function capturePackObjectKey(month: string, sha256: string): string {
  return `${captureObjectPrefix(month)}/captures-pack-v3-${requiredSha256(sha256)}.zstpack`;
}

function captureCatalogObjectKey(month: string, sha256: string): string {
  return `${captureObjectPrefix(month)}/captures-catalog-v1-${requiredSha256(sha256)}.parquet`;
}

function legacyCaptureManifestObjectKey(month: string): string {
  assertArchiveMonth(month);
  return `${legacyCaptureObjectPrefix(month)}/captures-manifest-v2.json`;
}

function legacyCapturePackObjectKey(month: string, sha256: string): string {
  return `${legacyCaptureObjectPrefix(month)}/captures-v3-${requiredSha256(sha256)}.zstpack`;
}

async function reportArchiveProgress(
  reporter: RequestCaptureMonthlyArchiveProgressReporter | undefined,
  progress: RequestCaptureMonthlyArchiveProgress,
): Promise<void> {
  if (!reporter) return;
  try {
    await reporter(progress);
  } catch {
    // Observability must never change archive correctness or cleanup behavior.
  }
}

function archiveProgressFromManifest(
  manifest: RequestCaptureMonthlyArchiveManifestV3,
  sourceCompressedBytesTotal: number,
): RequestCaptureMonthlyArchiveProgressValues {
  return {
    recordsProcessed: manifest.recordCount,
    recordsTotal: manifest.recordCount,
    sourceCompressedBytesProcessed: sourceCompressedBytesTotal,
    sourceCompressedBytesTotal,
    framesCompleted: manifest.frameCount,
    compressedBytes: manifest.compressedBytes,
  };
}

function archiveResult(
  manifest: RequestCaptureMonthlyArchiveManifestV3,
  idempotent: boolean,
  localOnly: boolean,
  capacity: RequestCaptureMonthlyArchiveCapacity,
): RequestCaptureMonthlyArchiveRunResult {
  return {
    archiveMonth: manifest.archiveMonth,
    recordCount: manifest.recordCount,
    frameCount: manifest.frameCount,
    uncompressedBytes: manifest.uncompressedBytes,
    compressedBytes: manifest.compressedBytes,
    sourceSnapshotSha256: manifest.sourceSnapshotSha256,
    idempotent,
    localOnly,
    capacity,
  };
}

function inspectStagingBundleUpperBound(
  sources: HotCaptureSource[],
  frameUncompressedBytes: number,
): number {
  let frameBytes = 0;
  let packUpperBound = PACK_MAGIC.length;
  let catalogUpperBound = STAGING_CATALOG_BASE_BYTES;
  const flushFrame = (): void => {
    if (frameBytes === 0) return;
    packUpperBound = checkedArchiveBytes(packUpperBound, PACK_FRAME_HEADER_BYTES + zstdCompressBound(frameBytes));
    frameBytes = 0;
  };
  for (const source of sources) {
    const verified = verifyHotSource(source);
    if (verified.raw.length > frameUncompressedBytes) throw archiveError("request_capture_archive_record_exceeds_frame_limit");
    if (frameBytes > 0 && frameBytes + verified.raw.length > frameUncompressedBytes) flushFrame();
    frameBytes = checkedArchiveBytes(frameBytes, verified.raw.length);
    const metadataBytes = [
      verified.log.id,
      verified.log.startedAt,
      verified.log.endedAt ?? "",
      verified.log.userId,
      verified.log.teamId ?? "",
      verified.log.apiKeyId,
      verified.log.requestPath ?? "",
      verified.log.reqModel,
    ].reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0);
    catalogUpperBound = checkedArchiveBytes(
      catalogUpperBound,
      Math.max(STAGING_CATALOG_MINIMUM_ROW_BYTES, (metadataBytes + 512) * 4),
    );
  }
  flushFrame();
  const manifestAndFilesystemOverhead = 64 * 1024;
  const bundleUpperBound = checkedArchiveBytes(
    checkedArchiveBytes(packUpperBound, catalogUpperBound),
    manifestAndFilesystemOverhead,
  );
  return bundleUpperBound;
}

function zstdCompressBound(sourceBytes: number): number {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) throw archiveError("request_capture_archive_capacity_invalid");
  const smallBlockAllowance = sourceBytes < 128 * 1024 ? ((128 * 1024 - sourceBytes) >> 11) : 0;
  return checkedArchiveBytes(sourceBytes, (sourceBytes >> 8) + smallBlockAllowance);
}

function checkedArchiveBytes(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw archiveError("request_capture_archive_capacity_invalid");
  return value;
}

async function filesystemAvailableBytes(path: string): Promise<number> {
  const filesystem = await fs.statfs(path);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) throw archiveError("request_capture_archive_capacity_invalid");
  return availableBytes;
}

function stableArchiveFailureCode(error: unknown): string {
  const code = errorCode(error);
  return code && /^[a-z0-9_]+$/u.test(code) ? code : "request_capture_archive_month_failed";
}

function sourceSnapshotSha256FromHotSources(sources: HotCaptureSource[]): string {
  const hash = createHash("sha256");
  for (const source of sources) updateSourceSnapshot(hash, verifyHotSource(source));
  return hash.digest("hex");
}

function updateSourceSnapshot(hash: ReturnType<typeof createHash>, source: VerifiedHotCaptureSource): void {
  updateSourceSnapshotFields(hash, source.log.startedAt, source.log.id, source.raw.length, source.rawSha256);
}

function updateSourceSnapshotFields(
  hash: ReturnType<typeof createHash>,
  startedAt: string,
  requestId: string,
  rawBytes: number,
  rawSha256: string,
): void {
  hash.update(`${startedAt}\0${requestId}\0${rawBytes}\0${rawSha256}\n`, "utf8");
}

function encodeFrameHeader(compressed: Buffer, raw: Buffer, recordCount: number): Buffer {
  const header = Buffer.alloc(PACK_FRAME_HEADER_BYTES);
  header.writeUInt32BE(compressed.length, 0);
  header.writeUInt32BE(raw.length, 4);
  header.writeUInt32BE(recordCount, 8);
  Buffer.from(sha256Hex(compressed), "hex").copy(header, 12);
  Buffer.from(sha256Hex(raw), "hex").copy(header, 44);
  return header;
}

function decodeFrame(frameBytes: Buffer, expectedLength: number): DecodedFrame {
  if (frameBytes.length !== expectedLength || frameBytes.length <= PACK_FRAME_HEADER_BYTES) {
    throw archiveError("request_capture_archive_pack_frame_invalid");
  }
  const header = frameBytes.subarray(0, PACK_FRAME_HEADER_BYTES);
  const compressedLength = header.readUInt32BE(0);
  const rawLength = header.readUInt32BE(4);
  const recordCount = header.readUInt32BE(8);
  const compressedSha256 = header.subarray(12, 44).toString("hex");
  const rawSha256 = header.subarray(44, 76).toString("hex");
  if (
    compressedLength < 1
    || compressedLength > MAX_PACK_FRAME_COMPRESSED_BYTES
    || rawLength < 1
    || rawLength > REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES
    || recordCount < 1
    || PACK_FRAME_HEADER_BYTES + compressedLength !== frameBytes.length
  ) {
    throw archiveError("request_capture_archive_pack_frame_invalid");
  }
  const compressed = frameBytes.subarray(PACK_FRAME_HEADER_BYTES);
  if (sha256Hex(compressed) !== compressedSha256) throw archiveError("request_capture_archive_pack_frame_invalid");
  let raw: Buffer;
  try { raw = zstdDecompressSync(compressed); }
  catch { throw archiveError("request_capture_archive_pack_frame_invalid"); }
  if (raw.length !== rawLength || sha256Hex(raw) !== rawSha256) throw archiveError("request_capture_archive_pack_frame_invalid");
  return { raw, compressedLength, rawLength, recordCount, frameSha256: sha256Hex(frameBytes) };
}

async function queryPackWithoutCatalog(
  remote: ArchiveRemote,
  manifest: PackScanManifest,
  filter: RequestCaptureArchiveCatalogFilter,
  scope: RequestCaptureArchiveQueryScope,
): Promise<RequestCaptureArchivePackScanRow[]> {
  assertPackScanQuery(filter, scope);
  const scanned = await scanPackWithoutCatalog(remote, manifest, {
    rowFilter: (row) => packScanScopeAllows(scope, row) && packScanMatchesFilter(row, filter),
  });
  return scanned.rows;
}

async function scanPackWithoutCatalog(
  remote: ArchiveRemote,
  manifest: PackScanManifest,
  options: {
    targetRequestId?: string;
    rowFilter?: (row: RequestCaptureArchivePackScanRow) => boolean;
  } = {},
): Promise<{ rows: RequestCaptureArchivePackScanRow[]; matchedRaw: Buffer | null }> {
  await assertRemoteObject(remote, manifest.pack);
  const expectedMagic = manifest.archiveFormatVersion === 3 ? PACK_MAGIC : LEGACY_PACK_MAGIC;
  const magic = await remote.readRange(manifest.pack.objectKey, 0, expectedMagic.length);
  if (!magic.equals(expectedMagic)) throw archiveError("request_capture_archive_pack_version_invalid");
  const packHash = createHash("sha256").update(magic);
  const ids = new Set<string>();
  const rows: RequestCaptureArchivePackScanRow[] = [];
  let matchedRaw: Buffer | null = null;
  let offset = expectedMagic.length;
  let recordCount = 0;
  let frameCount = 0;
  let uncompressedBytes = 0;
  while (offset < manifest.pack.bytes) {
    const header = await remote.readRange(manifest.pack.objectKey, offset, PACK_FRAME_HEADER_BYTES);
    const compressedLength = header.readUInt32BE(0);
    const frameLength = PACK_FRAME_HEADER_BYTES + compressedLength;
    if (compressedLength < 1 || compressedLength > MAX_PACK_FRAME_COMPRESSED_BYTES || offset + frameLength > manifest.pack.bytes) {
      throw archiveError("request_capture_archive_pack_frame_invalid");
    }
    const compressed = await remote.readRange(
      manifest.pack.objectKey,
      offset + PACK_FRAME_HEADER_BYTES,
      compressedLength,
    );
    const frameBytes = Buffer.concat([header, compressed], frameLength);
    const frame = decodeFrame(frameBytes, frameLength);
    if (frame.rawLength > manifest.frameUncompressedBytes) throw archiveError("request_capture_archive_pack_frame_invalid");
    packHash.update(frameBytes);
    let frameRecordCount = 0;
    let recordOffset = 0;
    while (recordOffset < frame.raw.length) {
      const newline = frame.raw.indexOf(0x0a, recordOffset);
      if (newline === -1) throw archiveError("request_capture_archive_pack_frame_invalid");
      const recordLength = newline + 1 - recordOffset;
      const raw = frame.raw.subarray(recordOffset, newline + 1);
      const record = parseRequestCaptureV3Jsonl(raw);
      if (ids.has(record.requestId)) throw archiveError("request_capture_archive_duplicate_request_id");
      ids.add(record.requestId);
      const row: RequestCaptureArchivePackScanRow = {
        source: "pack_scan",
        archiveFormatVersion: manifest.archiveFormatVersion,
        archiveMonth: manifest.archiveMonth,
        requestId: record.requestId,
        capturedAt: record.request.capturedAt,
        responseCapturedAt: record.response?.capturedAt ?? null,
        responseStatus: record.response?.status ?? null,
        responseErrorCode: record.response?.errorCode ?? null,
        userId: record.ownership.userId,
        teamId: record.ownership.teamId,
        apiKeyId: record.ownership.apiKeyId,
        requestModel: record.model,
        packObjectKey: manifest.pack.objectKey,
        frameOffset: offset,
        frameLength,
        frameUncompressedLength: frame.rawLength,
        frameSha256: frame.frameSha256,
        recordOffset,
        recordLength,
        recordSha256: sha256Hex(raw),
        captureSchemaVersion: record.schemaVersion,
      };
      if (!options.rowFilter || options.rowFilter(row)) rows.push(row);
      recordCount += 1;
      frameRecordCount += 1;
      if (record.requestId === options.targetRequestId) {
        if (matchedRaw) throw archiveError("request_capture_archive_duplicate_request_id");
        matchedRaw = Buffer.from(raw);
      }
      recordOffset += recordLength;
    }
    if (frameRecordCount !== frame.recordCount) throw archiveError("request_capture_archive_pack_frame_invalid");
    frameCount += 1;
    uncompressedBytes += frame.rawLength;
    offset += frameLength;
  }
  if (
    offset !== manifest.pack.bytes
    || recordCount !== manifest.recordCount
    || frameCount !== manifest.frameCount
    || uncompressedBytes !== manifest.uncompressedBytes
    || packHash.digest("hex") !== manifest.pack.sha256
  ) {
    throw archiveError("request_capture_archive_pack_content_mismatch");
  }
  return { rows, matchedRaw };
}

function assertPackScanQuery(
  filter: RequestCaptureArchiveCatalogFilter,
  scope: RequestCaptureArchiveQueryScope,
): void {
  const supported = new Set(["requestId", "userId", "teamId", "apiKeyId", "requestModel"]);
  const present = Object.entries(filter).filter(([, value]) => value !== undefined);
  if (present.length === 0) throw archiveError("request_capture_archive_query_empty");
  if (present.some(([key]) => !supported.has(key))) {
    throw archiveError("request_capture_archive_pack_scan_filter_unavailable");
  }
  if (filter.requestId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/.test(filter.requestId)) {
    throw archiveError("request_capture_archive_query_value_invalid");
  }
  for (const value of [filter.userId, filter.apiKeyId, filter.requestModel]) {
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw archiveError("request_capture_archive_query_value_invalid");
    }
  }
  if (filter.teamId !== undefined && filter.teamId !== null && filter.teamId.length === 0) {
    throw archiveError("request_capture_archive_query_value_invalid");
  }
  if (scope.kind === "request" && filter.requestId !== scope.requestId) {
    throw archiveError("request_capture_archive_scope_unauthorized");
  }
  if (scope.kind === "user" && filter.userId !== undefined && filter.userId !== scope.userId) {
    throw archiveError("request_capture_archive_scope_unauthorized");
  }
}

function packScanScopeAllows(scope: RequestCaptureArchiveQueryScope, row: RequestCaptureArchivePackScanRow): boolean {
  if (scope.kind === "platform_owner") return true;
  if (scope.kind === "request") return row.requestId === scope.requestId;
  return row.userId === scope.userId;
}

function packScanMatchesFilter(row: RequestCaptureArchivePackScanRow, filter: RequestCaptureArchiveCatalogFilter): boolean {
  return (filter.requestId === undefined || row.requestId === filter.requestId)
    && (filter.userId === undefined || row.userId === filter.userId)
    && (filter.teamId === undefined || row.teamId === filter.teamId)
    && (filter.apiKeyId === undefined || row.apiKeyId === filter.apiKeyId)
    && (filter.requestModel === undefined || row.requestModel === filter.requestModel);
}

function queryRowTimestamp(row: RequestCaptureArchiveQueryRow): string {
  return row.source === "catalog" ? row.startedAt : row.capturedAt;
}

function packScanManifest(
  manifest: RequestCaptureMonthlyArchiveManifestV3 | RequestCaptureMonthlyArchiveManifestV2,
): PackScanManifest {
  return {
    archiveFormatVersion: manifest.archiveFormatVersion,
    archiveMonth: manifest.archiveMonth,
    recordCount: manifest.recordCount,
    frameCount: manifest.frameCount,
    uncompressedBytes: manifest.uncompressedBytes,
    frameUncompressedBytes: manifest.archiveFormatVersion === 3
      ? manifest.frameUncompressedBytes
      : REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES,
    pack: manifest.pack,
  };
}

function groupCatalogFrames(rows: RequestCaptureArchiveCatalogRow[]): Array<{
  offset: number;
  length: number;
  uncompressedLength: number;
  sha256: string;
  rows: RequestCaptureArchiveCatalogRow[];
}> {
  const frames = new Map<number, {
    offset: number;
    length: number;
    uncompressedLength: number;
    sha256: string;
    rows: RequestCaptureArchiveCatalogRow[];
  }>();
  for (const row of rows) {
    const existing = frames.get(row.frameOffset);
    if (existing) {
      if (existing.length !== row.frameLength || existing.uncompressedLength !== row.frameUncompressedLength || existing.sha256 !== row.frameSha256) {
        throw archiveError("request_capture_archive_catalog_frame_conflict");
      }
      existing.rows.push(row);
    } else {
      frames.set(row.frameOffset, {
        offset: row.frameOffset,
        length: row.frameLength,
        uncompressedLength: row.frameUncompressedLength,
        sha256: row.frameSha256,
        rows: [row],
      });
    }
  }
  return [...frames.values()].sort((left, right) => left.offset - right.offset);
}

function verifyFrameCatalogRecords(
  frame: DecodedFrame,
  rows: RequestCaptureArchiveCatalogRow[],
  sourceSnapshot?: ReturnType<typeof createHash>,
): void {
  const ordered = [...rows].sort((left, right) => left.recordOffset - right.recordOffset);
  if (ordered.length !== frame.recordCount) throw archiveError("request_capture_archive_catalog_frame_count_mismatch");
  let offset = 0;
  for (const row of ordered) {
    if (row.recordOffset !== offset || row.recordOffset + row.recordLength > frame.raw.length) {
      throw archiveError("request_capture_archive_locator_out_of_bounds");
    }
    const raw = frame.raw.subarray(row.recordOffset, row.recordOffset + row.recordLength);
    if (sha256Hex(raw) !== row.recordSha256) throw archiveError("request_capture_archive_record_hash_mismatch");
    const record = parseRequestCaptureV3Jsonl(raw);
    if (record.requestId !== row.requestId || record.schemaVersion !== row.captureSchemaVersion) {
      throw archiveError("request_capture_archive_record_mismatch");
    }
    if (sourceSnapshot) {
      updateSourceSnapshotFields(sourceSnapshot, row.startedAt, row.requestId, raw.length, row.recordSha256);
    }
    offset += row.recordLength;
  }
  if (offset !== frame.raw.length) throw archiveError("request_capture_archive_catalog_frame_coverage_invalid");
}

function assertLocatorForManifest(row: RequestCaptureArchiveCatalogRow, manifest: RequestCaptureMonthlyArchiveManifestV3): void {
  if (
    row.packObjectKey !== manifest.pack.objectKey
    || row.startedAt.slice(0, 7) !== manifest.archiveMonth
    || row.frameOffset < PACK_MAGIC.length
    || row.frameLength <= PACK_FRAME_HEADER_BYTES
    || row.frameOffset + row.frameLength > manifest.pack.bytes
    || row.frameUncompressedLength > manifest.frameUncompressedBytes
    || row.recordOffset < 0
    || row.recordLength < 1
    || row.recordOffset + row.recordLength > row.frameUncompressedLength
  ) {
    throw archiveError("request_capture_archive_locator_out_of_bounds");
  }
}

function requestLogsById(logs: readonly RequestLog[]): Map<string, RequestLog> {
  const byId = new Map<string, RequestLog>();
  for (const log of logs) {
    if (byId.has(log.id)) throw archiveError("request_capture_archive_source_inventory_mismatch");
    byId.set(log.id, log);
  }
  return byId;
}

function sortCatalogRows(rows: readonly RequestCaptureArchiveCatalogRow[]): RequestCaptureArchiveCatalogRow[] {
  return [...rows].sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.requestId.localeCompare(right.requestId));
}

function catalogMatchesLog(row: RequestCaptureArchiveCatalogRow, log: RequestLog): boolean {
  return row.startedAt === log.startedAt
    && row.endedAt === log.endedAt
    && row.status === log.status
    && row.userId === log.userId
    && row.teamId === log.teamId
    && row.apiKeyId === log.apiKeyId
    && row.requestPath === normalizeRequestPath(log.requestPath)
    && row.requestModel === log.reqModel;
}

function normalizeRequestPath(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return new URL(trimmed).pathname || "/";
  } catch { throw archiveError("request_capture_archive_request_path_invalid"); }
  const path = trimmed.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/")) throw archiveError("request_capture_archive_request_path_invalid");
  return path || "/";
}

async function writeFully(handle: Awaited<ReturnType<typeof fs.open>>, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten === 0) throw archiveError("request_capture_archive_pack_write_short");
    offset += bytesWritten;
  }
}

async function assertRemoteObject(remote: ArchiveRemote, object: RequestCaptureArchiveObject): Promise<void> {
  const head = await remote.head(object.objectKey);
  if (head.bytes !== object.bytes) throw archiveError("request_capture_archive_object_mismatch");
  if (head.sha256 !== null) {
    if (head.sha256 !== object.sha256) throw archiveError("request_capture_archive_object_mismatch");
    return;
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of await remote.openRead(object.objectKey)) {
    const value = Buffer.from(chunk as Uint8Array);
    hash.update(value);
    bytes += value.length;
  }
  if (bytes !== object.bytes || hash.digest("hex") !== object.sha256) throw archiveError("request_capture_archive_object_mismatch");
}

function readRemoteManifest(remote: ArchiveRemote, month: string): Promise<RequestCaptureMonthlyArchiveManifestV3> {
  return remote.read(captureManifestObjectKey(month)).then((bytes) => parseRequestCaptureMonthlyArchiveManifest(bytes.toString("utf8")));
}

function readLegacyRemoteManifest(remote: ArchiveRemote, month: string): Promise<RequestCaptureMonthlyArchiveManifestV2> {
  return remote.read(legacyCaptureManifestObjectKey(month))
    .then((bytes) => parseRequestCaptureMonthlyArchiveManifestV2(bytes.toString("utf8")));
}

async function readLegacyRemoteManifestIfPresent(
  remote: ArchiveRemote,
  month: string,
): Promise<RequestCaptureMonthlyArchiveManifestV2 | null> {
  try { return await readLegacyRemoteManifest(remote, month); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function readRemoteManifestIfPresent(
  remote: ArchiveRemote,
  month: string,
): Promise<RequestCaptureMonthlyArchiveManifestV3 | null> {
  try { return await readRemoteManifest(remote, month); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function manifestBytes(manifest: RequestCaptureMonthlyArchiveManifestV3): Buffer {
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

function listMonthHotCaptureFiles(archiveDirectory: string, month: string): string[] {
  const [year, value] = month.split("-");
  const root = join(resolve(archiveDirectory), "capture-v3", `year=${year}`, `month=${value}`);
  if (!existsSync(root)) return [];
  assertPrivateMode(statSync(root).mode, 0o700, "request_capture_directory_permissions_invalid");
  const files: string[] = [];
  for (const day of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!day.isDirectory() || !/^day=\d{2}$/.test(day.name)) throw archiveError("request_capture_archive_source_inventory_mismatch");
    const directory = join(root, day.name);
    assertPrivateMode(statSync(directory).mode, 0o700, "request_capture_directory_permissions_invalid");
    for (const file of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!file.isFile() || !file.name.endsWith(".jsonl.zst")) throw archiveError("request_capture_archive_source_inventory_mismatch");
      files.push(join(directory, file.name));
    }
  }
  return files;
}

function firstHotCaptureMonth(archiveDirectory: string): string | null {
  const root = join(resolve(archiveDirectory), "capture-v3");
  if (!existsSync(root)) return null;
  const months: string[] = [];
  for (const year of readdirSync(root, { withFileTypes: true })) {
    if (!year.isDirectory() || !/^year=\d{4}$/.test(year.name)) continue;
    for (const month of readdirSync(join(root, year.name), { withFileTypes: true })) {
      if (month.isDirectory() && /^month=\d{2}$/.test(month.name)) months.push(`${year.name.slice(5)}-${month.name.slice(6)}`);
    }
  }
  return months.sort()[0] ?? null;
}

function nextMonth(month: string): string {
  assertArchiveMonth(month);
  const value = new Date(`${month}-01T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString().slice(0, 7);
}

function assertArchiveMonth(value: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw archiveError("request_capture_archive_month_invalid");
}

function assertColdReaderRoot(root: string, hotRoot: string | null, requireMount: boolean): void {
  if (hotRoot && (root === hotRoot || root.startsWith(`${hotRoot}/`) || hotRoot.startsWith(`${root}/`))) {
    throw archiveError("archive_cold_hot_path_overlap");
  }
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat) throw archiveError("request_capture_archive_cold_mount_missing");
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw archiveError("request_capture_archive_cold_mount_invalid");
  assertPrivateMode(stat.mode, 0o700, "request_capture_archive_cold_mount_permissions_invalid");
  if (requireMount && stat.dev === statSync(dirname(root)).dev) throw archiveError("request_capture_archive_cold_mount_identity_invalid");
}

function assertPrivateMode(mode: number, maximum: number, code: string): void {
  if (((mode & 0o777) & ~maximum) !== 0) throw archiveError(code);
}

function strictObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw archiveError("request_capture_archive_manifest_invalid");
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw archiveError("request_capture_archive_manifest_invalid");
  }
  return row;
}

function archiveObject(value: unknown): RequestCaptureArchiveObject {
  const row = strictObject(value, ["objectKey", "bytes", "sha256"]);
  return { objectKey: requiredString(row.objectKey), bytes: nonNegativeInteger(row.bytes), sha256: requiredSha256(row.sha256) };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw archiveError("request_capture_archive_manifest_invalid");
  return value;
}

function requiredTimestamp(value: unknown): string {
  const timestamp = requiredString(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw archiveError("request_capture_archive_manifest_invalid");
  }
  return timestamp;
}

function requiredSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw archiveError("request_capture_archive_manifest_invalid");
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw archiveError("request_capture_archive_manifest_invalid");
  return value;
}

function positiveInteger(value: unknown): number {
  const result = nonNegativeInteger(value);
  if (result < 1 || result > REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES) throw archiveError("request_capture_archive_manifest_invalid");
  return result;
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally { await handle.close(); }
  return hash.digest("hex");
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function archiveError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
