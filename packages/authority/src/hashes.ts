import { createHash } from "node:crypto";
import { RelayError } from "@frely/core";

export function authorityOperationHash(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new RelayError("authority_idempotency_key_invalid", "Idempotency-Key is required", 400);
  return createHash("sha256").update(normalized).digest("hex");
}

export function authorityRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
