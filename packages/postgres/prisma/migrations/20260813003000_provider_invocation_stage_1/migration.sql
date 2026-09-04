-- Provider invocation stage 1: short-transaction admission, in-flight budget
-- claim, PayGo reservation, final usage and explicit reconciliation.
ALTER TABLE "request_provider_attempts"
  ADD COLUMN "execution_owner_id" text COLLATE "C",
  ADD COLUMN "admission_lease_until" text COLLATE "C",
  ADD COLUMN "cost_exposure" text COLLATE "C" NOT NULL DEFAULT 'not_started',
  ADD COLUMN "final_usage_evidence" text COLLATE "C" NOT NULL DEFAULT 'pending',
  ADD COLUMN "usage_settled" integer NOT NULL DEFAULT 0,
  ADD COLUMN "reconciliation_reason" text COLLATE "C",
  ADD COLUMN "billable_price_source" text COLLATE "C",
  ADD COLUMN "billable_price_id" text COLLATE "C",
  ADD COLUMN "billable_price_tier_key" text COLLATE "C",
  ADD COLUMN "billable_price_snapshot_json" text COLLATE "C",
  ADD COLUMN "routing_revisions_json" text COLLATE "C",
  ADD COLUMN "input_tokens" bigint,
  ADD COLUMN "max_output_tokens" bigint,
  ADD COLUMN "tokenizer_id" text COLLATE "C",
  ADD COLUMN "tokenizer_version" integer,
  ADD COLUMN "requested_service_tier" text COLLATE "C",
  ADD COLUMN "billing_scope_ref" text COLLATE "C",
  ADD COLUMN "plan_seller_scope_ref" text COLLATE "C",
  ADD COLUMN "plan_billing_mode" text COLLATE "C",
  ADD COLUMN "subscription_effective_start" text COLLATE "C",
  ADD COLUMN "provider_owner_scope_ref" text COLLATE "C",
  ADD COLUMN "provider_model_cost_id" text COLLATE "C",
  ADD COLUMN "provider_cost_tier_key" text COLLATE "C",
  ADD COLUMN "provider_cost_snapshot_json" text COLLATE "C",
  ADD COLUMN "access_point_price_snapshots_json" text COLLATE "C";
UPDATE "request_provider_attempts" SET "execution_owner_id" = 'legacy', "admission_lease_until" = "started_at" WHERE "execution_owner_id" IS NULL;
UPDATE "request_provider_attempts" SET "billable_price_source" = 'legacy', "billable_price_id" = 'legacy', "billable_price_tier_key" = 'legacy_flat', "billable_price_snapshot_json" = '{"schemaVersion":1,"currency":"USD","precision":6,"serviceTier":"standard","tierKey":"legacy_flat","inputPriceUnitsPer1M":"0","cachedInputPriceUnitsPer1M":"0","cacheWritePriceUnitsPer1M":null,"outputPriceUnitsPer1M":"0"}' WHERE "billable_price_source" IS NULL;
UPDATE "request_provider_attempts" SET
  "routing_revisions_json" = json_build_array(json_build_object('accessPointId', "selector_access_point_id", 'routingRevision', "routing_revision"))::text,
  "input_tokens" = 0,
  "max_output_tokens" = 0,
  "tokenizer_id" = 'legacy',
  "tokenizer_version" = 1,
  "requested_service_tier" = 'standard',
  "billing_scope_ref" = 'global:',
  "plan_seller_scope_ref" = 'global:',
  "plan_billing_mode" = 'prepaid',
  "subscription_effective_start" = "started_at",
  "provider_owner_scope_ref" = 'global:',
  "provider_model_cost_id" = 'legacy',
  "provider_cost_tier_key" = 'legacy_flat',
  "provider_cost_snapshot_json" = '{"schemaVersion":1,"currency":"USD","precision":6,"serviceTier":"standard","tierKey":"legacy_flat","inputPriceUnitsPer1M":"0","cachedInputPriceUnitsPer1M":"0","cacheWritePriceUnitsPer1M":null,"outputPriceUnitsPer1M":"0"}',
  "access_point_price_snapshots_json" = '[]'
