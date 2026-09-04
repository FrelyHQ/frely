import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { constants as zlibConstants, createZstdCompress, createZstdDecompress, zstdCompressSync, zstdDecompress, zstdDecompressSync } from "node:zlib";
import { isSafeRequestId, RelayError } from "@frely/core";
import {
  encodeRequestCapture,
  encodeUnavailableRequestCapture,
  reconstructEffectiveCapture,
  toSafeJsonTree,
  type RequestCaptureEncoding,
  type RequestCapturePatchOperation,
  type RequestCaptureUnavailableReason
} from "./request-capture-codec.js";
import type { CapturedExchange, CapturedRequest, CapturedResponse } from "./request-captures.js";
import { RequestCaptureMonthlyArchiveReader } from "./request-capture-monthly-archive.js";
import {
  REQUEST_CAPTURE_V3_MAX_COMPRESSED_BYTES,
  REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES,
  REQUEST_CAPTURE_V3_STAGING_MAX_AGE_MS,
  REQUEST_CAPTURE_V3_ZSTD_LEVEL,
} from "./request-capture-v3-limits.js";

export const REQUEST_CAPTURE_V3_SCHEMA_VERSION = 3 as const;
export {
  REQUEST_CAPTURE_V3_MAX_COMPRESSED_BYTES,
  REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES,
  REQUEST_CAPTURE_V3_STAGING_MAX_AGE_MS,
  REQUEST_CAPTURE_V3_ZSTD_LEVEL,
} from "./request-capture-v3-limits.js";

const zstdDecompressAsync = promisify(zstdDecompress);

export interface RequestCaptureV3StorageConfig {
  archiveDirectory: string;
  coldDirectory?: string;
  requireColdMount?: boolean;
  hotDays?: number;
}

export interface RequestCaptureV3Record {
  schemaVersion: 3;
  captureId: string;
  requestId: string;
  ownership: {
    userId: string;
    apiKeyId: string;
    teamId: string | null;
  };
  kind: string;
  model: string;
  request: {
    capturedAt: string;
    original: {
      body: unknown;
      hash: { algorithm: RequestCaptureEncoding["originalHashAlgorithm"]; value: string };
    };
    effective: {
      representation: RequestCaptureEncoding["effectiveRepresentation"];
      patchFormat: RequestCaptureEncoding["effectivePatchFormat"];
      patch: RequestCapturePatchOperation[] | null;
      fullBody: unknown | null;
      hash: { algorithm: NonNullable<RequestCaptureEncoding["effectiveHashAlgorithm"]>; value: string } | null;
      unavailableReason: RequestCaptureUnavailableReason | null;
    };
  };
  response: {
    captureId: string;
    capturedAt: string;
    status: number;
    errorCode: string | null;
    body: unknown;
  } | null;
}

export interface RequestCaptureV3BaseInput {
  requestLogStartedAt: string;
  requestId: string;
  apiKeyId: string;
  userId: string;
  teamId: string | null;
  kind: string;
  reqModel: string;
  originalPayload: unknown;
  effectivePayload?: unknown;
  unavailableReason?: RequestCaptureUnavailableReason;
  requestCapturedAt?: string;
}

export interface WriteRequestCaptureV3ExchangeInput extends RequestCaptureV3BaseInput {
  response: {
    status: number;
    body: unknown;
    errorCode?: string | null;
    capturedAt?: string;
  };
}

export interface BeginRequestCaptureV3StreamInput extends RequestCaptureV3BaseInput {
  responseStatus: number;
}

export interface FinalizeRequestCaptureV3StreamInput {
  errorCode?: string | null;
  capturedAt?: string;
}

export interface RequestCaptureV3StreamWriter {
  appendEvent(event: unknown): Promise<void>;
  finalize(input?: FinalizeRequestCaptureV3StreamInput): Promise<void>;
  abort(): Promise<void>;
}

export interface RequestCaptureV3VerificationResult {
  archiveDate: string;
  recordCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
}

