import { lstatSync } from "node:fs";
import type { AppConfig } from "@frely/config";
import {
  REQUEST_LIFECYCLE_ABANDONED_ERROR_CODE,
  RequestCaptureV3Storage,
} from "@frely/capture";
import type { PostgresClientOwner, PostgresTransactionContext } from "@frely/postgres/server";

export type StaleRequestLogBlockerCode =
  | "active_execution_lease"
  | "request_execution_present"
  | "provider_attempt_present"
  | "billing_fact_present"
  | "mcp_execution_present"
  | "capture_staging_present"
  | "capture_terminal_present"
  | "state_changed";

export interface StaleRequestLogReconciliationResult {
  archiveMonth: string;
  cutoff: string;
  examined: number;
  reconciled: number;
  blockerCounts: Partial<Record<StaleRequestLogBlockerCode, number>>;
}

interface Candidate {
  id: string;
  started_at: string;
}

interface LockedRequestLog {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
}

interface EvidenceRow {
  request_execution_present: boolean;
  request_execution_terminal_without_output: boolean;
  provider_attempt_present: boolean;
  provider_attempts_predispatch_only: boolean;
  provider_attempts_terminal_without_output: boolean;
  budget_claim_present: boolean;
  settlement_fact_present: boolean;
  mcp_execution_present: boolean;
}

export async function reconcileStaleStartedRequestLogs(input: {
  client: PostgresClientOwner;
  config: AppConfig;
  month: string;
  now?: Date;
  limit?: number;
}): Promise<StaleRequestLogReconciliationResult> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw reconciliationError("request_log_reconciliation_now_invalid");
  const plan = monthCutoff(input.month, now);
  const nowIso = now.toISOString();
  const staleAfterSeconds = input.config.requestExecution.staleAfterSeconds;
  const staleCutoff = new Date(now.getTime() - staleAfterSeconds * 1_000).toISOString();
  const cutoff = staleCutoff < plan.lt ? staleCutoff : plan.lt;
  const limit = input.limit ?? input.config.archive.history.purgeBatchSize;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw reconciliationError("request_log_reconciliation_limit_invalid");
  }
  const candidates = (await input.client.query<Candidate>(`
    SELECT "id", "started_at"
    FROM "request_logs"
    WHERE "status" = 'started' AND "ended_at" IS NULL
      AND "started_at" >= $1 AND "started_at" < $2
    ORDER BY "started_at", "id"
    LIMIT $3
  `, [plan.gte, cutoff, limit])).rows;
  const storage = new RequestCaptureV3Storage({
    archiveDirectory: input.config.archive.directory,
    ...(input.config.archive.coldDirectory ? { coldDirectory: input.config.archive.coldDirectory } : {}),
    requireColdMount: input.config.archive.requireColdMount,
    hotDays: input.config.requestCapture.hotDays,
  });
  const blockerCounts: StaleRequestLogReconciliationResult["blockerCounts"] = {};
  let reconciled = 0;
  for (const candidate of candidates) {
    const outcome = await input.client.withTransaction((transaction) => reconcileCandidate({
      transaction,
      storage,
      candidate,
      monthGte: plan.gte,
      cutoff,
      nowIso,
    }));
    if (outcome === "reconciled") reconciled += 1;
    else blockerCounts[outcome] = (blockerCounts[outcome] ?? 0) + 1;
  }
  return {
    archiveMonth: input.month,
    cutoff,
    examined: candidates.length,
    reconciled,
    blockerCounts,
  };
}

