import type { AuditMetadataValue } from "@frely/audit";
import { RelayError } from "@frely/core";
import { normalizePublicHostname } from "@frely/ui-application/server";

export function assertExactKeys(body: unknown, allowed: readonly string[]): asserts body is Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RelayError("invalid_public_host_body", `Body must contain only ${allowed.join(", ")}`, 400);
  }
  const keys = Object.keys(body);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new RelayError("invalid_public_host_body", `Body must contain only ${allowed.join(", ")}`, 400);
  }
}

export function bodyField(body: unknown, key: string): unknown {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

export function failureMetadata(routePattern: string, hostname: unknown, error: unknown): Readonly<Record<string, AuditMetadataValue>> {
  let normalized: string | undefined;
  try { normalized = normalizePublicHostname(hostname); } catch { /* invalid input is intentionally omitted */ }
  const conflictKind = error instanceof RelayError && typeof error.details.conflictKind === "string" ? error.details.conflictKind : undefined;
  return {
    routePattern,
    ...(normalized ? { hostname: normalized } : {}),
    ...(conflictKind ? { conflictKind } : {})
  };
}
