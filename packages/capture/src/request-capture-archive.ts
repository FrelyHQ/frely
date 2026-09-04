import { reconstructEffectiveCapture, toSafeJsonTree, type RequestCaptureEncoding, type RequestCapturePatchOperation, type RequestCaptureUnavailableReason } from "./request-capture-codec.js";

export const REQUEST_CAPTURE_ARCHIVE_FORMAT_VERSION = 2 as const;
export const REQUEST_CAPTURE_ARCHIVE_MANIFEST_VERSION = 2 as const;

export type RequestCaptureArchiveStatus = "generated" | "uploaded" | "verified" | "purged";

export interface RequestCaptureArchive {
  archiveDate: string;
  formatVersion: number;
  status: RequestCaptureArchiveStatus;
  recordCount: number;
  completeExchangeCount: number;
  requestOnlyCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
  objectKey: string;
  objectSha256: string;
  manifestObjectKey: string;
  manifestSha256: string;
  createdAt: string;
  verifiedAt: string | null;
  purgedAt: string | null;
}

export interface RequestCaptureArchiveEntry {
  requestId: string;
  archiveDate: string;
  captureId: string;
  capturedAt: string;
  responsePresent: boolean;
}

export interface RequestCaptureArchiveRecordV1 {
  schemaVersion: 1;
  captureId: string;
  requestId: string;
  ownership: { userId: string; apiKeyId: string; teamId: string | null };
  kind: string;
  model: string;
  request: { capturedAt: string; body: unknown };
  response: { captureId: string; capturedAt: string; status: number; errorCode: string | null; body: unknown } | null;
}

export interface RequestCaptureArchiveManifestV1 {
  manifestVersion: 1;
  archiveFormatVersion: 1;
  kind: "request-captures";
  cutoffGte: string;
  cutoffLt: string;
  recordCount: number;
  objectKey: string;
  compressedBytes: number;
  uncompressedBytes: number;
  sha256: string;
  createdAt: string;
}

export interface RequestCaptureArchiveRecordV2 {
  schemaVersion: 2;
  captureId: string;
  requestId: string;
  ownership: { userId: string; apiKeyId: string; teamId: string | null };
  kind: string;
  model: string;
  request: {
    capturedAt: string;
    original: { body: unknown; hash: { algorithm: string; value: string } };
    effective: { representation: string; patchFormat: string | null; patch: unknown; fullBody: unknown; hash: { algorithm: string; value: string } | null; unavailableReason: string | null };
  };
  response: RequestCaptureArchiveRecordV1["response"];
}

export interface RequestCaptureArchiveManifestV2 extends Omit<RequestCaptureArchiveManifestV1, "manifestVersion" | "archiveFormatVersion"> {
  manifestVersion: 2;
  archiveFormatVersion: 2;
}

export function parseRequestCaptureArchiveRecord(value: string | unknown): RequestCaptureArchiveRecordV1 | RequestCaptureArchiveRecordV2 {
  const input = typeof value === "string" ? parseJson(value, "archive record") : value;
  if ((input as { schemaVersion?: unknown })?.schemaVersion === 1) return parseRequestCaptureArchiveRecordV1(input);
  return parseRequestCaptureArchiveRecordV2(input);
}