WHERE "routing_revisions_json" IS NULL;
ALTER TABLE "request_provider_attempts" ALTER COLUMN "execution_owner_id" SET NOT NULL, ALTER COLUMN "admission_lease_until" SET NOT NULL,
  ALTER COLUMN "billable_price_source" SET NOT NULL, ALTER COLUMN "billable_price_id" SET NOT NULL,
  ALTER COLUMN "billable_price_tier_key" SET NOT NULL, ALTER COLUMN "billable_price_snapshot_json" SET NOT NULL,
  ALTER COLUMN "routing_revisions_json" SET NOT NULL, ALTER COLUMN "input_tokens" SET NOT NULL,
  ALTER COLUMN "max_output_tokens" SET NOT NULL, ALTER COLUMN "tokenizer_id" SET NOT NULL,
  ALTER COLUMN "tokenizer_version" SET NOT NULL, ALTER COLUMN "requested_service_tier" SET NOT NULL,
  ALTER COLUMN "billing_scope_ref" SET NOT NULL, ALTER COLUMN "plan_seller_scope_ref" SET NOT NULL,
  ALTER COLUMN "plan_billing_mode" SET NOT NULL, ALTER COLUMN "subscription_effective_start" SET NOT NULL,
  ALTER COLUMN "provider_owner_scope_ref" SET NOT NULL, ALTER COLUMN "provider_model_cost_id" SET NOT NULL,
  ALTER COLUMN "provider_cost_tier_key" SET NOT NULL, ALTER COLUMN "provider_cost_snapshot_json" SET NOT NULL,
  ALTER COLUMN "access_point_price_snapshots_json" SET NOT NULL;
ALTER TABLE "request_provider_attempts" ADD CONSTRAINT "request_provider_attempts_invocation_state_check" CHECK (
  "cost_exposure" IN ('not_started', 'accruing', 'stopped')
  AND "final_usage_evidence" IN ('absent', 'pending', 'final')
  AND "usage_settled" IN (0, 1)
  AND "input_tokens" >= 0
  AND "max_output_tokens" >= 0
  AND "tokenizer_version" >= 1
  AND "plan_billing_mode" IN ('prepaid', 'paygo')
  AND (("usage_settled" = 1 AND "cost_exposure" = 'stopped' AND "final_usage_evidence" = 'final') OR "usage_settled" = 0)
);
DROP TRIGGER "request_provider_attempts_immutable_update" ON "request_provider_attempts";
CREATE TRIGGER "request_provider_attempts_immutable_update" BEFORE UPDATE ON "request_provider_attempts" FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_immutable_update"(
  'Provider Attempt identity cannot be updated',
  'outcome', 'failure_class', 'output_committed', 'trusted_usage_source', 'ended_at',
  'cost_exposure', 'final_usage_evidence', 'usage_settled', 'reconciliation_reason'
);
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
     OR (NEW.usage_settled = 0 AND NEW.final_usage_evidence <> 'pending')
     OR (NEW.usage_settled = 1 AND (NEW.cost_exposure <> 'stopped' OR NEW.final_usage_evidence <> 'final' OR NEW.trusted_usage_source IS NULL))
  THEN
    RAISE EXCEPTION 'Provider Attempt terminal transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE "request_executions" (
  "request_id" text COLLATE "C" PRIMARY KEY,
  "status" text COLLATE "C" NOT NULL,
  "owner_id" text COLLATE "C" NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "output_committed" integer NOT NULL DEFAULT 0,
  "terminal_error_code" text COLLATE "C",
  "started_at" text COLLATE "C" NOT NULL,
  "ended_at" text COLLATE "C",
  CONSTRAINT "request_executions_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "request_logs"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "request_executions_status_check" CHECK ("status" IN ('pending', 'running', 'succeeded', 'failed', 'aborted')),
  CONSTRAINT "request_executions_output_committed_check" CHECK ("output_committed" IN (0, 1)),
  CONSTRAINT "request_executions_attempt_count_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "request_executions_terminal_shape_check" CHECK (("status" IN ('pending', 'running') AND "ended_at" IS NULL) OR ("status" IN ('succeeded', 'failed', 'aborted') AND "ended_at" IS NOT NULL))
);
CREATE INDEX "request_executions_status_started_idx" ON "request_executions" ("status", "started_at", "request_id");

