import { constants as fsConstants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { RelayError } from "@frely/core";
import type { RequestLog } from "./contracts.js";
import type { RequestCaptureV3Storage } from "./request-capture-v3.js";

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const SOURCE_READ_BUFFER_BYTES = 64 * 1024;

export interface RequestCaptureDownloadLimits {
  maxFiles: number;
  maxCompressedBytes: number;
}

export interface PreparedRequestCaptureFile {
  requestId: string;
  path: string;
  size: number;
  mode: number;
  device: number;
  inode: number;
  tier?: "hot" | "cold";
  readColdBytes?: () => Promise<Buffer>;
}

export interface PreparedRequestCaptureDownload {
  files: PreparedRequestCaptureFile[];
  candidateCount: number;
  missingCount: number;
  compressedBytes: number;
}

export interface RequestCaptureStreamHooks {
  onComplete?: () => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

/**
 * REQ-MEMBER-009: callers pass already-authorized Request Logs. This preflight
 * derives the hot v3 path first. A cold fallback bounded-reads one indexed
 * frame to validate the record and calculate the independently compressed
 * entry size before response headers are sent.
 */
export async function prepareRequestCaptureDownload(
  storage: RequestCaptureV3Storage,
  requestLogs: ReadonlyArray<Pick<RequestLog, "id" | "startedAt">>,
  limits: RequestCaptureDownloadLimits
): Promise<PreparedRequestCaptureDownload> {
  const uniqueLogs = new Map<string, Pick<RequestLog, "id" | "startedAt">>();
  for (const requestLog of requestLogs) if (!uniqueLogs.has(requestLog.id)) uniqueLogs.set(requestLog.id, requestLog);
  const candidates = [...uniqueLogs.values()];
  if (candidates.length > limits.maxFiles) throw tooLarge();

  const files: PreparedRequestCaptureFile[] = [];
  let missingCount = 0;
  let compressedBytes = 0;
  for (const requestLog of candidates) {
    const path = storage.pathForRequest(requestLog.startedAt, requestLog.id);
    const fileStat = await stat(path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw unavailable(error);
    });
    if (!fileStat) {
      const cold = await storage.readCompressedCaptureBytes(requestLog.startedAt, requestLog.id).catch((error: unknown) => {
        throw unavailable(error);
      });
      if (!cold) {
        missingCount += 1;
        continue;
      }
      if (cold.tier !== "cold") throw unavailable();
      if (cold.bytes.length > limits.maxCompressedBytes) throw tooLarge();
      compressedBytes += cold.bytes.length;
      if (!Number.isSafeInteger(compressedBytes) || compressedBytes > limits.maxCompressedBytes) throw tooLarge();
      const expectedSize = cold.bytes.length;
      files.push({
        requestId: requestLog.id,
        path: "",
        size: expectedSize,
        mode: 0o600,
        device: 0,
        inode: 0,
        tier: "cold",
        readColdBytes: async () => {
          const current = await storage.readCompressedCaptureBytes(requestLog.startedAt, requestLog.id);
          if (!current || current.tier !== "cold" || current.bytes.length !== expectedSize) throw unavailable();
          return current.bytes;
        }
      });
      continue;
    }
    if (!fileStat.isFile()) throw unavailable();
    const mode = fileStat.mode & 0o777;
    if ((mode & ~0o600) !== 0) {
      throw new RelayError("request_capture_file_permissions_invalid", "Request Capture file permissions are too broad", 503);
    }
    await access(path, fsConstants.R_OK).catch((error: unknown) => { throw unavailable(error); });
    if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0 || fileStat.size > limits.maxCompressedBytes) throw tooLarge();
    compressedBytes += fileStat.size;
    if (!Number.isSafeInteger(compressedBytes) || compressedBytes > limits.maxCompressedBytes) throw tooLarge();
    files.push({
      requestId: requestLog.id,
      path,
      size: fileStat.size,
      mode,
      device: fileStat.dev,
      inode: fileStat.ino
    });
  }
  if (files.length === 0) throw new RelayError("request_capture_not_found", "Request capture not found", 404);
  return { files, candidateCount: candidates.length, missingCount, compressedBytes };
}

export function requestCaptureFileStream(file: PreparedRequestCaptureFile, hooks: RequestCaptureStreamHooks = {}): ReadableStream<Uint8Array> {
  return streamFromGenerator(() => sourceFileChunks(file), hooks);
}

/**
 * Emits a POSIX tar stream. Hot entries retain original v3 .jsonl.zst bytes;
 * cold entries preserve the exact decompressed JSONL bytes under a new Zstd
 * wrapper. PAX path headers are used only when a request id exceeds the
 * classic ustar name field.
 */