/**
 * REQ-GA-008 / REQ-MEMBER-009: the runtime Capture store is one immutable
 * schema-v3 JSONL+Zstandard file per terminal request exchange. Streaming
 * responses use a private, non-queryable staging file and atomically publish
 * the canonical path only after the terminal suffix is durable.
 */
export class RequestCaptureV3Storage {
  private readonly coldReader: RequestCaptureMonthlyArchiveReader | null;

  constructor(readonly config: RequestCaptureV3StorageConfig) {
    this.coldReader = config.coldDirectory
      ? new RequestCaptureMonthlyArchiveReader(config.coldDirectory, {
        hotDirectory: config.archiveDirectory,
        ...(config.requireColdMount === undefined ? {} : { requireMount: config.requireColdMount })
      })
      : null;
  }

  writeExchange(input: WriteRequestCaptureV3ExchangeInput): CapturedExchange {
    const record = requestCaptureV3Record(input);
    return this.writeRecord(input.requestLogStartedAt, record);
  }

  writeRecord(requestLogStartedAt: string, recordInput: RequestCaptureV3Record): CapturedExchange {
    const record = parseRequestCaptureV3Record(recordInput);
    const raw = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (raw.length > REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES) {
      throw captureV3Error("request_capture_record_too_large", "Request Capture record exceeds the uncompressed byte limit", 413);
    }
    const compressed = zstdCompressSync(raw, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: REQUEST_CAPTURE_V3_ZSTD_LEVEL }
    });
    if (compressed.length > REQUEST_CAPTURE_V3_MAX_COMPRESSED_BYTES) {
      throw captureV3Error("request_capture_record_too_large", "Request Capture record exceeds the compressed byte limit", 413);
    }

    const path = this.pathForRequest(requestLogStartedAt, record.requestId);
    ensurePrivateDirectory(this.captureRoot());
    ensurePrivateDirectory(dirname(path));
    if (existsSync(path)) return this.assertIdempotentExisting(path, raw, record.requestId);

    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = openSync(path, "wx", 0o600);
      created = true;
      writeFileSync(descriptor, compressed);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(path, 0o600);
      const exchange = this.readHotExchange(requestLogStartedAt, record.requestId);
      if (!exchange) throw captureV3Error("request_capture_publish_verify_failed", "Request Capture publish verification failed", 503);
      const verifiedRaw = zstdDecompressSync(readFileSync(path));
      if (!verifiedRaw.equals(raw)) throw captureV3Error("request_capture_publish_verify_failed", "Request Capture publish verification failed", 503);
      return exchange;
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (created) rmSync(path, { force: true });
      if (isAlreadyExistsError(error)) return this.assertIdempotentExisting(path, raw, record.requestId);
      throw error;
    }
  }

  async beginStreamExchange(input: BeginRequestCaptureV3StreamInput): Promise<RequestCaptureV3StreamWriter> {
    const base = requestCaptureV3BaseRecord(input);
    const status = validResponseStatus(input.responseStatus);
    const finalPath = this.pathForRequest(input.requestLogStartedAt, input.requestId);
    const stagingRoot = this.stagingRoot();
    ensurePrivateDirectory(this.captureRoot());
    ensurePrivateDirectory(stagingRoot);
    ensurePrivateDirectory(dirname(finalPath));
    const stagingPath = join(
      stagingRoot,
      `${input.requestId}.${process.pid}.${randomUUID()}.jsonl.zst.partial`
    );
    const writer = new StreamingRequestCaptureV3Writer({
      base,
      status,
      finalPath,
      stagingPath
    });
    await writer.start();
    return writer;
  }

  cleanupAbandonedStreamCaptures(
    options: { olderThanMs?: number; nowMs?: number } = {}
  ): number {
    const stagingRoot = this.stagingRoot();
    if (!existsSync(stagingRoot)) return 0;
    assertPrivateMode(stagingRoot, 0o700, "request_capture_directory_permissions_invalid");
    const olderThanMs = options.olderThanMs ?? REQUEST_CAPTURE_V3_STAGING_MAX_AGE_MS;
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0 || !Number.isFinite(nowMs)) {
      throw new TypeError("Request Capture staging cleanup boundary is invalid");
    }
    let removed = 0;
    for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl.zst.partial")) continue;
      const path = join(stagingRoot, entry.name);
      const file = statSync(path);
      assertPrivateModeValue(file.mode, 0o600, "request_capture_file_permissions_invalid");
      if (nowMs - file.mtimeMs < olderThanMs) continue;
      rmSync(path, { force: true });
      removed += 1;
    }
    if (removed > 0) fsyncDirectory(stagingRoot);
    return removed;
  }

  private readHotExchange(requestLogStartedAt: string, requestId: string): CapturedExchange | null {
    const path = this.pathForRequest(requestLogStartedAt, requestId);
    if (!existsSync(path)) return null;
    assertPrivateMode(path, 0o600, "request_capture_file_permissions_invalid");
    const compressed = readFileSync(path);
    if (compressed.length > REQUEST_CAPTURE_V3_MAX_COMPRESSED_BYTES) throw integrityError();
    let raw: Buffer;
    try {
      raw = zstdDecompressSync(compressed);
    } catch {
      throw integrityError();
    }
    return decodeRequestCaptureV3Jsonl(raw, requestId);
  }

  async readExchangeAsync(requestLogStartedAt: string, requestId: string): Promise<CapturedExchange | null> {
    const path = this.pathForRequest(requestLogStartedAt, requestId);
    let compressed: Buffer;
    try {
      const fileStat = await stat(path);
      assertPrivateModeValue(fileStat.mode, 0o600, "request_capture_file_permissions_invalid");
      compressed = await readFile(path);
    } catch (error) {
      if (isNotFoundError(error)) return this.shouldReadCold(requestLogStartedAt) ? await this.coldReader?.readExchange(requestLogStartedAt, requestId) ?? null : null;
      throw error;
    }
    if (compressed.length > REQUEST_CAPTURE_V3_MAX_COMPRESSED_BYTES) throw integrityError();
    let raw: Buffer;
    try {
      raw = await zstdDecompressAsync(compressed);
    } catch {
      throw integrityError();
    }
    return decodeRequestCaptureV3Jsonl(raw, requestId);
  }

  hasStagingExchange(requestId: string): boolean {
    assertSafeRequestId(requestId);
    const root = this.stagingRoot();
    if (!existsSync(root)) return false;
    assertPrivateMode(root, 0o700, "request_capture_directory_permissions_invalid");
    const prefix = `${requestId}.`;
    return readdirSync(root, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".jsonl.zst.partial"));
  }

  async readCompressedCaptureBytes(requestLogStartedAt: string, requestId: string): Promise<{ bytes: Buffer; tier: "hot" | "cold" } | null> {
    const path = this.pathForRequest(requestLogStartedAt, requestId);
    try {
      const file = await stat(path);
      assertPrivateModeValue(file.mode, 0o600, "request_capture_file_permissions_invalid");
      if (!file.isFile() || file.size > REQUEST_CAPTURE_V3_MAX_COMPRESSED_BYTES) throw integrityError();
      return { bytes: await readFile(path), tier: "hot" };
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    if (!this.shouldReadCold(requestLogStartedAt)) return null;
    const bytes = await this.coldReader?.readCompressedRecord(requestLogStartedAt, requestId) ?? null;
    return bytes ? { bytes, tier: "cold" } : null;
  }

  private shouldReadCold(requestLogStartedAt: string): boolean {
    if (this.config.hotDays === undefined) return true;
    return Date.parse(requestLogStartedAt) < Date.now() - this.config.hotDays * 86_400_000;
  }

  pathForRequest(requestLogStartedAt: string, requestId: string): string {
    assertSafeRequestId(requestId);
    const archiveDate = utcDate(requestLogStartedAt);
    const [year, month, day] = archiveDate.split("-") as [string, string, string];
    return join(this.captureRoot(), `year=${year}`, `month=${month}`, `day=${day}`, `${requestId}.jsonl.zst`);
  }

  verifyDate(archiveDate: string): RequestCaptureV3VerificationResult {
    const [year, month, day] = assertArchiveDate(archiveDate);
    const directory = join(this.captureRoot(), `year=${year}`, `month=${month}`, `day=${day}`);
    if (!existsSync(directory)) return { archiveDate, recordCount: 0, compressedBytes: 0, uncompressedBytes: 0 };
    assertPrivateMode(directory, 0o700, "request_capture_directory_permissions_invalid");
    let recordCount = 0;
    let compressedBytes = 0;
    let uncompressedBytes = 0;
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith(".jsonl.zst")) throw captureV3Error("request_capture_v3_unexpected_file", "Unexpected file in Capture v3 day directory", 503);
      const requestId = name.slice(0, -".jsonl.zst".length);
      assertSafeRequestId(requestId);
      const path = join(directory, name);
      assertPrivateMode(path, 0o600, "request_capture_file_permissions_invalid");
      const compressed = readFileSync(path);
      const raw = zstdDecompressSync(compressed);
      const record = parseRequestCaptureV3Jsonl(raw);
      if (record.requestId !== requestId) throw integrityError();
      compressedBytes += compressed.length;
      uncompressedBytes += raw.length;
      recordCount += 1;
    }
    return { archiveDate, recordCount, compressedBytes, uncompressedBytes };
  }

  private captureRoot(): string {
    return join(this.config.archiveDirectory, "capture-v3");
  }

  private stagingRoot(): string {
    return join(this.captureRoot(), ".staging");
  }

  private assertIdempotentExisting(path: string, expectedRaw: Buffer, requestId: string): CapturedExchange {
    let existingRaw: Buffer;
    try {
      existingRaw = zstdDecompressSync(readFileSync(path));
    } catch {
      throw captureV3Error("request_capture_conflict", "Existing Request Capture file is unreadable", 409);
    }
    const existing = parseRequestCaptureV3Jsonl(existingRaw);
    if (existing.requestId !== requestId || !existingRaw.equals(expectedRaw)) {
      throw captureV3Error("request_capture_conflict", "Request Capture already exists with different content", 409);
    }
    return decodeRequestCaptureV3Record(existing);
  }
}

