import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AppConfig } from "@frely/config";

export const SHARED_CAPTURE_STORAGE_SCHEMA = "friday-relay.shared-capture-storage.v1";
export const SHARED_CAPTURE_STORAGE_MARKER = ".shared-storage.json";

const ADMISSION_DIRECTORY = ".shared-storage-admission";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface SharedCaptureStorageInspection {
  schema: typeof SHARED_CAPTURE_STORAGE_SCHEMA;
  storageId: string;
  captureRoot: string;
  markerDigest: string;
  mountVerified: boolean;
}

export interface SharedCaptureStorageProbe {
  schema: "friday-relay.shared-capture-storage-probe.v1";
  storageId: string;
  probeId: string;
  writerId: string;
}

export function assertSharedCaptureStorageForConfig(
  config: AppConfig,
  options: { mountInfo?: string; requireMount?: boolean } = {},
): SharedCaptureStorageInspection | null {
  if (config.archive.shared !== true) return null;
  if (!config.archive.sharedStorageId) throw sharedStorageError("shared_capture_storage_id_required");
  return inspectSharedCaptureStorage({
    archiveDirectory: config.archive.directory,
    expectedStorageId: config.archive.sharedStorageId,
    ...options,
  });
}

export function inspectSharedCaptureStorage(input: {
  archiveDirectory: string;
  expectedStorageId: string;
  mountInfo?: string;
  requireMount?: boolean;
}): SharedCaptureStorageInspection {
  assertSafeId(input.expectedStorageId, "shared_capture_storage_id_invalid");
  if (!isAbsolute(input.archiveDirectory)) throw sharedStorageError("shared_capture_storage_archive_path_invalid");
  const captureRoot = resolve(input.archiveDirectory, "capture-v3");
  assertPrivateDirectory(captureRoot, "shared_capture_storage_root_invalid");
  const markerPath = join(captureRoot, SHARED_CAPTURE_STORAGE_MARKER);
  const marker = readPrivateJson(markerPath, "shared_capture_storage_marker_invalid");
  assertExactKeys(marker, ["schema", "storageId"], "shared_capture_storage_marker_invalid");
  if (marker.schema !== SHARED_CAPTURE_STORAGE_SCHEMA || marker.storageId !== input.expectedStorageId) {
    throw sharedStorageError("shared_capture_storage_identity_mismatch");
  }
  let markerBytes: Buffer;
  try { markerBytes = readFileSync(markerPath); } catch { throw sharedStorageError("shared_capture_storage_marker_invalid"); }
  const mountInfo = input.mountInfo ?? readMountInfo();
  const mountVerified = mountInfo === null ? false : mountInfoContainsPath(mountInfo, captureRoot);
  if ((input.requireMount ?? true) && !mountVerified) throw sharedStorageError("shared_capture_storage_mount_unverified");
  return {
    schema: SHARED_CAPTURE_STORAGE_SCHEMA,
    storageId: input.expectedStorageId,
    captureRoot,
    markerDigest: sha256(markerBytes),
    mountVerified,
  };
}

