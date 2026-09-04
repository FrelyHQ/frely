import { createHash } from "node:crypto";
import type { PostgresQueryObservation } from "@frely/postgres/server";

/**
 * Disposable-verifier-only SQL evidence. The verifier records a digest of the
 * statement shape, never the SQL text or its bound values.
 */
export interface SqlShapeInventory {
  readonly statementCount: number;
  readonly shapeDigests: readonly string[];
  readonly totalQueryDurationMs: number;
  readonly maxQueryDurationMs: number;
}

export class SqlShapeCollector {
  private count = 0;
  private totalDurationMs = 0;
  private maxDurationMs = 0;
  private readonly digests: string[] = [];

  record(observation: PostgresQueryObservation): void {
    this.count += 1;
    const duration = Number.isFinite(observation.duration) && observation.duration >= 0 ? observation.duration : 0;
    this.totalDurationMs += duration;
    this.maxDurationMs = Math.max(this.maxDurationMs, duration);
    this.digests.push(sqlShapeDigest(observation.query));
  }

  snapshot(): SqlShapeInventory {
    return Object.freeze({
      statementCount: this.count,
      shapeDigests: Object.freeze([...this.digests]),
      totalQueryDurationMs: Math.round(this.totalDurationMs),
      maxQueryDurationMs: Math.round(this.maxDurationMs),
    });
  }
}

function sqlShapeDigest(query: string): string {
  const shape = query
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/--[^\r\n]*/gu, " ")
    .replace(/\$\d+/gu, "$?")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return createHash("sha256").update(shape).digest("hex").slice(0, 16);
}
