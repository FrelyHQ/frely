-- Add the claimless, non-reserving contract used by stock CPA Stage 1.
-- Existing precise rows retain their protected shape without data rewrites.
ALTER TABLE "request_provider_attempts"
  ADD COLUMN "invocation_contract" text COLLATE "C" NOT NULL DEFAULT 'protected@1',
  ADD COLUMN "plan_subscription_id" text COLLATE "C",
  ADD COLUMN "api_key_id" text COLLATE "C",
  ADD COLUMN "user_id" text COLLATE "C",
  ADD COLUMN "usage_charge_account_id" text COLLATE "C",
  ADD COLUMN "require_service_tier" integer NOT NULL DEFAULT 0,
  ADD COLUMN "billable_price_profile_json" text COLLATE "C",
  ADD COLUMN "provider_cost_profile_json" text COLLATE "C",
  ADD COLUMN "access_point_price_profiles_json" text COLLATE "C",
  ALTER COLUMN "billable_price_tier_key" DROP NOT NULL,
  ALTER COLUMN "billable_price_snapshot_json" DROP NOT NULL,
  ALTER COLUMN "input_tokens" DROP NOT NULL,
  ALTER COLUMN "max_output_tokens" DROP NOT NULL,
  ALTER COLUMN "tokenizer_id" DROP NOT NULL,
  ALTER COLUMN "tokenizer_version" DROP NOT NULL,
  ALTER COLUMN "provider_cost_tier_key" DROP NOT NULL,
  ALTER COLUMN "provider_cost_snapshot_json" DROP NOT NULL,
  ALTER COLUMN "access_point_price_snapshots_json" DROP NOT NULL;

ALTER TABLE "request_provider_attempts"
  DROP CONSTRAINT "request_provider_attempts_invocation_state_check";

ALTER TABLE "request_provider_attempts"
  ADD CONSTRAINT "request_provider_attempts_invocation_state_check" CHECK (
    "cost_exposure" IN ('not_started', 'accruing', 'stopped')
    AND "final_usage_evidence" IN ('absent', 'pending', 'final')
    AND "usage_settled" IN (0, 1)
    AND "plan_billing_mode" IN ('prepaid', 'paygo')
    AND "invocation_contract" IN ('protected@1', 'cpa-basic@1')
    AND "require_service_tier" IN (0, 1)
    AND (
      (
        "invocation_contract" = 'protected@1'
        AND "billable_price_tier_key" IS NOT NULL
        AND "billable_price_snapshot_json" IS NOT NULL
        AND "input_tokens" IS NOT NULL AND "input_tokens" >= 0
        AND "max_output_tokens" IS NOT NULL AND "max_output_tokens" >= 0
        AND "tokenizer_id" IS NOT NULL
        AND "tokenizer_version" IS NOT NULL AND "tokenizer_version" >= 1
        AND "provider_cost_tier_key" IS NOT NULL
        AND "provider_cost_snapshot_json" IS NOT NULL
        AND "access_point_price_snapshots_json" IS NOT NULL
        AND "plan_subscription_id" IS NULL
        AND "api_key_id" IS NULL
        AND "user_id" IS NULL
        AND "usage_charge_account_id" IS NULL
        AND "billable_price_profile_json" IS NULL
        AND "provider_cost_profile_json" IS NULL
        AND "access_point_price_profiles_json" IS NULL
      )
      OR
      (
        "invocation_contract" = 'cpa-basic@1'
        AND "billable_price_tier_key" IS NULL
        AND "billable_price_snapshot_json" IS NULL
        AND "input_tokens" IS NULL
        AND "max_output_tokens" IS NULL
        AND "tokenizer_id" IS NULL
        AND "tokenizer_version" IS NULL
        AND "provider_cost_tier_key" IS NULL
        AND "provider_cost_snapshot_json" IS NULL
        AND "access_point_price_snapshots_json" IS NULL
        AND "plan_subscription_id" IS NOT NULL
        AND "api_key_id" IS NOT NULL
        AND "user_id" IS NOT NULL
        AND (("plan_billing_mode" = 'paygo' AND "usage_charge_account_id" IS NOT NULL)
          OR ("plan_billing_mode" = 'prepaid' AND "usage_charge_account_id" IS NULL))
        AND "billable_price_profile_json" IS NOT NULL
        AND "provider_cost_profile_json" IS NOT NULL
        AND "access_point_price_profiles_json" IS NOT NULL
        AND friday_relay_json_type("billable_price_profile_json") = 'object'
        AND friday_relay_json_type("provider_cost_profile_json") = 'object'
        AND friday_relay_json_type("access_point_price_profiles_json") = 'array'
        AND jsonb_array_length("access_point_price_profiles_json"::jsonb) > 0
      )
    )
    AND (("usage_settled" = 1 AND "cost_exposure" = 'stopped' AND "final_usage_evidence" = 'final') OR "usage_settled" = 0)
  );

-- Keep protected Billing sources bound to RequestExecution while allowing the
-- explicit claimless contract to bind final usage to its frozen Plan source.
CREATE OR REPLACE FUNCTION "friday_relay_sync_request_execution_plan_source"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_request_id text;
  attempt_invocation_contract text;
  attempt_plan_subscription_id text;
  selected_plan_subscription_id text;
BEGIN
  SELECT attempt."request_id", attempt."invocation_contract", attempt."plan_subscription_id"
  INTO attempt_request_id, attempt_invocation_contract, attempt_plan_subscription_id
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

  IF attempt_invocation_contract = 'cpa-basic@1' THEN
    IF TG_TABLE_NAME <> 'provider_invocation_usage_facts'
       OR attempt_plan_subscription_id IS NULL
       OR NEW."plan_subscription_id" IS DISTINCT FROM attempt_plan_subscription_id
    THEN
      RAISE EXCEPTION 'Claimless Billing invocation source does not match frozen ProviderAttempt references'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
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

-- Preserve the protected transition rules while allowing a cpa-basic attempt
-- that never crossed dispatch to close with explicit no-side-effect evidence.
CREATE OR REPLACE FUNCTION "friday_relay_validate_provider_attempt_terminal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome = 'pending' THEN
    IF OLD.outcome <> 'pending'
       OR OLD.cost_exposure <> 'not_started'
       OR NEW.cost_exposure <> 'accruing'
       OR NEW.ended_at IS NOT NULL
       OR NEW.failure_class IS NOT NULL
       OR NEW.trusted_usage_source IS NOT NULL
       OR NEW.usage_settled <> 0
       OR NEW.final_usage_evidence <> 'pending'
    THEN
      RAISE EXCEPTION 'Provider Attempt dispatch transition is invalid' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.usage_settled = 1
     OR NEW.outcome NOT IN ('succeeded','failed','aborted')
     OR NEW.ended_at IS NULL
     OR (NEW.outcome = 'succeeded' AND NEW.failure_class IS NOT NULL)
     OR (NEW.outcome = 'failed' AND NEW.failure_class IS NULL)
     OR (NEW.outcome = 'aborted' AND NEW.failure_class IS NOT NULL)
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
