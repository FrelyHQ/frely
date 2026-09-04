-- C2 expand/mixed-version: persist the stable ProviderModel identity on each
-- ProviderAttempt and the selected Plan source on each RequestExecution while
-- retaining the legacy Provider/name projection for old readers and writers.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "request_provider_attempts" attempt
    LEFT JOIN "provider_models" model
      ON model."provider_id" = attempt."provider_id"
     AND model."provider_model_name" = attempt."provider_model_name"
    WHERE model."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'ProviderAttempt cannot resolve a stable ProviderModelId'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "provider_invocation_usage_facts" fact
    INNER JOIN "request_provider_attempts" attempt
      ON attempt."id" = fact."provider_attempt_id"
    WHERE fact."request_id" IS DISTINCT FROM attempt."request_id"
  ) THEN
    RAISE EXCEPTION 'Provider invocation usage fact request does not match ProviderAttempt'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "budget_claims" claim
    INNER JOIN "request_provider_attempts" attempt
      ON attempt."id" = claim."provider_attempt_id"
    WHERE claim."request_id" IS DISTINCT FROM attempt."request_id"
  ) THEN
    RAISE EXCEPTION 'BudgetClaim request does not match ProviderAttempt'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH selected_sources AS (
      SELECT attempt."request_id", fact."plan_subscription_id"
      FROM "request_provider_attempts" attempt
      INNER JOIN "provider_invocation_usage_facts" fact
        ON fact."provider_attempt_id" = attempt."id"
      UNION ALL
      SELECT attempt."request_id", claim."plan_subscription_id"
      FROM "request_provider_attempts" attempt
      INNER JOIN "budget_claims" claim
        ON claim."provider_attempt_id" = attempt."id"
    )
    SELECT execution."request_id"
    FROM "request_executions" execution
    LEFT JOIN selected_sources source
      ON source."request_id" = execution."request_id"
    GROUP BY execution."request_id"
    HAVING COUNT(DISTINCT source."plan_subscription_id") <> 1
  ) THEN
    RAISE EXCEPTION 'RequestExecution cannot resolve exactly one selected Plan Subscription'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH selected_sources AS (
      SELECT attempt."request_id", fact."plan_subscription_id"
      FROM "request_provider_attempts" attempt
      INNER JOIN "provider_invocation_usage_facts" fact
        ON fact."provider_attempt_id" = attempt."id"
      UNION ALL
      SELECT attempt."request_id", claim."plan_subscription_id"
      FROM "request_provider_attempts" attempt
      INNER JOIN "budget_claims" claim
        ON claim."provider_attempt_id" = attempt."id"
    ), unique_sources AS (
      SELECT "request_id", MIN("plan_subscription_id") AS "plan_subscription_id"
      FROM selected_sources
      GROUP BY "request_id"
      HAVING COUNT(DISTINCT "plan_subscription_id") = 1
    )
    SELECT execution."request_id"
    FROM "request_executions" execution
    INNER JOIN unique_sources source
      ON source."request_id" = execution."request_id"
    INNER JOIN "request_logs" request_log
      ON request_log."id" = execution."request_id"
    WHERE request_log."plan_subscription_id" IS NOT NULL
      AND request_log."plan_subscription_id" IS DISTINCT FROM source."plan_subscription_id"
  ) THEN
    RAISE EXCEPTION 'RequestLog Plan Subscription does not match RequestExecution selected source'
      USING ERRCODE = '23514';
  END IF;
END $$;

ALTER TABLE "request_provider_attempts"
  ADD COLUMN "provider_model_id" text COLLATE "C";
ALTER TABLE "request_executions"
  ADD COLUMN "selected_plan_subscription_id" text COLLATE "C";

-- ProviderAttempt identity is immutable. Disable its guard only for this
-- bounded backfill, then restore the same mutable-field allowance.
DROP TRIGGER "request_provider_attempts_immutable_update" ON "request_provider_attempts";

UPDATE "request_provider_attempts" attempt
SET "provider_model_id" = model."id"
FROM "provider_models" model
WHERE model."provider_id" = attempt."provider_id"
  AND model."provider_model_name" = attempt."provider_model_name";