interface StreamingRequestCaptureV3WriterInput {
  base: Omit<RequestCaptureV3Record, "response">;
  status: number;
  finalPath: string;
  stagingPath: string;
}

class StreamingRequestCaptureV3Writer implements RequestCaptureV3StreamWriter {
  private readonly source = new PassThrough();
  private readonly rawHash = createHash("sha256");
  private readonly compressedHash = createHash("sha256");
  private readonly pipelinePromise: Promise<void>;
  private pipelineError: unknown;
  private rawBytes = 0;
  private compressedBytes = 0;
  private eventCount = 0;
  private state: "opening" | "open" | "finalizing" | "finalized" | "aborted" = "opening";

  constructor(private readonly input: StreamingRequestCaptureV3WriterInput) {
    const compressor = createZstdCompress({
      params: { [zlibConstants.ZSTD_c_compressionLevel]: REQUEST_CAPTURE_V3_ZSTD_LEVEL }
    });
    const compressedCounter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.compressedBytes += chunk.byteLength;
        this.compressedHash.update(chunk);
        callback(null, chunk);
      }
    });
    const output = createWriteStream(input.stagingPath, { flags: "wx", mode: 0o600 });
    this.pipelinePromise = pipeline(this.source, compressor, compressedCounter, output)
      .catch((error) => {
        this.pipelineError = error;
      });
  }

  async start(): Promise<void> {
    try {
      const prefixObject = {
        ...this.input.base,
        response: {
          captureId: deterministicCaptureId("capture_response", this.input.base.requestId),
          status: this.input.status,
          body: { stream: true, events: [] as unknown[] }
        }
      };
      const serialized = JSON.stringify(prefixObject);
      const eventsToken = "[]";
      const eventsAt = serialized.lastIndexOf(eventsToken);
      if (eventsAt < 0) throw integrityError();
      await this.writeRaw(`${serialized.slice(0, eventsAt)}[`);
      this.state = "open";
    } catch (error) {
      await this.abort();
      throw normalizeStreamCaptureWriteError(error);
    }
  }

  async appendEvent(event: unknown): Promise<void> {
    if (this.state !== "open") throw captureV3Error("request_capture_stream_state_invalid", "Request Capture stream writer is not open", 500);
    try {
      const serialized = JSON.stringify(toSafeJsonTree(event));
      await this.writeRaw(`${this.eventCount === 0 ? "" : ","}${serialized}`);
      this.eventCount += 1;
    } catch (error) {
      await this.abort();
      throw normalizeStreamCaptureWriteError(error);
    }
  }

  async finalize(input: FinalizeRequestCaptureV3StreamInput = {}): Promise<void> {
    if (this.state === "finalized") return;
    if (this.state !== "open") throw captureV3Error("request_capture_stream_state_invalid", "Request Capture stream writer is not open", 500);
    this.state = "finalizing";
    try {
      const capturedAt = isoTimestamp(input.capturedAt ?? new Date().toISOString());
      const errorCode = input.errorCode === undefined ? null : nullableString(input.errorCode);
      await this.writeRaw(`]},"capturedAt":${JSON.stringify(capturedAt)},"errorCode":${JSON.stringify(errorCode)}}}\n`);
      this.source.end();
      await this.pipelinePromise;
      if (this.pipelineError) throw this.pipelineError;
      if (this.compressedBytes > REQUEST_CAPTURE_V3_MAX_COMPRESSED_BYTES) {
        throw captureV3Error("request_capture_record_too_large", "Request Capture record exceeds the compressed byte limit", 413);
      }
      const staged = statSync(this.input.stagingPath);
      assertPrivateModeValue(staged.mode, 0o600, "request_capture_file_permissions_invalid");
      if (staged.size !== this.compressedBytes) throw captureV3Error("request_capture_publish_verify_failed", "Request Capture publish verification failed", 503);
      fsyncFile(this.input.stagingPath);
      const rawDigest = this.rawHash.digest("hex");
      const compressedDigest = this.compressedHash.digest("hex");
      const stagedCompressedDigest = await fileDigest(this.input.stagingPath);
      if (stagedCompressedDigest !== compressedDigest) throw captureV3Error("request_capture_publish_verify_failed", "Request Capture publish verification failed", 503);
      await this.publish(rawDigest);
      this.state = "finalized";
    } catch (error) {
      await this.abort();
      throw normalizeStreamCaptureWriteError(error);
    }
  }

  async abort(): Promise<void> {
    if (this.state === "finalized" || this.state === "aborted") return;
    this.state = "aborted";
    this.source.destroy();
    await this.pipelinePromise;
    rmSync(this.input.stagingPath, { force: true });
  }

  private async writeRaw(value: string): Promise<void> {
    const chunk = Buffer.from(value, "utf8");
    if (chunk.byteLength > REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES - this.rawBytes) {
      throw captureV3Error("request_capture_record_too_large", "Request Capture record exceeds the uncompressed byte limit", 413);
    }
    if (this.pipelineError) throw this.pipelineError;
    this.rawBytes += chunk.byteLength;
    this.rawHash.update(chunk);
    if (this.source.write(chunk)) return;
    await Promise.race([
      once(this.source, "drain"),
      this.pipelinePromise.then(() => {
        if (this.pipelineError) throw this.pipelineError;
        throw captureV3Error("request_capture_stream_write_failed", "Request Capture stream ended before the record was complete", 503);
      })
    ]);
  }

  private async publish(rawDigest: string): Promise<void> {
    try {
      linkSync(this.input.stagingPath, this.input.finalPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const existingRawDigest = await rawCaptureDigest(this.input.finalPath);
      if (existingRawDigest !== rawDigest) {
        throw captureV3Error("request_capture_conflict", "Request Capture already exists with different content", 409);
      }
      this.removePublishedStaging();
      return;
    }
    try {
      fsyncDirectory(dirname(this.input.finalPath));
    } catch (error) {
      rmSync(this.input.finalPath, { force: true });
      throw error;
    }
    this.removePublishedStaging();
  }

  private removePublishedStaging(): void {
    try {
      rmSync(this.input.stagingPath, { force: true });
      fsyncDirectory(dirname(this.input.stagingPath));
    } catch {
      // The canonical file is already durable. Startup cleanup removes a
      // leftover private staging link without changing the published fact.
    }
  }
}

