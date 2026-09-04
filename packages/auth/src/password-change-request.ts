import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { AppConfig } from "@frely/config";
import { RelayError, resolveExternalRequestOrigin } from "@frely/core";
import { createValidatedAuthMutationRequest } from "./auth-mutation-request.js";

const PASSWORD_CHANGE_BODY_LIMIT = 4096;

export interface PasswordChangeRequestBody {
  currentPassword: string;
  newPassword: string;
}

export function assertPasswordChangeRequestOrigin(request: Request, config: AppConfig, expectedOrigin?: string): void {
  const externalOrigin = resolveExternalRequestOrigin(request);
  if (config.app.environment === "production" && (!externalOrigin || new URL(externalOrigin).protocol !== "https:")) {
    throw new RelayError("request_origin_forbidden", "Request origin is not allowed", 403);
  }
  if (!request.headers.get("origin")) {
    throw new RelayError("request_origin_forbidden", "Request origin is not allowed", 403);
  }
  createValidatedAuthMutationRequest(request, expectedOrigin);
}

export async function readPasswordChangeRequestBody(request: Request): Promise<PasswordChangeRequestBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu.test(contentType)) {
    throw new RelayError("unsupported_media_type", "Content-Type must be application/json", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^[0-9]+$/u.test(declaredLength)) throw new RelayError("invalid_request_body", "Request body is invalid", 400);
    if (Number(declaredLength) > PASSWORD_CHANGE_BODY_LIMIT) {
      throw new RelayError("request_body_too_large", "Request body is too large", 413);
    }
  }

  const bodyBytes = await readLimitedBody(request, PASSWORD_CHANGE_BODY_LIMIT);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes));
  } catch {
    throw new RelayError("invalid_request_body", "Request body is invalid", 400);
  }
  if (!isStrictPasswordChangeBody(value)) {
    throw new RelayError("invalid_request_body", "Request body is invalid", 400);
  }
  return value;
}

export function passwordChangeRateLimitSubjects(
  config: AppConfig,
  headers: Headers,
  userId: string
): { user: string; clientIp: string } {
  const candidate = headers.get("x-real-ip")?.trim() ?? "";
  const canonicalClient = candidate.length <= 64 ? canonicalIp(candidate) ?? "unknown-client" : "unknown-client";
  return {
    user: passwordChangeSubject(config.auth.jwtSecret, "user_id", userId),
    clientIp: passwordChangeSubject(config.auth.jwtSecret, "client_ip", canonicalClient)
  };
}

async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw new RelayError("request_body_too_large", "Request body is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function isStrictPasswordChangeBody(value: unknown): value is PasswordChangeRequestBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2
    && keys.includes("currentPassword")
    && keys.includes("newPassword")
    && typeof record.currentPassword === "string"
    && typeof record.newPassword === "string";
}

function passwordChangeSubject(secret: string, type: "user_id" | "client_ip", value: string): string {
  const digest = createHmac("sha256", secret)
    .update(`auth.password_change:${type}\0${value}`)
    .digest("hex");
  return `${type}:${digest}`;
}

function canonicalIp(value: string): string | null {
  const family = isIP(value);
  if (family === 4) return value.split(".").map((part) => String(Number(part))).join(".");
  if (family !== 6) return null;
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return null;
  }
}