export function publishSharedCaptureStorageProbe(input: {
  archiveDirectory: string;
  expectedStorageId: string;
  probeId: string;
  writerId: string;
  mountInfo?: string;
  requireMount?: boolean;
}): SharedCaptureStorageInspection & { probeDigest: string; published: boolean; idempotent: boolean } {
  const inspection = inspectSharedCaptureStorage(input);
  assertSafeId(input.probeId, "shared_capture_storage_probe_id_invalid");
  assertSafeId(input.writerId, "shared_capture_storage_writer_id_invalid");
  const payload: SharedCaptureStorageProbe = {
    schema: "friday-relay.shared-capture-storage-probe.v1",
    storageId: inspection.storageId,
    probeId: input.probeId,
    writerId: input.writerId,
  };
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  const probeDigest = sha256(bytes);
  const { directory, stagingDirectory, finalPath } = probePaths(inspection.captureRoot, input.probeId);
  ensurePrivateDirectory(directory);
  ensurePrivateDirectory(stagingDirectory);
  if (pathExists(finalPath, "shared_capture_storage_probe_file_invalid")) {
    assertProbeFile(finalPath, input, probeDigest);
    return { ...inspection, probeDigest, published: false, idempotent: true };
  }

  const stagingPath = join(stagingDirectory, `${input.probeId}.${input.writerId}.${randomUUID()}.partial`);
  try {
    writeFileSync(stagingPath, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(stagingPath, 0o600);
    fsyncFile(stagingPath);
    try {
      linkSync(stagingPath, finalPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      assertProbeFile(finalPath, input, probeDigest);
      return { ...inspection, probeDigest, published: false, idempotent: true };
    }
    fsyncDirectory(directory);
    assertProbeFile(finalPath, input, probeDigest);
    return { ...inspection, probeDigest, published: true, idempotent: false };
  } finally {
    rmSync(stagingPath, { force: true });
    fsyncDirectory(stagingDirectory);
  }
}

export function readSharedCaptureStorageProbe(input: {
  archiveDirectory: string;
  expectedStorageId: string;
  probeId: string;
  expectedDigest: string;
  expectedWriterId?: string;
  mountInfo?: string;
  requireMount?: boolean;
}): SharedCaptureStorageInspection & { probeDigest: string; writerId: string } {
  const inspection = inspectSharedCaptureStorage(input);
  assertSafeId(input.probeId, "shared_capture_storage_probe_id_invalid");
  assertDigest(input.expectedDigest);
  const finalPath = probePaths(inspection.captureRoot, input.probeId).finalPath;
  const probe = assertProbeFile(finalPath, input, input.expectedDigest);
  return { ...inspection, probeDigest: input.expectedDigest, writerId: probe.writerId };
}

export function removeSharedCaptureStorageProbe(input: {
  archiveDirectory: string;
  expectedStorageId: string;
  probeId: string;
  expectedDigest: string;
  mountInfo?: string;
  requireMount?: boolean;
}): SharedCaptureStorageInspection & { removed: boolean } {
  const inspection = inspectSharedCaptureStorage(input);
  assertSafeId(input.probeId, "shared_capture_storage_probe_id_invalid");
  assertDigest(input.expectedDigest);
  const { directory, finalPath } = probePaths(inspection.captureRoot, input.probeId);
  if (!pathExists(finalPath, "shared_capture_storage_probe_file_invalid")) return { ...inspection, removed: false };
  assertProbeFile(finalPath, input, input.expectedDigest);
  rmSync(finalPath);
  fsyncDirectory(directory);
  return { ...inspection, removed: true };
}

export function assertSharedCaptureStorageProbeAbsent(input: {
  archiveDirectory: string;
  expectedStorageId: string;
  probeId: string;
  mountInfo?: string;
  requireMount?: boolean;
}): SharedCaptureStorageInspection & { absent: true } {
  const inspection = inspectSharedCaptureStorage(input);
  assertSafeId(input.probeId, "shared_capture_storage_probe_id_invalid");
  const { directory, finalPath } = probePaths(inspection.captureRoot, input.probeId);
  if (!pathExists(directory, "shared_capture_storage_admission_directory_invalid")) return { ...inspection, absent: true };
  assertPrivateDirectory(directory, "shared_capture_storage_admission_directory_invalid");
  if (pathExists(finalPath, "shared_capture_storage_probe_file_invalid")) {
    throw sharedStorageError("shared_capture_storage_probe_cleanup_unverified");
  }
  return { ...inspection, absent: true };
}

function assertProbeFile(
  path: string,
  expected: { expectedStorageId: string; probeId: string; expectedWriterId?: string },
  expectedDigest: string,
): SharedCaptureStorageProbe {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
      throw sharedStorageError("shared_capture_storage_probe_file_invalid");
    }
    if (metadata.size > 4096) throw sharedStorageError("shared_capture_storage_probe_file_invalid");
    const bytes = readFileSync(path);
    if (sha256(bytes) !== expectedDigest) throw sharedStorageError("shared_capture_storage_probe_digest_mismatch");
    const value = parseJson(bytes, "shared_capture_storage_probe_invalid");
    assertExactKeys(value, ["schema", "storageId", "probeId", "writerId"], "shared_capture_storage_probe_invalid");
    if (value.schema !== "friday-relay.shared-capture-storage-probe.v1"
      || value.storageId !== expected.expectedStorageId
      || value.probeId !== expected.probeId
      || (expected.expectedWriterId && value.writerId !== expected.expectedWriterId)) {
      throw sharedStorageError("shared_capture_storage_probe_identity_mismatch");
    }
    assertSafeId(value.writerId, "shared_capture_storage_writer_id_invalid");
    return {
      schema: "friday-relay.shared-capture-storage-probe.v1",
      storageId: expected.expectedStorageId,
      probeId: expected.probeId,
      writerId: value.writerId,
    };
  } catch (error) {
    if (isSharedStorageError(error)) throw error;
    throw sharedStorageError("shared_capture_storage_probe_file_invalid");
  }
}

function probePaths(captureRoot: string, probeId: string) {
  const directory = join(captureRoot, ADMISSION_DIRECTORY);
  return {
    directory,
    stagingDirectory: join(directory, ".staging"),
    finalPath: join(directory, `${probeId}.json`),
  };
}

function readPrivateJson(path: string, code: string): Record<string, unknown> {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 4096) {
      throw sharedStorageError(code);
    }
    return parseJson(readFileSync(path), code);
  } catch (error) {
    if (isSharedStorageError(error)) throw error;
    throw sharedStorageError(code);
  }
}

function parseJson(bytes: Buffer, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
    return value as Record<string, unknown>;
  } catch {
    throw sharedStorageError(code);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], code: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw sharedStorageError(code);
}

function assertPrivateDirectory(path: string, code: string): void {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) throw sharedStorageError(code);
  } catch (error) {
    if (isSharedStorageError(error)) throw error;
    throw sharedStorageError(code);
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(path, "shared_capture_storage_admission_directory_invalid");
}

function pathExists(path: string, code: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw sharedStorageError(code);
  }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function readMountInfo(): string | null {
  try { return readFileSync("/proc/self/mountinfo", "utf8"); } catch { return null; }
}

function mountInfoContainsPath(mountInfo: string, path: string): boolean {
  const expected = resolve(path);
  return mountInfo.split(/\r?\n/u).some((line) => {
    const separator = line.indexOf(" - ");
    if (separator < 0) return false;
    const fields = line.slice(0, separator).split(" ");
    return fields.length >= 5 && decodeMountInfoPath(fields[4] ?? "") === expected;
  });
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertSafeId(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw sharedStorageError(code);
}

function assertDigest(value: string): void {
  if (!DIGEST.test(value)) throw sharedStorageError("shared_capture_storage_probe_digest_invalid");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function isSharedStorageError(error: unknown): error is Error & { code: string } {
  return Boolean(error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.startsWith("shared_capture_storage_"));
}

function sharedStorageError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}
