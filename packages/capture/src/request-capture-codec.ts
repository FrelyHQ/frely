import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import jsonPatch from "fast-json-patch";
import { RelayError } from "@frely/core";

export const REQUEST_CAPTURE_HASH_ALGORITHM = "jcs-rfc8785-sha256-v1" as const;
export const REQUEST_CAPTURE_PATCH_FORMAT = "rfc6902-v1" as const;
export const REQUEST_CAPTURE_MAX_DEPTH = 64;
export const REQUEST_CAPTURE_MAX_PATCH_OPERATIONS = 2_048;
export const REQUEST_CAPTURE_MAX_PATCH_BYTES = 1_048_576;
export const REQUEST_CAPTURE_MAX_CODEC_INPUT_BYTES = 4_194_304;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type RequestCaptureUnavailableReason = "legacy_original_only" | "ingress_plugin_failed" | "capture_encoding_failed";
export type RequestCaptureRepresentation = "identity" | "rfc6902" | "full" | "unavailable";
export type RequestCapturePatchOperation =
  | { op: "add" | "replace"; path: string; value: JsonValue }
  | { op: "remove"; path: string };

export interface RequestCaptureEncoding {
  original: JsonValue;
  originalHashAlgorithm: typeof REQUEST_CAPTURE_HASH_ALGORITHM;
  originalSha256: string;
  effectiveRepresentation: RequestCaptureRepresentation;
  effectivePatchFormat: typeof REQUEST_CAPTURE_PATCH_FORMAT | null;
  effectivePatch: RequestCapturePatchOperation[] | null;
  effectivePayload: JsonValue | null;
  effectiveHashAlgorithm: typeof REQUEST_CAPTURE_HASH_ALGORITHM | null;
  effectiveSha256: string | null;
  effectiveUnavailableReason: RequestCaptureUnavailableReason | null;
}

export type EffectiveCapture =
  | { status: "verified"; representation: "identity" | "rfc6902" | "full"; body: JsonValue }
  | { status: "unavailable"; reason: RequestCaptureUnavailableReason };

export function encodeRequestCapture(originalInput: unknown, effectiveInput: unknown): RequestCaptureEncoding {
  const original = toSafeJsonTree(originalInput);
  const effective = toSafeJsonTree(effectiveInput);
  const originalSha256 = canonicalSha256(original);
  const effectiveSha256 = canonicalSha256(effective);
  const base = { original, originalHashAlgorithm: REQUEST_CAPTURE_HASH_ALGORITHM, originalSha256 } as const;
  if (originalSha256 === effectiveSha256 && deepEqualJson(original, effective)) {
    return { ...base, effectiveRepresentation: "identity", effectivePatchFormat: null, effectivePatch: null, effectivePayload: null, effectiveHashAlgorithm: REQUEST_CAPTURE_HASH_ALGORITHM, effectiveSha256, effectiveUnavailableReason: null };
  }

  if (Buffer.byteLength(JSON.stringify(original), "utf8") + Buffer.byteLength(JSON.stringify(effective), "utf8") > REQUEST_CAPTURE_MAX_CODEC_INPUT_BYTES) {
    return { ...base, effectiveRepresentation: "full", effectivePatchFormat: null, effectivePatch: null, effectivePayload: effective, effectiveHashAlgorithm: REQUEST_CAPTURE_HASH_ALGORITHM, effectiveSha256, effectiveUnavailableReason: null };
  }

  try {
    const patch = jsonPatch.compare(original as never, effective as never, false) as RequestCapturePatchOperation[];
    validatePatch(patch);
    const patchBytes = Buffer.byteLength(JSON.stringify(patch), "utf8");
    const fullBytes = Buffer.byteLength(JSON.stringify(effective), "utf8");
    if (patchBytes > REQUEST_CAPTURE_MAX_PATCH_BYTES || patch.length > REQUEST_CAPTURE_MAX_PATCH_OPERATIONS || patchBytes >= fullBytes) throw codecError("capture_patch_limit_exceeded");
    const reconstructed = applyRequestCapturePatch(original, patch);
    if (!deepEqualJson(reconstructed, effective) || canonicalSha256(reconstructed) !== effectiveSha256) throw codecError("capture_patch_verify_failed");
    return { ...base, effectiveRepresentation: "rfc6902", effectivePatchFormat: REQUEST_CAPTURE_PATCH_FORMAT, effectivePatch: patch, effectivePayload: null, effectiveHashAlgorithm: REQUEST_CAPTURE_HASH_ALGORITHM, effectiveSha256, effectiveUnavailableReason: null };
  } catch {
    return { ...base, effectiveRepresentation: "full", effectivePatchFormat: null, effectivePatch: null, effectivePayload: effective, effectiveHashAlgorithm: REQUEST_CAPTURE_HASH_ALGORITHM, effectiveSha256, effectiveUnavailableReason: null };
  }
}

export function encodeUnavailableRequestCapture(originalInput: unknown, reason: RequestCaptureUnavailableReason): RequestCaptureEncoding {
  const original = toSafeJsonTree(originalInput);
  return { original, originalHashAlgorithm: REQUEST_CAPTURE_HASH_ALGORITHM, originalSha256: canonicalSha256(original), effectiveRepresentation: "unavailable", effectivePatchFormat: null, effectivePatch: null, effectivePayload: null, effectiveHashAlgorithm: null, effectiveSha256: null, effectiveUnavailableReason: reason };
}