export function requestCaptureV3Record(input: WriteRequestCaptureV3ExchangeInput): RequestCaptureV3Record {
  const base = requestCaptureV3BaseRecord(input);
  return parseRequestCaptureV3Record({
    ...base,
    response: {
      captureId: deterministicCaptureId("capture_response", input.requestId),
      capturedAt: input.response.capturedAt ?? new Date().toISOString(),
      status: input.response.status,
      errorCode: input.response.errorCode ?? null,
      body: toSafeJsonTree(input.response.body)
    }
  });
}

function requestCaptureV3BaseRecord(input: RequestCaptureV3BaseInput): Omit<RequestCaptureV3Record, "response"> {
  assertSafeRequestId(input.requestId);
  utcDate(input.requestLogStartedAt);
  const encoding = input.unavailableReason
    ? encodeUnavailableRequestCapture(input.originalPayload, input.unavailableReason)
    : encodeRequestCapture(
        input.originalPayload,
        Object.hasOwn(input, "effectivePayload") ? input.effectivePayload : input.originalPayload
      );
  const record = parseRequestCaptureV3Record({
    schemaVersion: 3,
    captureId: deterministicCaptureId("capture", input.requestId),
    requestId: input.requestId,
    ownership: { userId: input.userId, apiKeyId: input.apiKeyId, teamId: input.teamId },
    kind: input.kind,
    model: input.reqModel,
    request: {
      capturedAt: input.requestCapturedAt ?? input.requestLogStartedAt,
      original: {
        body: encoding.original,
        hash: { algorithm: encoding.originalHashAlgorithm, value: encoding.originalSha256 }
      },
      effective: {
        representation: encoding.effectiveRepresentation,
        patchFormat: encoding.effectivePatchFormat,
        patch: encoding.effectivePatch,
        fullBody: encoding.effectiveRepresentation === "full" ? encoding.effectivePayload : null,
        hash: encoding.effectiveHashAlgorithm && encoding.effectiveSha256
          ? { algorithm: encoding.effectiveHashAlgorithm, value: encoding.effectiveSha256 }
          : null,
        unavailableReason: encoding.effectiveUnavailableReason
      }
    },
    response: null
  });
  const { response: _response, ...base } = record;
  return base;
}

