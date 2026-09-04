import { describe, expect, test, vi } from "vitest";
import type { SellerSettlementOperations } from "@frely/application/runtime";
import { runSellerSettlementReleaseTask } from "@frely/application/runtime";

describe("Seller settlement one-shot lease task", () => {
  test("runs bounded batches under one renewing task lease", async () => {
    const release = vi.fn()
      .mockResolvedValueOnce({ selectedWindows: 2, deferredWindows: 0, releasedWindows: 2, releasedUnits: 30, ledgerEventIds: ["l1", "l2"] })
      .mockResolvedValueOnce({ selectedWindows: 1, deferredWindows: 1, releasedWindows: 0, releasedUnits: 0, ledgerEventIds: [] });
    const repository = {
      taskLeases: {
        withRenewingLease: async (_input: unknown, callback: (lease: object, signal: AbortSignal) => Promise<unknown>) => callback(
          { taskKey: "seller-settlement-release", ownerId: "owner", fencingToken: 1, leaseUntilMs: 9999 },
          new AbortController().signal,
        ),
      },
      backfillPrepaidSellerSettlements: vi.fn().mockResolvedValue({ backfilledPurchases: 1, completed: true }),
      releaseDueSellerSettlements: release,
    } as unknown as SellerSettlementOperations;
    await expect(runSellerSettlementReleaseTask(repository, { ownerId: "owner", batchSize: 2, maxBatches: 3 })).resolves.toEqual({
      acquired: true, backfilledPurchases: 1, backfillCompleted: true, selectedWindows: 3, deferredWindows: 1, releasedWindows: 2,
      releasedUnits: 30, ledgerEventIds: ["l1", "l2"], batches: 2,
    });
    expect(release).toHaveBeenCalledTimes(2);
  });

  test("does not release windows until historical prepaid backfill is complete", async () => {
    const release = vi.fn();
    const repository = {
      taskLeases: {
        withRenewingLease: async (_input: unknown, callback: (lease: object, signal: AbortSignal) => Promise<unknown>) => callback(
          { taskKey: "seller-settlement-release", ownerId: "owner", fencingToken: 1, leaseUntilMs: 9999 },
          new AbortController().signal,
        ),
      },
      backfillPrepaidSellerSettlements: vi.fn().mockResolvedValue({ backfilledPurchases: 10, completed: false }),
      releaseDueSellerSettlements: release,
    } as unknown as SellerSettlementOperations;
    await expect(runSellerSettlementReleaseTask(repository, { ownerId: "owner", batchSize: 100, maxBatches: 1 })).resolves.toMatchObject({
      acquired: true, backfilledPurchases: 10, backfillCompleted: false, releasedWindows: 0,
    });
    expect(release).not.toHaveBeenCalled();
  });

  test("reports lease contention as a completed no-op", async () => {
    const repository = {
      taskLeases: { withRenewingLease: async () => { throw new Error("postgres_task_lease_busy"); } },
    } as unknown as SellerSettlementOperations;
    await expect(runSellerSettlementReleaseTask(repository, { ownerId: "owner" })).resolves.toMatchObject({ acquired: false, batches: 0 });
  });
});
