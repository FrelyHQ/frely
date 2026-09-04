import type { AuditCommands } from "@frely/audit/server";
import { RelayError } from "@frely/core";
import { Prisma, type PrismaTransactionOwner } from "@frely/postgres/server";
import { bindRequestExecutionQueries } from "@frely/request-execution/application-internal";
import type {
  RequestExecutionQueries,
  RequestExecutionReconciliationReadWorkflow,
  UnresolvedProviderInvocation,
} from "../../request-execution.js";

interface UsageReconciliationOccupation {
  billableInvocationRef: string;
  reservationStatus: string | null;
  heldUnits: bigint | null;
  maximumTokens: bigint;
  maximumChargeUnits: bigint;
}

/** Read-only Provider Invocation projection with no command service or write participant. */
export class ProviderInvocationQueryService implements RequestExecutionQueries {
  constructor(private readonly transactions: PrismaTransactionOwner) {}

  getRequestExecutionDetail(requestId: string, attemptLimit = 100) {
    return this.transactions.withPrismaTransaction(
      (transaction) => bindRequestExecutionQueries(transaction).getDetail(requestId, attemptLimit),
      1,
      { isolationLevel: "ReadCommitted", statementTimeoutMillis: 5_000 },
    );
  }

  listUnresolved(limit = 100): Promise<UnresolvedProviderInvocation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RelayError("invalid_reconciliation_limit", "Reconciliation limit must be between 1 and 500", 400);
    }
    return this.transactions.withPrismaTransaction(async (transaction) => {
      const attempts = await bindRequestExecutionQueries(transaction).listUnresolved(limit);
      const refs = attempts.map((attempt) => attempt.providerAttemptRef);
      const occupations = refs.length === 0
        ? []
        : await transaction.$queryRaw<UsageReconciliationOccupation[]>(Prisma.sql`
            SELECT claim."provider_attempt_id" AS "billableInvocationRef",
                   reservation."status" AS "reservationStatus",
                   reservation."held_units" AS "heldUnits",
                   claim."max_total_tokens" AS "maximumTokens",
                   claim."max_charge_units" AS "maximumChargeUnits"
            FROM "budget_claims" claim
            LEFT JOIN "usage_reservations" reservation
              ON reservation."provider_attempt_id" = claim."provider_attempt_id"
            WHERE claim."provider_attempt_id" IN (${Prisma.join(refs)})
            ORDER BY claim."created_at" ASC, claim."provider_attempt_id" ASC
          `);
      const occupationByRef = new Map(occupations.map((occupation) => [occupation.billableInvocationRef, occupation]));
      return attempts.map((attempt): UnresolvedProviderInvocation => {
        const occupation = occupationByRef.get(attempt.providerAttemptRef);
        if (!occupation && attempt.invocationContract !== "cpa-basic@1") {
          throw new RelayError("provider_invocation_reconciliation_incomplete", "Unresolved protected ProviderAttempt has no Billing occupation", 500);
        }
        return {
          providerAttemptId: attempt.providerAttemptRef,
          requestId: attempt.requestId,
          invocationContract: attempt.invocationContract,
          providerId: attempt.providerId,
          providerModelName: attempt.providerModelName,
          startedAt: attempt.startedAt,
          outcome: attempt.outcome,
          failureClass: attempt.failureClass,
          failureReason: attempt.failureReason,
          costExposure: attempt.costExposure,
          reconciliationReason: attempt.reconciliationReason,
          maxTotalTokens: occupation?.maximumTokens ?? null,
          maxChargeUnits: occupation?.maximumChargeUnits ?? null,
          reservationStatus: occupation?.reservationStatus ?? null,
          heldUnits: occupation?.heldUnits ?? null,
        };
      });
    }, 1, { isolationLevel: "ReadCommitted", statementTimeoutMillis: 5_000 });
  }
}

/** Explicit side-effecting workflow for the sensitive unresolved-invocation read. */
export class ProviderInvocationReconciliationReadWorkflow implements RequestExecutionReconciliationReadWorkflow {
  constructor(
    private readonly queries: RequestExecutionQueries,
    private readonly audit: AuditCommands,
  ) {}

  async execute(input: Parameters<RequestExecutionReconciliationReadWorkflow["execute"]>[0]): Promise<UnresolvedProviderInvocation[]> {
    try {
      const items = await this.queries.listUnresolved(input.limit);
      await this.audit.record({
        actor: input.actor,
        source: "owner",
        requestId: input.requestId,
        action: "provider_invocation.reconciliation_read",
        resourceType: "provider_invocation",
        resourceId: "unresolved",
        result: "success",
        metadata: {
          routePattern: "/api/owner/provider-invocations/unresolved",
          count: items.length,
          limit: input.limit,
        },
      });
      return items;
    } catch (error) {
      await this.audit.record({
        actor: input.actor,
        source: "owner",
        requestId: input.requestId,
        action: "provider_invocation.reconciliation_read",
        resourceType: "provider_invocation",
        resourceId: "unresolved",
        result: "failure",
        metadata: {
          routePattern: "/api/owner/provider-invocations/unresolved",
          limit: input.limit,
          errorCode: error instanceof RelayError ? error.code : "internal_error",
        },
      });
      throw error;
    }
  }
}