function deterministicCaptureId(prefix: "capture" | "capture_response", requestId: string): string {
  return `${prefix}_${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
}

export function parseRequestCaptureV3Jsonl(value: Uint8Array): RequestCaptureV3Record {
  const raw = Buffer.from(value);
  if (raw.length === 0 || raw[raw.length - 1] !== 0x0a) throw integrityError();
  const body = raw.subarray(0, -1);
  if (body.includes(0x0a) || body.includes(0x0d)) throw integrityError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw integrityError();
  }
  return parseRequestCaptureV3Record(parsed);
}

export function parseRequestCaptureV3Record(value: unknown): RequestCaptureV3Record {
  return validateRequestCaptureV3Record(value).record;
}

function validateRequestCaptureV3Record(value: unknown): { record: RequestCaptureV3Record; effective: CapturedRequest["effective"] } {
  const record = plainRecord(value, "request_capture_v3_record_invalid");
  exactKeys(record, ["schemaVersion", "captureId", "requestId", "ownership", "kind", "model", "request", "response"]);
  if (record.schemaVersion !== 3) throw integrityError();
  const captureId = requiredString(record.captureId);
  const requestId = requiredString(record.requestId);
  assertSafeRequestId(requestId);
  const ownership = plainRecord(record.ownership, "request_capture_v3_record_invalid");
  exactKeys(ownership, ["userId", "apiKeyId", "teamId"]);
  const request = plainRecord(record.request, "request_capture_v3_record_invalid");
  exactKeys(request, ["capturedAt", "original", "effective"]);
  const original = plainRecord(request.original, "request_capture_v3_record_invalid");
  exactKeys(original, ["body", "hash"]);
  const originalHash = hashRecord(original.hash);
  const effective = plainRecord(request.effective, "request_capture_v3_record_invalid");
  exactKeys(effective, ["representation", "patchFormat", "patch", "fullBody", "hash", "unavailableReason"]);
  const encoding: RequestCaptureEncoding = {
    original: toSafeJsonTree(original.body),
    originalHashAlgorithm: originalHash.algorithm,
    originalSha256: originalHash.value,
    effectiveRepresentation: effective.representation as RequestCaptureEncoding["effectiveRepresentation"],
    effectivePatchFormat: nullableString(effective.patchFormat) as RequestCaptureEncoding["effectivePatchFormat"],
    effectivePatch: effective.patch === null ? null : toSafeJsonTree(effective.patch) as RequestCapturePatchOperation[],
    effectivePayload: effective.fullBody === null ? null : toSafeJsonTree(effective.fullBody),
    effectiveHashAlgorithm: effective.hash === null ? null : hashRecord(effective.hash).algorithm,
    effectiveSha256: effective.hash === null ? null : hashRecord(effective.hash).value,
    effectiveUnavailableReason: nullableString(effective.unavailableReason) as RequestCaptureUnavailableReason | null
  };
  const reconstructedEffective = reconstructEffectiveCapture(encoding);

  let response: RequestCaptureV3Record["response"] = null;
  if (record.response !== null) {
    const input = plainRecord(record.response, "request_capture_v3_record_invalid");
    exactKeys(input, ["captureId", "capturedAt", "status", "errorCode", "body"]);
    const status = Number(input.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) throw integrityError();
    response = {
      captureId: requiredString(input.captureId),
      capturedAt: isoTimestamp(input.capturedAt),
      status,
      errorCode: nullableString(input.errorCode),
      body: toSafeJsonTree(input.body)
    };
  }
  const validatedRecord: RequestCaptureV3Record = {
    schemaVersion: 3,
    captureId,
    requestId,
    ownership: {
      userId: requiredString(ownership.userId),
      apiKeyId: requiredString(ownership.apiKeyId),
      teamId: nullableString(ownership.teamId)
    },
    kind: requiredString(record.kind),
    model: requiredString(record.model),
    request: {
      capturedAt: isoTimestamp(request.capturedAt),
      original: { body: encoding.original, hash: originalHash },
      effective: {
        representation: encoding.effectiveRepresentation,
        patchFormat: encoding.effectivePatchFormat,
        patch: encoding.effectivePatch,
        fullBody: encoding.effectivePayload,
        hash: encoding.effectiveHashAlgorithm && encoding.effectiveSha256
          ? { algorithm: encoding.effectiveHashAlgorithm, value: encoding.effectiveSha256 }
          : null,
        unavailableReason: encoding.effectiveUnavailableReason
      }
    },
    response
  };
  return { record: validatedRecord, effective: reconstructedEffective };
}

export function decodeRequestCaptureV3Record(recordInput: RequestCaptureV3Record): CapturedExchange {
  const { record, effective } = validateRequestCaptureV3Record(recordInput);
  const request: CapturedRequest = {
    id: record.captureId,
    requestId: record.requestId,
    apiKeyId: record.ownership.apiKeyId,
    userId: record.ownership.userId,
    teamId: record.ownership.teamId,
    kind: record.kind,
    reqModel: record.model,
    effectiveRepresentation: record.request.effective.representation,
    effectivePatchFormat: record.request.effective.patchFormat,
    originalHashAlgorithm: record.request.original.hash.algorithm,
    originalSha256: record.request.original.hash.value,
    effectiveHashAlgorithm: record.request.effective.hash?.algorithm ?? null,
    effectiveSha256: record.request.effective.hash?.value ?? null,
    effectiveUnavailableReason: record.request.effective.unavailableReason,
    createdAt: record.request.capturedAt,
    payload: record.request.original.body,
    effective
  };
  const response: CapturedResponse | null = record.response ? {
    id: record.response.captureId,
    requestId: record.requestId,
    status: record.response.status,
    errorCode: record.response.errorCode,
    createdAt: record.response.capturedAt,
    body: record.response.body
  } : null;
  return { request, response };
}

function decodeRequestCaptureV3Jsonl(raw: Uint8Array, expectedRequestId: string): CapturedExchange {
  const bytes = Buffer.from(raw);
  if (bytes.length > REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES || bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) throw integrityError();
  const body = bytes.subarray(0, -1);
  if (body.includes(0x0a) || body.includes(0x0d)) throw integrityError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw integrityError();
  }
  const exchange = decodeRequestCaptureV3Record(parsed as RequestCaptureV3Record);
  if (exchange.request?.requestId !== expectedRequestId) throw integrityError();
  return exchange;
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function hashRecord(value: unknown): { algorithm: RequestCaptureEncoding["originalHashAlgorithm"]; value: string } {
  const hash = plainRecord(value, "request_capture_v3_record_invalid");
  exactKeys(hash, ["algorithm", "value"]);
  if (hash.algorithm !== "jcs-rfc8785-sha256-v1" || typeof hash.value !== "string" || !/^[0-9a-f]{64}$/.test(hash.value)) throw integrityError();
  return { algorithm: hash.algorithm, value: hash.value };
}

function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw captureV3Error(code, "Request Capture v3 record is invalid", 503);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw integrityError();
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw integrityError();
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function isoTimestamp(value: unknown): string {
  const timestamp = requiredString(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) throw integrityError();
  return timestamp;
}

function validResponseStatus(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 599) throw integrityError();
  return value;
}

function utcDate(value: string): string {
  return assertArchiveDate(isoTimestamp(value).slice(0, 10)).join("-");
}

function assertArchiveDate(value: string): [string, string, string] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw captureV3Error("request_capture_v3_invalid_date", "Request Capture UTC date is invalid", 400);
  }
  return value.split("-") as [string, string, string];
}

function assertSafeRequestId(value: string): void {
  if (!isSafeRequestId(value)) {
    throw captureV3Error("request_capture_v3_invalid_request_id", "Request Capture request id is invalid", 400);
  }
}

function assertPrivateMode(path: string, maximumMode: number, code: string): void {
  assertPrivateModeValue(statSync(path).mode, maximumMode, code);
}

function assertPrivateModeValue(rawMode: number, maximumMode: number, code: string): void {
  const mode = rawMode & 0o777;
  if ((mode & ~maximumMode) !== 0) throw captureV3Error(code, "Request Capture path permissions are too broad", 503);
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function rawCaptureDigest(path: string): Promise<string> {
  assertPrivateMode(path, 0o600, "request_capture_file_permissions_invalid");
  const hash = createHash("sha256");
  let bytes = 0;
  let lastByte = -1;
  try {
    await pipeline(
      createReadStream(path),
      createZstdDecompress(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          if (bytes > REQUEST_CAPTURE_V3_MAX_UNCOMPRESSED_BYTES) {
            callback(integrityError());
            return;
          }
          if (chunk.byteLength > 0) lastByte = chunk[chunk.byteLength - 1]!;
          hash.update(chunk);
          callback();
        }
      })
    );
  } catch {
    throw captureV3Error("request_capture_conflict", "Existing Request Capture file is unreadable", 409);
  }
  if (bytes === 0 || lastByte !== 0x0a) throw captureV3Error("request_capture_conflict", "Existing Request Capture file is unreadable", 409);
  return hash.digest("hex");
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(path),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      }
    })
  );
  return hash.digest("hex");
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function normalizeStreamCaptureWriteError(error: unknown): RelayError {
  if (error instanceof RelayError) return error;
  return captureV3Error("request_capture_stream_write_failed", "Request Capture stream could not be written", 503);
}

function integrityError(): RelayError {
  return captureV3Error("request_capture_integrity_failed", "Request Capture integrity verification failed", 503);
}

function captureV3Error(code: string, message: string, status: number): RelayError {
  return new RelayError(code, message, status);
}
