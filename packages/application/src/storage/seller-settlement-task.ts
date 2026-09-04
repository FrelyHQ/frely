import { randomBytes } from "node:crypto";
import type { ApplicationCommands, ApplicationTaskLease } from "./application-capabilities.js";

export interface TaskLeaseCoordinator {
  withRenewingLease<T>(
    input: { taskKey: string; ownerId: string; leaseDurationMs: number },
    callback: (lease: ApplicationTaskLease, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

export interface SellerSettlementOperations extends Pick<ApplicationCommands,
  "backfillPrepaidSellerSettlements" | "releaseDueSellerSettlements"
> {
  readonly taskLeases: TaskLeaseCoordinator;
}

export interface SellerSettlementTaskOptions {
  ownerId?: string;
  batchSize?: number;
  maxBatches?: number;
  leaseDurationMs?: number;
}

export interface SellerSettlementTaskResult {
  acquired: boolean;
  backfilledPurchases: number;
  backfillCompleted: boolean;
  selectedWindows: number;
  deferredWindows: number;
  releasedWindows: number;
  releasedUnits: number;
  ledgerEventIds: string[];
  batches: number;
}

const TASK_KEY = "seller-settlement-release";

export async function runSellerSettlementReleaseTask(
  operations: SellerSettlementOperations,
  options: SellerSettlementTaskOptions = {},
): Promise<SellerSettlementTaskResult> {
  const batchSize = boundedInteger(options.batchSize ?? 100, 1, 500, "seller_settlement_batch_invalid");
  const maxBatches = boundedInteger(options.maxBatches ?? 10, 1, 100, "seller_settlement_max_batches_invalid");
  const leaseDurationMs = boundedInteger(options.leaseDurationMs ?? 30_000, 5_000, 300_000, "seller_settlement_lease_duration_invalid");
  const ownerPrefix = options.ownerId?.trim() || defaultTaskOwnerPrefix();
  const ownerId = `${ownerPrefix}:${process.pid}:${randomBytes(8).toString("hex")}`;
  try {
    return await operations.taskLeases.withRenewingLease(
      { taskKey: TASK_KEY, ownerId, leaseDurationMs },
      async (lease, signal) => {
        const total: SellerSettlementTaskResult = {
          acquired: true,
          backfilledPurchases: 0,
          backfillCompleted: false,
          selectedWindows: 0,
          deferredWindows: 0,
          releasedWindows: 0,
          releasedUnits: 0,
          ledgerEventIds: [],
          batches: 0,
        };
        for (let batch = 0; batch < maxBatches; batch += 1) {
          if (signal.aborted) throw signal.reason ?? new Error("postgres_task_lease_lost");
          const backfillBatchSize = Math.min(batchSize, 10);
          const backfill = await operations.backfillPrepaidSellerSettlements(backfillBatchSize, lease);
          total.backfilledPurchases += backfill.backfilledPurchases;
          total.backfillCompleted = backfill.completed;
          if (backfill.completed) break;
        }
        if (!total.backfillCompleted) return total;
        for (let batch = 0; batch < maxBatches; batch += 1) {
          if (signal.aborted) throw signal.reason ?? new Error("postgres_task_lease_lost");
          const result = await operations.releaseDueSellerSettlements(undefined, lease, batchSize);
          total.batches += 1;
          total.selectedWindows += result.selectedWindows;
          total.deferredWindows += result.deferredWindows;
          total.releasedWindows += result.releasedWindows;
          total.releasedUnits += result.releasedUnits;
          total.ledgerEventIds.push(...result.ledgerEventIds);
          if (result.selectedWindows < batchSize || (result.releasedWindows === 0 && result.deferredWindows === 0)) break;
        }
        return total;
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "postgres_task_lease_busy") {
      return { acquired: false, backfilledPurchases: 0, backfillCompleted: false, selectedWindows: 0, deferredWindows: 0, releasedWindows: 0, releasedUnits: 0, ledgerEventIds: [], batches: 0 };
    }
    throw error;
  }
}

function defaultTaskOwnerPrefix(): string {
  const instance = process.env.FRIDAY_RELAY_INSTANCE_ID?.trim() || process.env.FRIDAY_RELAY_DEPLOYMENT_ENVIRONMENT?.trim() || "local";
  return `settlement:${instance}`;
}

function boundedInteger(value: number, minimum: number, maximum: number, errorCode: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(errorCode);
  return value;
}