export function parseRequestCaptureArchiveRecordV2(value: string | unknown): RequestCaptureArchiveRecordV2 {
  const input = typeof value === "string" ? parseJson(value, "archive record") : value;
  const record = objectWithKeys(input, "archive record", ["schemaVersion", "captureId", "requestId", "ownership", "kind", "model", "request", "response"]);
  exactInteger(record.schemaVersion, 2, "archive record.schemaVersion");
  const ownership = objectWithKeys(record.ownership, "archive record.ownership", ["userId", "apiKeyId", "teamId"]);
  const request = objectWithKeys(record.request, "archive record.request", ["capturedAt", "original", "effective"]);
  const original = objectWithKeys(request.original, "archive record.request.original", ["body", "hash"]);
  const originalHash = objectWithKeys(original.hash, "archive record.request.original.hash", ["algorithm", "value"]);
  const effective = objectWithKeys(request.effective, "archive record.request.effective", ["representation", "patchFormat", "patch", "fullBody", "hash", "unavailableReason"]);
  const effectiveHash = effective.hash === null ? null : objectWithKeys(effective.hash, "archive record.request.effective.hash", ["algorithm", "value"]);
  const response = record.response === null ? null : objectWithKeys(record.response, "archive record.response", ["captureId", "capturedAt", "status", "errorCode", "body"]);
  const result: RequestCaptureArchiveRecordV2 = {
    schemaVersion: 2,
    captureId: nonEmptyString(record.captureId, "archive record.captureId"), requestId: nonEmptyString(record.requestId, "archive record.requestId"),
    ownership: { userId: nonEmptyString(ownership.userId, "archive record.ownership.userId"), apiKeyId: nonEmptyString(ownership.apiKeyId, "archive record.ownership.apiKeyId"), teamId: nullableNonEmptyString(ownership.teamId, "archive record.ownership.teamId") },
    kind: nonEmptyString(record.kind, "archive record.kind"), model: nonEmptyString(record.model, "archive record.model"),
    request: {
      capturedAt: isoTimestamp(request.capturedAt, "archive record.request.capturedAt"),
      original: { body: toSafeJsonTree(original.body), hash: { algorithm: nonEmptyString(originalHash.algorithm, "original hash algorithm"), value: sha256(originalHash.value, "original hash") } },
      effective: {
        representation: nonEmptyString(effective.representation, "effective representation"), patchFormat: nullableNonEmptyString(effective.patchFormat, "effective patch format"),
        patch: effective.patch, fullBody: effective.fullBody,
        hash: effectiveHash ? { algorithm: nonEmptyString(effectiveHash.algorithm, "effective hash algorithm"), value: sha256(effectiveHash.value, "effective hash") } : null,
        unavailableReason: nullableNonEmptyString(effective.unavailableReason, "effective unavailable reason")
      }
    },
    response: response === null ? null : { captureId: nonEmptyString(response.captureId, "response.captureId"), capturedAt: isoTimestamp(response.capturedAt, "response.capturedAt"), status: nonNegativeInteger(response.status, "response.status"), errorCode: nullableNonEmptyString(response.errorCode, "response.errorCode"), body: response.body }
  };
  effectiveEncodingFromArchiveRecordV2(result);
  assertJsonValue(result, "archive record");
  return result;
}

export function effectiveEncodingFromArchiveRecordV2(record: RequestCaptureArchiveRecordV2): RequestCaptureEncoding {
  const effectiveHashAlgorithm = record.request.effective.hash?.algorithm ?? null;
  const encoding: RequestCaptureEncoding = {
    original: toSafeJsonTree(record.request.original.body), originalHashAlgorithm: record.request.original.hash.algorithm as never, originalSha256: record.request.original.hash.value,
    effectiveRepresentation: record.request.effective.representation as never, effectivePatchFormat: record.request.effective.patchFormat as never,
    effectivePatch: record.request.effective.patch as RequestCapturePatchOperation[] | null,
    effectivePayload: record.request.effective.fullBody as never,
    effectiveHashAlgorithm: effectiveHashAlgorithm as RequestCaptureEncoding["effectiveHashAlgorithm"],
    effectiveSha256: record.request.effective.hash?.value ?? null,
    effectiveUnavailableReason: record.request.effective.unavailableReason as RequestCaptureUnavailableReason | null
  };
  reconstructEffectiveCapture(encoding, true);
  return encoding;
}

export function parseRequestCaptureArchiveRecordV1(value: string | unknown): RequestCaptureArchiveRecordV1 {
  const input = typeof value === "string" ? parseJson(value, "archive record") : value;
  const record = objectWithKeys(input, "archive record", ["schemaVersion", "captureId", "requestId", "ownership", "kind", "model", "request", "response"]);
  exactInteger(record.schemaVersion, 1, "archive record.schemaVersion");
  const ownership = objectWithKeys(record.ownership, "archive record.ownership", ["userId", "apiKeyId", "teamId"]);
  const request = objectWithKeys(record.request, "archive record.request", ["capturedAt", "body"]);
  const response = record.response === null ? null : objectWithKeys(record.response, "archive record.response", ["captureId", "capturedAt", "status", "errorCode", "body"]);

  const result: RequestCaptureArchiveRecordV1 = {
    schemaVersion: 1,
    captureId: nonEmptyString(record.captureId, "archive record.captureId"),
    requestId: nonEmptyString(record.requestId, "archive record.requestId"),
    ownership: {
      userId: nonEmptyString(ownership.userId, "archive record.ownership.userId"),
      apiKeyId: nonEmptyString(ownership.apiKeyId, "archive record.ownership.apiKeyId"),
      teamId: nullableNonEmptyString(ownership.teamId, "archive record.ownership.teamId")
    },
    kind: nonEmptyString(record.kind, "archive record.kind"),
    model: nonEmptyString(record.model, "archive record.model"),
    request: { capturedAt: isoTimestamp(request.capturedAt, "archive record.request.capturedAt"), body: request.body },
    response: response === null ? null : {
      captureId: nonEmptyString(response.captureId, "archive record.response.captureId"),
      capturedAt: isoTimestamp(response.capturedAt, "archive record.response.capturedAt"),
      status: nonNegativeInteger(response.status, "archive record.response.status"),
      errorCode: nullableNonEmptyString(response.errorCode, "archive record.response.errorCode"),
      body: response.body
    }
  };
  assertJsonValue(result, "archive record");
  return result;
}