async function reconcileCandidate(input: {
  transaction: PostgresTransactionContext;
  storage: RequestCaptureV3Storage;
  candidate: Candidate;
  monthGte: string;
  cutoff: string;
  nowIso: string;
}): Promise<StaleRequestLogBlockerCode | "reconciled"> {
  const current = (await input.transaction.query<LockedRequestLog>(`
    SELECT "id", "status", "started_at", "ended_at"
    FROM "request_logs" WHERE "id" = $1 FOR UPDATE
  `, [input.candidate.id])).rows[0];
  if (!current
    || current.status !== "started"
    || current.ended_at !== null
    || current.started_at < input.monthGte
    || current.started_at >= input.cutoff) {
    return "state_changed";
  }
  const activeLease = (await input.transaction.query<{ present: boolean }>(`
    SELECT EXISTS(
      SELECT 1 FROM "request_execution_leases"
      WHERE "request_id" = $1 AND "lease_until" > $2
    ) AS present
  `, [current.id, input.nowIso])).rows[0]?.present === true;
  if (activeLease) return "active_execution_lease";

  const evidence = (await input.transaction.query<EvidenceRow>(`
    SELECT
      EXISTS(SELECT 1 FROM "request_executions" WHERE "request_id" = $1) AS request_execution_present,
      EXISTS(
        SELECT 1 FROM "request_executions"
        WHERE "request_id" = $1 AND "status" IN ('failed', 'aborted')
          AND "ended_at" IS NOT NULL AND "output_committed" = 0
      ) AS request_execution_terminal_without_output,
      EXISTS(SELECT 1 FROM "request_provider_attempts" WHERE "request_id" = $1) AS provider_attempt_present,
      (
        EXISTS(SELECT 1 FROM "request_provider_attempts" WHERE "request_id" = $1)
        AND NOT EXISTS(
          SELECT 1 FROM "request_provider_attempts"
          WHERE "request_id" = $1 AND (
            "outcome" <> 'pending' OR "ended_at" IS NOT NULL OR "output_committed" <> 0
            OR "cost_exposure" <> 'not_started' OR "final_usage_evidence" <> 'pending'
            OR "usage_settled" <> 0 OR "reconciliation_reason" IS NOT NULL
            OR "admission_lease_until" > $2
          )
        )
      ) AS provider_attempts_predispatch_only,
      (
        EXISTS(SELECT 1 FROM "request_provider_attempts" WHERE "request_id" = $1)
        AND NOT EXISTS(
          SELECT 1 FROM "request_provider_attempts"
          WHERE "request_id" = $1 AND (
            "outcome" NOT IN ('failed', 'aborted') OR "ended_at" IS NULL OR "output_committed" <> 0
          )
        )
      ) AS provider_attempts_terminal_without_output,
      EXISTS(SELECT 1 FROM "budget_claims" WHERE "request_id" = $1) AS budget_claim_present,
      (
        EXISTS(SELECT 1 FROM "billing_events" WHERE "request_id" = $1)
        OR EXISTS(SELECT 1 FROM "billing_access_point_edges" WHERE "request_id" = $1)
        OR EXISTS(SELECT 1 FROM "billing_provider_cost_events" WHERE "request_id" = $1)
        OR EXISTS(SELECT 1 FROM "usage_reservations" WHERE "request_id" = $1)
        OR EXISTS(
          SELECT 1 FROM "provider_invocation_usage_facts" AS usage
          INNER JOIN "request_provider_attempts" AS attempt ON attempt."id" = usage."provider_attempt_id"
          WHERE attempt."request_id" = $1
        )
      ) AS settlement_fact_present,
      EXISTS(SELECT 1 FROM "mcp_orchestration_runs" WHERE "request_id" = $1) AS mcp_execution_present
  `, [current.id, input.nowIso])).rows[0];
  if (!evidence) return "state_changed";
  if (evidence.mcp_execution_present) return "mcp_execution_present";
  if (input.storage.hasStagingExchange(current.id)) return "capture_staging_present";
  if (lstatSync(input.storage.pathForRequest(current.started_at, current.id), { throwIfNoEntry: false })) {
    return "capture_terminal_present";
  }
  const abandonedBeforeDispatch = !evidence.request_execution_present
    && evidence.provider_attempts_predispatch_only
    && !evidence.budget_claim_present
    && !evidence.settlement_fact_present;
  const terminalProjectionLost = evidence.request_execution_terminal_without_output
    && evidence.provider_attempts_terminal_without_output
    && !evidence.settlement_fact_present;
  if (evidence.request_execution_present && !terminalProjectionLost) return "request_execution_present";
  if (evidence.provider_attempt_present && !abandonedBeforeDispatch && !terminalProjectionLost) return "provider_attempt_present";
  if ((evidence.budget_claim_present || evidence.settlement_fact_present) && !terminalProjectionLost) {
    return "billing_fact_present";
  }

  const updated = await input.transaction.query<{ id: string }>(`
    UPDATE "request_logs"
    SET "status" = 'failed',
      "error_code" = $2,
      "ended_at" = $3,
      "pipeline_plugins_json" = CASE
        WHEN "pipeline_plugins_json" = '{"schemaVersion":1,"planRevision":"pending","invocations":[]}'
        THEN '{"schemaVersion":1,"planRevision":"request-lifecycle-reconciliation-v1","invocations":[]}'
        ELSE "pipeline_plugins_json"
      END
    WHERE "id" = $1 AND "status" = 'started' AND "ended_at" IS NULL
      AND "started_at" >= $4 AND "started_at" < $5
      AND NOT EXISTS(
        SELECT 1 FROM "request_execution_leases" AS lease
        WHERE lease."request_id" = "request_logs"."id" AND lease."lease_until" > $3
      )
    RETURNING "id"
  `, [current.id, REQUEST_LIFECYCLE_ABANDONED_ERROR_CODE, input.nowIso, input.monthGte, input.cutoff]);
  if (updated.rowCount !== 1) return "state_changed";
  await input.transaction.query(`
    DELETE FROM "request_execution_leases"
    WHERE "request_id" = $1 AND "lease_until" <= $2
  `, [current.id, input.nowIso]);
  return "reconciled";
}

function monthCutoff(month: string, now: Date): { gte: string; lt: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) {
    throw reconciliationError("request_log_reconciliation_month_invalid");
  }
  const gte = `${month}-01T00:00:00.000Z`;
  const end = new Date(gte);
  if (end.toISOString().slice(0, 7) !== month) {
    throw reconciliationError("request_log_reconciliation_month_invalid");
  }
  end.setUTCMonth(end.getUTCMonth() + 1);
  const lt = end.toISOString();
  if (lt > now.toISOString()) throw reconciliationError("request_log_reconciliation_month_not_complete");
  return { gte, lt };
}

function reconciliationError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