export function reconstructEffectiveCapture(encoding: RequestCaptureEncoding, verifyOriginal = true): EffectiveCapture {
  const original = toSafeJsonTree(encoding.original);
  if (verifyOriginal && canonicalSha256(original) !== encoding.originalSha256) throw integrityError();
  if (encoding.effectiveRepresentation === "unavailable") {
    if (!encoding.effectiveUnavailableReason) throw integrityError();
    return { status: "unavailable", reason: encoding.effectiveUnavailableReason };
  }
  if (!encoding.effectiveSha256 || encoding.effectiveHashAlgorithm !== REQUEST_CAPTURE_HASH_ALGORITHM) throw integrityError();
  let body: JsonValue;
  if (encoding.effectiveRepresentation === "identity") body = toSafeJsonTree(original);
  else if (encoding.effectiveRepresentation === "full") body = toSafeJsonTree(encoding.effectivePayload);
  else {
    if (encoding.effectivePatchFormat !== REQUEST_CAPTURE_PATCH_FORMAT || !encoding.effectivePatch) throw integrityError();
    body = applyRequestCapturePatch(original, encoding.effectivePatch);
  }
  if (canonicalSha256(body) !== encoding.effectiveSha256) throw integrityError();
  return { status: "verified", representation: encoding.effectiveRepresentation, body };
}

export function canonicalSha256(value: JsonValue): string {
  const canonical = canonicalize(value);
  if (typeof canonical !== "string") throw codecError("capture_canonicalization_failed");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function toSafeJsonTree(input: unknown): JsonValue {
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): JsonValue {
    if (depth > REQUEST_CAPTURE_MAX_DEPTH) throw codecError("capture_patch_limit_exceeded");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw codecError("capture_encoding_failed");
      return value;
    }
    if (typeof value !== "object") throw codecError("capture_encoding_failed");
    if (seen.has(value)) throw codecError("capture_encoding_failed");
    seen.add(value);
    let result: JsonValue;
    if (Array.isArray(value)) result = value.map((item) => visit(item, depth + 1));
    else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw codecError("capture_encoding_failed");
      const object = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.keys(value)) object[key] = visit(Object.getOwnPropertyDescriptor(value, key)?.value, depth + 1);
      result = object;
    }
    seen.delete(value);
    return result;
  }
  return visit(input, 0);
}

export function applyRequestCapturePatch(original: JsonValue, operations: RequestCapturePatchOperation[]): JsonValue {
  validatePatch(operations);
  let root = toSafeJsonTree(original);
  for (const operation of operations) {
    const tokens = parsePointer(operation.path);
    if (tokens.length === 0) {
      if (operation.op === "remove") throw integrityError();
      root = toSafeJsonTree(operation.value);
      continue;
    }
    let parent: JsonValue = root;
    for (const token of tokens.slice(0, -1)) parent = childAt(parent, token);
    const key = tokens.at(-1)!;
    if (Array.isArray(parent)) applyArrayOperation(parent, key, operation);
    else if (isJsonObject(parent)) applyObjectOperation(parent, key, operation);
    else throw integrityError();
  }
  return root;
}

function validatePatch(value: unknown): asserts value is RequestCapturePatchOperation[] {
  if (!Array.isArray(value) || value.length > REQUEST_CAPTURE_MAX_PATCH_OPERATIONS) throw integrityError();
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > REQUEST_CAPTURE_MAX_PATCH_BYTES) throw integrityError();
  for (const operation of value) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw integrityError();
    const row = operation as Record<string, unknown>;
    if (row.op !== "add" && row.op !== "replace" && row.op !== "remove") throw integrityError();
    const expected = row.op === "remove" ? ["op", "path"] : ["op", "path", "value"];
    if (!expected.every((key) => Object.hasOwn(row, key)) || Object.keys(row).some((key) => !expected.includes(key))) throw integrityError();
    if (typeof row.path !== "string") throw integrityError();
    parsePointer(row.path);
    if (row.op !== "remove") toSafeJsonTree(row.value);
  }
}

function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw integrityError();
  const parts = pointer.slice(1).split("/");
  if (parts.length > REQUEST_CAPTURE_MAX_DEPTH) throw integrityError();
  return parts.map((part) => {
    if (/~(?:[^01]|$)/.test(part)) throw integrityError();
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function childAt(parent: JsonValue, key: string): JsonValue {
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length, false);
    return parent[index]!;
  }
  if (isJsonObject(parent) && Object.hasOwn(parent, key)) return parent[key]!;
  throw integrityError();
}

function applyArrayOperation(parent: JsonValue[], key: string, operation: RequestCapturePatchOperation): void {
  if (operation.op === "add") {
    const index = key === "-" ? parent.length : arrayIndex(key, parent.length, true);
    parent.splice(index, 0, toSafeJsonTree(operation.value));
  } else {
    const index = arrayIndex(key, parent.length, false);
    if (operation.op === "remove") parent.splice(index, 1);
    else parent[index] = toSafeJsonTree(operation.value);
  }
}

function applyObjectOperation(parent: Record<string, JsonValue>, key: string, operation: RequestCapturePatchOperation): void {
  if (operation.op === "remove") {
    if (!Object.hasOwn(parent, key)) throw integrityError();
    delete parent[key];
  } else {
    if (operation.op === "replace" && !Object.hasOwn(parent, key)) throw integrityError();
    Object.defineProperty(parent, key, { value: toSafeJsonTree(operation.value), enumerable: true, configurable: true, writable: true });
  }
}

function arrayIndex(value: string, length: number, allowEnd: boolean): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw integrityError();
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index > length || (!allowEnd && index === length)) throw integrityError();
  return index;
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqualJson(left: JsonValue, right: JsonValue): boolean {
  return canonicalize(left) === canonicalize(right);
}

function integrityError(): RelayError {
  return new RelayError("request_capture_integrity_failed", "Request capture integrity verification failed", 500);
}

function codecError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