export function parseRequestCaptureArchiveManifestV1(value: string | unknown): RequestCaptureArchiveManifestV1 {
  const input = typeof value === "string" ? parseJson(value, "archive manifest") : value;
  const manifest = objectWithKeys(input, "archive manifest", [
    "manifestVersion", "archiveFormatVersion", "kind", "cutoffGte", "cutoffLt", "recordCount", "objectKey",
    "compressedBytes", "uncompressedBytes", "sha256", "createdAt"
  ]);
  exactInteger(manifest.manifestVersion, 1, "archive manifest.manifestVersion");
  exactInteger(manifest.archiveFormatVersion, 1, "archive manifest.archiveFormatVersion");
  if (manifest.kind !== "request-captures") invalid("archive manifest.kind must be request-captures");
  const cutoffGte = isoTimestamp(manifest.cutoffGte, "archive manifest.cutoffGte");
  const cutoffLt = isoTimestamp(manifest.cutoffLt, "archive manifest.cutoffLt");
  const archiveDate = cutoffGte.slice(0, 10);
  utcDate(archiveDate, "archive manifest cutoff date");
  if (cutoffGte !== `${archiveDate}T00:00:00.000Z` || cutoffLt !== `${nextUtcDate(archiveDate)}T00:00:00.000Z`) invalid("archive manifest cutoff must cover exactly one UTC day");
  return {
    manifestVersion: 1,
    archiveFormatVersion: 1,
    kind: "request-captures",
    cutoffGte,
    cutoffLt,
    recordCount: nonNegativeInteger(manifest.recordCount, "archive manifest.recordCount"),
    objectKey: nonEmptyString(manifest.objectKey, "archive manifest.objectKey"),
    compressedBytes: nonNegativeInteger(manifest.compressedBytes, "archive manifest.compressedBytes"),
    uncompressedBytes: nonNegativeInteger(manifest.uncompressedBytes, "archive manifest.uncompressedBytes"),
    sha256: sha256(manifest.sha256, "archive manifest.sha256"),
    createdAt: isoTimestamp(manifest.createdAt, "archive manifest.createdAt")
  };
}

export function parseRequestCaptureArchiveManifestV2(value: string | unknown): RequestCaptureArchiveManifestV2 {
  const parsed = typeof value === "string" ? parseJson(value, "archive manifest") : value;
  const manifest = objectWithKeys(parsed, "archive manifest", ["manifestVersion", "archiveFormatVersion", "kind", "cutoffGte", "cutoffLt", "recordCount", "objectKey", "compressedBytes", "uncompressedBytes", "sha256", "createdAt"]);
  exactInteger(manifest.manifestVersion, 2, "archive manifest.manifestVersion");
  exactInteger(manifest.archiveFormatVersion, 2, "archive manifest.archiveFormatVersion");
  const compatible = { ...manifest, manifestVersion: 1, archiveFormatVersion: 1 };
  const v1 = parseRequestCaptureArchiveManifestV1(compatible);
  return { ...v1, manifestVersion: 2, archiveFormatVersion: 2 };
}

function objectWithKeys(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  const missing = keys.filter((key) => !Object.hasOwn(object, key));
  const extra = actual.filter((key) => !keys.includes(key));
  if (missing.length > 0) invalid(`${label} is missing ${missing.join(", ")}`);
  if (extra.length > 0) invalid(`${label} contains unsupported fields: ${extra.join(", ")}`);
  return object;
}

function parseJson(value: string, label: string): unknown {
  try { return JSON.parse(value); } catch { return invalid(`${label} is not valid JSON`); }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) return invalid(`${label} must be a non-empty string`);
  return value;
}

function nullableNonEmptyString(value: unknown, label: string): string | null {
  return value === null ? null : nonEmptyString(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid(`${label} must be a non-negative safe integer`);
  return value;
}

function exactInteger(value: unknown, expected: number, label: string): void {
  if (value !== expected) invalid(`${label} must be ${expected}`);
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    return invalid(`${label} must be an ISO UTC timestamp with milliseconds`);
  }
  return value;
}

function utcDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    return invalid(`${label} must be a valid YYYY-MM-DD UTC date`);
  }
  return value;
}

function nextUtcDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return invalid(`${label} must be a lowercase SHA-256 hex digest`);
  return value;
}

function assertJsonValue(value: unknown, label: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${label} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") invalid(`${label} must be JSON serializable`);
  const object = value as object;
  if (seen.has(object)) invalid(`${label} must not contain cycles`);
  seen.add(object);
  if (Array.isArray(object)) {
    for (const item of object) assertJsonValue(item, label, seen);
  } else {
    if (Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) invalid(`${label} must contain only JSON objects`);
    for (const item of Object.values(object)) assertJsonValue(item, label, seen);
  }
  seen.delete(object);
}

function invalid(message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = "invalid_request_capture_archive";
  throw error;
}