CREATE TABLE "budget_claims" (
  "provider_attempt_id" text COLLATE "C" PRIMARY KEY,
  "request_id" text COLLATE "C" NOT NULL,
  "plan_id" text COLLATE "C" NOT NULL,
  "plan_subscription_id" text COLLATE "C" NOT NULL,
  "api_key_id" text COLLATE "C" NOT NULL,
  "user_id" text COLLATE "C" NOT NULL,
  "max_total_tokens" bigint NOT NULL,
  "max_charge_units" bigint NOT NULL,
  "created_at" text COLLATE "C" NOT NULL,
  CONSTRAINT "budget_claims_attempt_fk" FOREIGN KEY ("provider_attempt_id") REFERENCES "request_provider_attempts"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "budget_claims_request_fk" FOREIGN KEY ("request_id") REFERENCES "request_logs"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "budget_claims_plan_fk" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "budget_claims_subscription_fk" FOREIGN KEY ("plan_subscription_id") REFERENCES "plan_subscriptions"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "budget_claims_api_key_fk" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "budget_claims_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "budget_claims_amount_check" CHECK ("max_total_tokens" >= 0 AND "max_charge_units" >= 0)
);
CREATE INDEX "budget_claims_subscription_idx" ON "budget_claims" ("plan_subscription_id", "user_id", "provider_attempt_id");
CREATE INDEX "budget_claims_api_key_idx" ON "budget_claims" ("api_key_id", "provider_attempt_id");

CREATE TABLE "usage_reservations" (
  "id" text COLLATE "C" PRIMARY KEY,
  "provider_attempt_id" text COLLATE "C" NOT NULL UNIQUE,
  "request_id" text COLLATE "C" NOT NULL,
  "credit_account_id" text COLLATE "C" NOT NULL,
  "plan_subscription_id" text COLLATE "C" NOT NULL,
  "user_id" text COLLATE "C" NOT NULL,
  "status" text COLLATE "C" NOT NULL,
  "reservation_units" bigint NOT NULL,
  "held_units" bigint NOT NULL,
  "input_tokens" bigint NOT NULL,
  "max_output_tokens" bigint NOT NULL,
  "tokenizer_id" text COLLATE "C" NOT NULL,
  "tokenizer_version" integer NOT NULL,
  "service_tier" text COLLATE "C" NOT NULL,
  "billable_price_source" text COLLATE "C" NOT NULL,
  "billable_price_id" text COLLATE "C" NOT NULL,
  "billable_price_tier_key" text COLLATE "C" NOT NULL,
  "price_snapshot_json" text COLLATE "C" NOT NULL,
  "posting_ledger_event_id" text COLLATE "C",
  "created_at" text COLLATE "C" NOT NULL,
  "updated_at" text COLLATE "C" NOT NULL,
  CONSTRAINT "usage_reservations_attempt_fk" FOREIGN KEY ("provider_attempt_id") REFERENCES "request_provider_attempts"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "usage_reservations_request_fk" FOREIGN KEY ("request_id") REFERENCES "request_logs"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "usage_reservations_account_fk" FOREIGN KEY ("credit_account_id") REFERENCES "credit_accounts"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "usage_reservations_subscription_fk" FOREIGN KEY ("plan_subscription_id") REFERENCES "plan_subscriptions"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "usage_reservations_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "usage_reservations_status_check" CHECK ("status" IN ('active', 'reconciling', 'released', 'settled')),
  CONSTRAINT "usage_reservations_amount_check" CHECK ("reservation_units" >= 0 AND "held_units" >= 0 AND "held_units" <= "reservation_units"),
  CONSTRAINT "usage_reservations_token_check" CHECK ("input_tokens" >= 0 AND "max_output_tokens" >= 0),
  CONSTRAINT "usage_reservations_hold_shape_check" CHECK (("status" IN ('released', 'settled') AND "held_units" = 0) OR "status" IN ('active', 'reconciling'))
);
CREATE INDEX "usage_reservations_account_active_idx" ON "usage_reservations" ("credit_account_id", "status", "id") WHERE "status" IN ('active', 'reconciling');
CREATE INDEX "usage_reservations_user_active_idx" ON "usage_reservations" ("user_id", "status", "id") WHERE "status" IN ('active', 'reconciling');