ALTER TABLE "request_provider_attempts"
  ALTER COLUMN "provider_model_id" SET NOT NULL;

CREATE OR REPLACE FUNCTION "friday_relay_resolve_provider_attempt_provider_model"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  resolved_provider_model_id text;
BEGIN
  SELECT model."id"
  INTO resolved_provider_model_id
  FROM "provider_models" model
  WHERE model."provider_id" = NEW."provider_id"
    AND model."provider_model_name" = NEW."provider_model_name";

  IF resolved_provider_model_id IS NULL THEN
    RAISE EXCEPTION 'ProviderAttempt cannot resolve ProviderModelId'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."provider_model_id" IS NULL THEN
    NEW."provider_model_id" := resolved_provider_model_id;
  ELSIF NEW."provider_model_id" IS DISTINCT FROM resolved_provider_model_id THEN
    RAISE EXCEPTION 'ProviderAttempt ProviderModelId does not match the legacy Provider/model reference'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "request_provider_attempts_provider_model_reference"
  BEFORE INSERT ON "request_provider_attempts"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_resolve_provider_attempt_provider_model"();

CREATE TRIGGER "request_provider_attempts_immutable_update"
  BEFORE UPDATE ON "request_provider_attempts"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_immutable_update"(
    'Provider Attempt identity cannot be updated',
    'outcome', 'failure_class', 'output_committed', 'trusted_usage_source', 'ended_at',
    'cost_exposure', 'final_usage_evidence', 'usage_settled', 'reconciliation_reason'
  );

ALTER TABLE "request_provider_attempts"
  ADD CONSTRAINT "request_provider_attempts_provider_model_fk"
    FOREIGN KEY ("provider_model_id") REFERENCES "provider_models" ("id")
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "request_provider_attempts_provider_model_started_idx"
  ON "request_provider_attempts" ("provider_model_id", "started_at", "id");

-- Settled history derives the selected Plan source from the immutable usage
-- fact. A currently unresolved execution has no usage fact yet, so its unique
-- BudgetClaim supplies the same admitted source during the mixed-version
-- backfill and for old writers.
WITH selected_sources AS (
  SELECT attempt."request_id", fact."plan_subscription_id"
  FROM "request_provider_attempts" attempt
  INNER JOIN "provider_invocation_usage_facts" fact
    ON fact."provider_attempt_id" = attempt."id"
  UNION ALL
  SELECT attempt."request_id", claim."plan_subscription_id"
  FROM "request_provider_attempts" attempt
  INNER JOIN "budget_claims" claim
    ON claim."provider_attempt_id" = attempt."id"
), unique_sources AS (
  SELECT "request_id", MIN("plan_subscription_id") AS "plan_subscription_id"
  FROM selected_sources
  GROUP BY "request_id"
  HAVING COUNT(DISTINCT "plan_subscription_id") = 1
)
UPDATE "request_executions" execution
SET "selected_plan_subscription_id" = source."plan_subscription_id"
FROM unique_sources source
WHERE source."request_id" = execution."request_id";

CREATE OR REPLACE FUNCTION "friday_relay_guard_request_execution_plan_source"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_log_plan_subscription_id text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."selected_plan_subscription_id" IS NOT NULL
     AND NEW."selected_plan_subscription_id" IS DISTINCT FROM OLD."selected_plan_subscription_id"
  THEN
    RAISE EXCEPTION 'RequestExecution selected Plan Subscription is immutable once selected'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."selected_plan_subscription_id" IS NOT NULL THEN
    SELECT request_log."plan_subscription_id"
    INTO request_log_plan_subscription_id
    FROM "request_logs" request_log
    WHERE request_log."id" = NEW."request_id";
    IF FOUND
       AND request_log_plan_subscription_id IS NOT NULL
       AND request_log_plan_subscription_id IS DISTINCT FROM NEW."selected_plan_subscription_id"
    THEN
      RAISE EXCEPTION 'RequestExecution selected Plan Subscription does not match RequestLog projection'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "request_executions_plan_source_insert_guard"
  BEFORE INSERT ON "request_executions"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_request_execution_plan_source"();
