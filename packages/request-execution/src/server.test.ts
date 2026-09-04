import { describe, expect, test, vi } from "vitest";
import type { Prisma } from "@frely/postgres/server";
import { FinalizeProviderInvocation } from "./server.js";

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    providerAttemptRef: "pat_1",
    requestId: "req_1",
    invocationContract: "cpa-basic@1",
    startedAt: "2026-08-31T00:00:00.000Z",
    outcome: "pending",
    failureClass: null,
    failureReason: null,
    outputCommitted: 0,
    usageSettled: 0,
    reconciliationReason: null,
    requestEndedAt: null,
    ...overrides,
  };
}

function transaction(row: ReturnType<typeof attempt>) {
  const update = vi.fn(async () => undefined);
  return {
    value: {
      $queryRaw: vi.fn(async () => [row]),
      request_provider_attempts: { update },
    } as unknown as Prisma.TransactionClient,
    update,
  };
}

const failedCommand = {
  providerAttemptRef: "pat_1",
  outcome: "failed" as const,
  failureClass: "non_retryable" as const,
  failureReason: "auth_unauthorized" as const,
  outputCommitted: false,
  trustedUsageSource: "provider" as const,
};

describe("ProviderAttempt credential failure reason", () => {
  test("writes the allowlisted reason atomically with terminal evidence", async () => {
    const fixture = transaction(attempt());
    const command = new FinalizeProviderInvocation();
    const decision = await command.lock(fixture.value, failedCommand, false);
    await command.complete(fixture.value, decision, failedCommand, "2026-08-31T00:00:01.000Z");

    expect(decision.expectedFailureReason).toBe("auth_unauthorized");
    expect(fixture.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "pat_1" },
      data: expect.objectContaining({
        outcome: "failed",
        failure_class: "non_retryable",
        failure_reason: "auth_unauthorized",
        usage_settled: 1,
      }),
    }));
  });

  test("preserves an existing terminal reason when a legacy caller omits it", async () => {
    const fixture = transaction(attempt({
      outcome: "failed",
      failureClass: "non_retryable",
      failureReason: "auth_unauthorized",
      usageSettled: 1,
      requestEndedAt: "2026-08-31T00:00:01.000Z",
    }));
    const decision = await new FinalizeProviderInvocation().lock(fixture.value, {
      providerAttemptRef: "pat_1",
      outcome: "failed",
      failureClass: "non_retryable",
      outputCommitted: false,
      trustedUsageSource: "provider",
    }, false);

    expect(decision).toMatchObject({ expectedFailureReason: "auth_unauthorized", alreadyFinalized: true });
  });

  test("rejects a terminal reason rewrite", async () => {
    const fixture = transaction(attempt({
      outcome: "failed",
      failureClass: "non_retryable",
      failureReason: "auth_unauthorized",
      requestEndedAt: "2026-08-31T00:00:01.000Z",
    }));
    await expect(new FinalizeProviderInvocation().lock(fixture.value, {
      ...failedCommand,
      failureReason: "auth_not_found",
    }, false)).rejects.toMatchObject({ code: "provider_attempt_settlement_conflict" });
  });
});
