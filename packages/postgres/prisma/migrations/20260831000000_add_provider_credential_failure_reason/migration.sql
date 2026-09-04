-- Expand-only credential failure reason facts. Historical rows intentionally remain NULL.
ALTER TABLE "request_logs"
  ADD COLUMN "credential_failure_reason" text COLLATE "C";

ALTER TABLE "request_provider_attempts"
  ADD COLUMN "failure_reason" text COLLATE "C";

ALTER TABLE "request_logs"
  ADD CONSTRAINT "request_logs_credential_failure_reason_check" CHECK (
    "credential_failure_reason" IS NULL
    OR (
      "status" = 'failed'
      AND "credential_failure_reason" IN ('auth_unauthorized', 'auth_unavailable', 'auth_not_found', 'model_cooldown')
    )
  );

ALTER TABLE "request_provider_attempts"
  ADD CONSTRAINT "request_provider_attempts_failure_reason_check" CHECK (
    "failure_reason" IS NULL
    OR (
      "outcome" = 'failed'
      AND "failure_reason" IN ('auth_unauthorized', 'auth_unavailable', 'auth_not_found', 'model_cooldown')
    )
  );

-- Preserve the latest request-log identity rules while making the new terminal
-- reason write-once. Existing NULL history is not inferred or backfilled.
CREATE OR REPLACE FUNCTION "friday_relay_validate_request_log_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.api_key_id IS DISTINCT FROM NEW.api_key_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.request_path IS DISTINCT FROM NEW.request_path
    OR OLD.ingress_hostname IS DISTINCT FROM NEW.ingress_hostname
    OR OLD.ingress_route_id IS DISTINCT FROM NEW.ingress_route_id
    OR OLD.req_model IS DISTINCT FROM NEW.req_model
    OR OLD.ingress_plugins_json IS DISTINCT FROM NEW.ingress_plugins_json
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
    OR NOT (
      OLD.pipeline_plugins_json IS NOT DISTINCT FROM NEW.pipeline_plugins_json
      OR (
        OLD.pipeline_plugins_json = '{"schemaVersion":1,"planRevision":"pending","invocations":[]}'
        AND NEW.pipeline_plugins_json IS DISTINCT FROM OLD.pipeline_plugins_json
      )
    )
    OR NOT (OLD.team_id IS NOT DISTINCT FROM NEW.team_id OR (OLD.team_id IS NULL AND NEW.team_id IS NOT NULL))
    OR NOT (OLD.plan_id IS NOT DISTINCT FROM NEW.plan_id OR (OLD.plan_id IS NULL AND NEW.plan_id IS NOT NULL))
    OR NOT (OLD.plan_subscription_id IS NOT DISTINCT FROM NEW.plan_subscription_id OR (OLD.plan_subscription_id IS NULL AND NEW.plan_subscription_id IS NOT NULL))
    OR NOT (OLD.entry_access_point_id IS NOT DISTINCT FROM NEW.entry_access_point_id OR (OLD.entry_access_point_id IS NULL AND NEW.entry_access_point_id IS NOT NULL))
    OR NOT (OLD.billing_scope_ref IS NOT DISTINCT FROM NEW.billing_scope_ref OR (OLD.billing_scope_ref IS NULL AND NEW.billing_scope_ref IS NOT NULL))
    OR NOT (OLD.provider_id IS NOT DISTINCT FROM NEW.provider_id OR (OLD.provider_id IS NULL AND NEW.provider_id IS NOT NULL))
    OR NOT (OLD.tar_model IS NOT DISTINCT FROM NEW.tar_model OR (OLD.tar_model IS NULL AND NEW.tar_model IS NOT NULL))
    OR NOT (
      OLD.credential_failure_reason IS NOT DISTINCT FROM NEW.credential_failure_reason
      OR (OLD.credential_failure_reason IS NULL AND NEW.credential_failure_reason IS NOT NULL)
    )
  THEN
    RAISE EXCEPTION 'request_logs immutable fields cannot be updated' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

-- Reassert the latest cpa-basic@1-compatible transition contract. The reason is
-- written with the first terminal outcome and cannot be changed afterwards.
CREATE OR REPLACE FUNCTION "friday_relay_validate_provider_attempt_terminal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome = 'pending' THEN
    IF OLD.outcome <> 'pending'
       OR OLD.cost_exposure <> 'not_started'
       OR NEW.cost_exposure <> 'accruing'
       OR NEW.ended_at IS NOT NULL
       OR NEW.failure_class IS NOT NULL
       OR NEW.failure_reason IS NOT NULL
       OR NEW.trusted_usage_source IS NOT NULL
       OR NEW.usage_settled <> 0
       OR NEW.final_usage_evidence <> 'pending'
    THEN
      RAISE EXCEPTION 'Provider Attempt dispatch transition is invalid' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.usage_settled = 1
     OR NEW.outcome NOT IN ('succeeded','failed','aborted')
     OR NEW.ended_at IS NULL
     OR (NEW.outcome = 'succeeded' AND (NEW.failure_class IS NOT NULL OR NEW.failure_reason IS NOT NULL))
     OR (NEW.outcome = 'failed' AND NEW.failure_class IS NULL)
     OR (NEW.outcome = 'aborted' AND (NEW.failure_class IS NOT NULL OR NEW.failure_reason IS NOT NULL))
     OR (OLD.outcome <> 'pending' AND NEW.failure_reason IS DISTINCT FROM OLD.failure_reason)
     OR (
       NEW.usage_settled = 0
       AND NEW.final_usage_evidence <> 'pending'
       AND NOT (
         NEW.invocation_contract = 'cpa-basic@1'
         AND NEW.cost_exposure = 'not_started'
         AND NEW.final_usage_evidence = 'absent'
       )
     )
     OR (NEW.usage_settled = 1 AND (NEW.cost_exposure <> 'stopped' OR NEW.final_usage_evidence <> 'final' OR NEW.trusted_usage_source IS NULL))
  THEN
    RAISE EXCEPTION 'Provider Attempt terminal transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER "request_provider_attempts_terminal_update" ON "request_provider_attempts";
CREATE TRIGGER "request_provider_attempts_terminal_update"
  BEFORE UPDATE OF
    "outcome", "failure_class", "failure_reason", "output_committed", "trusted_usage_source", "ended_at",
    "cost_exposure", "final_usage_evidence", "usage_settled", "reconciliation_reason"
  ON "request_provider_attempts"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_validate_provider_attempt_terminal"();

DROP TRIGGER IF EXISTS "request_provider_attempts_immutable_update" ON "request_provider_attempts";
CREATE TRIGGER "request_provider_attempts_immutable_update"
BEFORE UPDATE ON "request_provider_attempts"
FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_immutable_update"(
  'Provider Attempt identity cannot be updated',
  'outcome', 'failure_class', 'failure_reason', 'output_committed', 'trusted_usage_source', 'ended_at',
  'cost_exposure', 'final_usage_evidence', 'usage_settled', 'reconciliation_reason'
);