CREATE TABLE "provider_invocation_usage_facts" (
  "provider_attempt_id" text COLLATE "C" PRIMARY KEY,
  "request_id" text COLLATE "C" NOT NULL,
  "plan_subscription_id" text COLLATE "C" NOT NULL,
  "api_key_id" text COLLATE "C" NOT NULL,
  "user_id" text COLLATE "C" NOT NULL,
  "input_tokens" bigint NOT NULL,
  "cached_input_tokens" bigint NOT NULL,
  "cache_write_tokens" bigint NOT NULL,
  "output_tokens" bigint NOT NULL,
  "total_tokens" bigint NOT NULL,
  "actual_charge_units" bigint NOT NULL,
  "usage_source" text COLLATE "C" NOT NULL,
  "price_snapshot_json" text COLLATE "C" NOT NULL,
  "occurred_at" text COLLATE "C" NOT NULL,
  "settled_at" text COLLATE "C" NOT NULL,
  "posting_ledger_event_id" text COLLATE "C",
  "billing_event_id" text COLLATE "C" NOT NULL,
  CONSTRAINT "provider_invocation_usage_facts_attempt_fk" FOREIGN KEY ("provider_attempt_id") REFERENCES "request_provider_attempts"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "provider_invocation_usage_facts_request_fk" FOREIGN KEY ("request_id") REFERENCES "request_logs"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "provider_invocation_usage_facts_subscription_fk" FOREIGN KEY ("plan_subscription_id") REFERENCES "plan_subscriptions"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "provider_invocation_usage_facts_api_key_fk" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "provider_invocation_usage_facts_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "provider_invocation_usage_facts_usage_check" CHECK ("input_tokens" >= 0 AND "cached_input_tokens" >= 0 AND "cache_write_tokens" >= 0 AND "output_tokens" >= 0 AND "total_tokens" >= 0 AND "actual_charge_units" >= 0),
  CONSTRAINT "provider_invocation_usage_facts_total_check" CHECK ("total_tokens" = "input_tokens" + "output_tokens")
);
CREATE INDEX "provider_invocation_usage_facts_subscription_idx" ON "provider_invocation_usage_facts" ("plan_subscription_id", "user_id", "occurred_at", "provider_attempt_id");
CREATE INDEX "provider_invocation_usage_facts_api_key_idx" ON "provider_invocation_usage_facts" ("api_key_id", "occurred_at", "provider_attempt_id");

ALTER TABLE "credit_ledger_events" ADD COLUMN "provider_attempt_id" text COLLATE "C";
ALTER TABLE "credit_ledger_events" ADD CONSTRAINT "credit_ledger_events_provider_attempt_fk" FOREIGN KEY ("provider_attempt_id") REFERENCES "request_provider_attempts"("id") DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX "credit_ledger_events_provider_attempt_usage_unique" ON "credit_ledger_events" ("provider_attempt_id") WHERE "provider_attempt_id" IS NOT NULL AND "event_type" = 'usage_charge';
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_posting_fk" FOREIGN KEY ("posting_ledger_event_id") REFERENCES "credit_ledger_events"("id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "provider_invocation_usage_facts" ADD CONSTRAINT "provider_invocation_usage_facts_posting_fk" FOREIGN KEY ("posting_ledger_event_id") REFERENCES "credit_ledger_events"("id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "provider_invocation_usage_facts" ADD CONSTRAINT "provider_invocation_usage_facts_billing_fk" FOREIGN KEY ("billing_event_id") REFERENCES "billing_events"("id") DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX "billing_events_provider_attempt_unique" ON "provider_invocation_usage_facts" ("billing_event_id");
CREATE UNIQUE INDEX "billing_provider_cost_events_attempt_operation_unique" ON "billing_provider_cost_events" ("provider_attempt_id", "operation_kind") WHERE "provider_attempt_id" IS NOT NULL;

CREATE TRIGGER "budget_claims_no_update" BEFORE UPDATE ON "budget_claims" FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_immutable_update"('BudgetClaim cannot be updated');
CREATE TRIGGER "provider_invocation_usage_facts_no_update" BEFORE UPDATE ON "provider_invocation_usage_facts" FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_immutable_update"('Provider invocation usage fact cannot be updated');
CREATE TRIGGER "provider_invocation_usage_facts_no_delete" BEFORE DELETE ON "provider_invocation_usage_facts" FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_delete"();