CREATE TRIGGER "request_executions_plan_source_update_guard"
  BEFORE UPDATE OF "selected_plan_subscription_id" ON "request_executions"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_request_execution_plan_source"();

CREATE OR REPLACE FUNCTION "friday_relay_guard_request_log_plan_source"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  execution_plan_subscription_id text;
BEGIN
  SELECT execution."selected_plan_subscription_id"
  INTO execution_plan_subscription_id
  FROM "request_executions" execution
  WHERE execution."request_id" = NEW."id";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF OLD."plan_subscription_id" IS NOT NULL
     AND NEW."plan_subscription_id" IS DISTINCT FROM OLD."plan_subscription_id"
  THEN
    RAISE EXCEPTION 'RequestLog Plan Subscription projection is immutable once selected'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."plan_subscription_id" IS NOT NULL
     AND (execution_plan_subscription_id IS NULL
       OR NEW."plan_subscription_id" IS DISTINCT FROM execution_plan_subscription_id)
  THEN
    RAISE EXCEPTION 'RequestLog Plan Subscription does not match RequestExecution selected source'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "request_logs_plan_source_projection_guard"
  BEFORE UPDATE OF "plan_subscription_id" ON "request_logs"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_request_log_plan_source"();

CREATE OR REPLACE FUNCTION "friday_relay_sync_request_execution_plan_source"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_request_id text;
  selected_plan_subscription_id text;
BEGIN
  SELECT attempt."request_id"
  INTO attempt_request_id
  FROM "request_provider_attempts" attempt
  WHERE attempt."id" = NEW."provider_attempt_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing invocation source cannot resolve ProviderAttempt'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."request_id" IS DISTINCT FROM attempt_request_id THEN
    RAISE EXCEPTION 'Billing invocation source request does not match ProviderAttempt'
      USING ERRCODE = '23514';
  END IF;

  SELECT execution."selected_plan_subscription_id"
  INTO selected_plan_subscription_id
  FROM "request_executions" execution
  WHERE execution."request_id" = attempt_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing invocation source cannot resolve RequestExecution'
      USING ERRCODE = '23503';
  END IF;

  IF selected_plan_subscription_id IS NULL THEN
    UPDATE "request_executions"
    SET "selected_plan_subscription_id" = NEW."plan_subscription_id"
    WHERE "request_id" = attempt_request_id;
  ELSIF selected_plan_subscription_id IS DISTINCT FROM NEW."plan_subscription_id" THEN
    RAISE EXCEPTION 'Billing invocation source does not match RequestExecution selected Plan Subscription'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "budget_claims_request_execution_plan_source"
  AFTER INSERT ON "budget_claims"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_sync_request_execution_plan_source"();
CREATE TRIGGER "provider_usage_request_execution_plan_source"
  AFTER INSERT ON "provider_invocation_usage_facts"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_sync_request_execution_plan_source"();

CREATE OR REPLACE FUNCTION "friday_relay_require_request_execution_plan_source"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected_plan_subscription_id text;
BEGIN
  SELECT execution."selected_plan_subscription_id"
  INTO selected_plan_subscription_id
  FROM "request_executions" execution
  WHERE execution."request_id" = NEW."request_id";
  IF selected_plan_subscription_id IS NULL THEN
    RAISE EXCEPTION 'RequestExecution selected Plan Subscription is required at commit'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER "request_executions_selected_plan_source_required"
  AFTER INSERT OR UPDATE OF "selected_plan_subscription_id" ON "request_executions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_require_request_execution_plan_source"();

ALTER TABLE "request_executions"
  ADD CONSTRAINT "request_executions_selected_plan_subscription_fk"
    FOREIGN KEY ("selected_plan_subscription_id") REFERENCES "plan_subscriptions" ("id")
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "request_executions_selected_plan_subscription_idx"
  ON "request_executions" ("selected_plan_subscription_id", "started_at", "request_id")
  WHERE "selected_plan_subscription_id" IS NOT NULL;