export function requestCaptureTarStream(files: readonly PreparedRequestCaptureFile[], hooks: RequestCaptureStreamHooks = {}): ReadableStream<Uint8Array> {
  return streamFromGenerator(async function* () {
    let index = 0;
    for (const file of files) {
      const entryName = `${file.requestId}.jsonl.zst`;
      if (Buffer.byteLength(entryName) > 100) {
        const pax = paxPathRecord(entryName);
        yield tarHeader(`PaxHeaders/${index}`, pax.length, "x");
        yield pax;
        yield tarPadding(pax.length);
      }
      yield tarHeader(Buffer.byteLength(entryName) <= 100 ? entryName : `capture-${index}.jsonl.zst`, file.size, "0");
      yield* sourceFileChunks(file);
      yield tarPadding(file.size);
      index += 1;
    }
    yield Buffer.alloc(TAR_END_BYTES);
  }, hooks);
}

function streamFromGenerator(factory: () => AsyncGenerator<Buffer>, hooks: RequestCaptureStreamHooks): ReadableStream<Uint8Array> {
  const iterator = factory();
  let completed = false;
  let failed = false;
  let pull: Promise<void> | null = null;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pull = (async () => {
        try {
          const next = await iterator.next();
          if (next.done) {
            try {
              await hooks.onComplete?.();
            } catch (auditError) {
              failed = true;
              controller.error(auditError);
              return;
            }
            completed = true;
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          failed = true;
          try {
            await hooks.onError?.(error);
          } catch (auditError) {
            controller.error(auditError);
            return;
          }
          controller.error(error);
        }
      })();
      return pull;
    },
    async cancel() {
      await pull?.catch(() => undefined);
      await iterator.return(undefined).catch(() => undefined);
      if (!completed && !failed) await hooks.onCancel?.();
    }
  }, { highWaterMark: 1 });
}

async function* sourceFileChunks(file: PreparedRequestCaptureFile): AsyncGenerator<Buffer> {
  if (file.tier === "cold") {
    if (!file.readColdBytes) throw unavailable();
    const bytes = await file.readColdBytes().catch((error: unknown) => { throw unavailable(error); });
    for (let offset = 0; offset < bytes.length; offset += SOURCE_READ_BUFFER_BYTES) {
      yield bytes.subarray(offset, Math.min(bytes.length, offset + SOURCE_READ_BUFFER_BYTES));
    }
    return;
  }
  const handle = await open(file.path, "r").catch((error: unknown) => { throw unavailable(error); });
  let source: ReturnType<typeof handle.createReadStream> | null = null;
  try {
    const current = await handle.stat().catch((error: unknown) => { throw unavailable(error); });
    const currentMode = current.mode & 0o777;
    if (!current.isFile() || current.size !== file.size || current.dev !== file.device || current.ino !== file.inode) throw unavailable();
    if ((currentMode & ~0o600) !== 0) {
      throw new RelayError("request_capture_file_permissions_invalid", "Request Capture file permissions are too broad", 503);
    }
    source = handle.createReadStream({ autoClose: true, highWaterMark: SOURCE_READ_BUFFER_BYTES });
    let emitted = 0;
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      emitted += bytes.length;
      if (emitted > file.size) throw unavailable();
      yield bytes;
    }
    if (emitted !== file.size) throw unavailable();
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw unavailable(error);
  } finally {
    if (source) {
      source.destroy();
      await finished(source).catch(() => undefined);
    } else {
      await handle.close().catch(() => undefined);
    }
  }
}

function tarHeader(name: string, size: number, type: "0" | "x"): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeText(header, 156, 1, type);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeText(header, 148, 8, `${checksumText}\0 `);
  return header;
}

function writeText(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new RelayError("request_capture_unavailable", "Request Capture tar metadata is invalid", 503);
  bytes.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8);
  if (text.length > length - 1) throw tooLarge();
  writeText(target, offset, length, `${text.padStart(length - 1, "0")}\0`);
}

function paxPathRecord(path: string): Buffer {
  const suffix = ` path=${path}\n`;
  let length = Buffer.byteLength(suffix) + 1;
  while (true) {
    const next = Buffer.byteLength(suffix) + String(length).length;
    if (next === length) return Buffer.from(`${length}${suffix}`, "utf8");
    length = next;
  }
}

function tarPadding(size: number): Buffer {
  const bytes = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
  return Buffer.alloc(bytes);
}

function tooLarge(): RelayError {
  return new RelayError("request_capture_download_too_large", "Request Capture download is too large", 413);
}

function unavailable(cause?: unknown): RelayError {
  const error = new RelayError("request_capture_unavailable", "Request Capture v3 file is unavailable", 503);
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}
