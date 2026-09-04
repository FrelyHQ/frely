-- MODERNIZATION-04 Billing invocation kernel closure.
-- Additive only: existing protected rows remain historical compatibility rows;
-- every new protected row must carry exact CPA preparation/payload binding.
ALTER TABLE "request_provider_attempts"
  ADD COLUMN "preparation_evidence_id" text COLLATE "C",
  ADD COLUMN "preparation_evidence_version" integer,
  ADD COLUMN "prepared_payload_id" text COLLATE "C";

ALTER TABLE "usage_reservations"
  ADD COLUMN "preparation_evidence_id" text COLLATE "C",
  ADD COLUMN "preparation_evidence_version" integer,
  ADD COLUMN "prepared_payload_id" text COLLATE "C";

ALTER TABLE "request_provider_attempts"
  ADD CONSTRAINT "request_provider_attempts_preparation_binding_check" CHECK (
    (
      "preparation_evidence_id" IS NULL
      AND "preparation_evidence_version" IS NULL
      AND "prepared_payload_id" IS NULL
    ) OR (
      "invocation_contract" = 'protected@1'
      AND length("preparation_evidence_id") BETWEEN 1 AND 256
      AND "preparation_evidence_version" >= 1
      AND length("prepared_payload_id") BETWEEN 1 AND 256
      AND "max_output_tokens" > 0
    )
  );

ALTER TABLE "usage_reservations"
  ADD CONSTRAINT "usage_reservations_preparation_binding_check" CHECK (
    (
      "preparation_evidence_id" IS NULL
      AND "preparation_evidence_version" IS NULL
      AND "prepared_payload_id" IS NULL
    ) OR (
      length("preparation_evidence_id") BETWEEN 1 AND 256
      AND "preparation_evidence_version" >= 1
      AND length("prepared_payload_id") BETWEEN 1 AND 256
      AND "max_output_tokens" > 0
    )
  );

CREATE OR REPLACE FUNCTION "friday_relay_require_new_protected_preparation_binding"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."invocation_contract" = 'protected@1' AND (
    NEW."preparation_evidence_id" IS NULL
    OR NEW."preparation_evidence_version" IS NULL
    OR NEW."prepared_payload_id" IS NULL
    OR NEW."max_output_tokens" IS NULL
    OR NEW."max_output_tokens" <= 0
  ) THEN
    RAISE EXCEPTION 'New protected ProviderAttempt requires CPA preparation evidence and a positive output cap'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."invocation_contract" = 'cpa-basic@1' AND (
    NEW."preparation_evidence_id" IS NOT NULL
    OR NEW."preparation_evidence_version" IS NOT NULL
    OR NEW."prepared_payload_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'CPA basic ProviderAttempt cannot be relabeled with protected preparation evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "request_provider_attempts_new_preparation_binding"
BEFORE INSERT ON "request_provider_attempts"
FOR EACH ROW EXECUTE FUNCTION "friday_relay_require_new_protected_preparation_binding"();

CREATE OR REPLACE FUNCTION "friday_relay_guard_budget_claim_lifecycle"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_started_at text;
  attempt_contract text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT attempt."started_at", attempt."invocation_contract"
      INTO attempt_started_at, attempt_contract
      FROM "request_provider_attempts" attempt
      WHERE attempt."id" = NEW."provider_attempt_id";
    IF NOT FOUND OR attempt_contract <> 'protected@1' THEN
      RAISE EXCEPTION 'BudgetClaim requires one protected ProviderAttempt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."created_at" IS DISTINCT FROM attempt_started_at THEN
      RAISE EXCEPTION 'BudgetClaim window is owned by immutable ProviderAttempt.started_at'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."max_total_tokens" <= 0 OR NEW."max_charge_units" < 0 THEN
      RAISE EXCEPTION 'BudgetClaim values are invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "provider_invocation_usage_facts" usage
      WHERE usage."provider_attempt_id" = OLD."provider_attempt_id"
    ) THEN
      RAISE EXCEPTION 'BudgetClaim can be deleted only when final usage replaces it'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'BudgetClaim cannot be updated' USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS "budget_claims_no_update" ON "budget_claims";
CREATE TRIGGER "budget_claims_lifecycle_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "budget_claims"
FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_budget_claim_lifecycle"();

CREATE OR REPLACE FUNCTION "friday_relay_guard_usage_reservation_lifecycle"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_row "request_provider_attempts"%ROWTYPE;
  usage_row "provider_invocation_usage_facts"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UsageReservation cannot be deleted' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO attempt_row
      FROM "request_provider_attempts" attempt
      WHERE attempt."id" = NEW."provider_attempt_id";
    IF NOT FOUND OR attempt_row."invocation_contract" <> 'protected@1' THEN
      RAISE EXCEPTION 'UsageReservation requires one protected ProviderAttempt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."created_at" IS DISTINCT FROM attempt_row."started_at"
       OR NEW."input_tokens" IS DISTINCT FROM attempt_row."input_tokens"
       OR NEW."max_output_tokens" IS DISTINCT FROM attempt_row."max_output_tokens"
       OR NEW."tokenizer_id" IS DISTINCT FROM attempt_row."tokenizer_id"
       OR NEW."tokenizer_version" IS DISTINCT FROM attempt_row."tokenizer_version"
       OR NEW."preparation_evidence_id" IS DISTINCT FROM attempt_row."preparation_evidence_id"
       OR NEW."preparation_evidence_version" IS DISTINCT FROM attempt_row."preparation_evidence_version"
       OR NEW."prepared_payload_id" IS DISTINCT FROM attempt_row."prepared_payload_id"
    THEN
      RAISE EXCEPTION 'UsageReservation does not match ProviderAttempt preparation and window facts'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."status" <> 'active'
       OR NEW."reservation_units" < 0
       OR NEW."held_units" IS DISTINCT FROM NEW."reservation_units"
    THEN
      RAISE EXCEPTION 'UsageReservation initial lifecycle is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."provider_attempt_id" IS DISTINCT FROM OLD."provider_attempt_id"
     OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."credit_account_id" IS DISTINCT FROM OLD."credit_account_id"
     OR NEW."plan_subscription_id" IS DISTINCT FROM OLD."plan_subscription_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."reservation_units" IS DISTINCT FROM OLD."reservation_units"
     OR NEW."input_tokens" IS DISTINCT FROM OLD."input_tokens"
     OR NEW."max_output_tokens" IS DISTINCT FROM OLD."max_output_tokens"
     OR NEW."tokenizer_id" IS DISTINCT FROM OLD."tokenizer_id"
     OR NEW."tokenizer_version" IS DISTINCT FROM OLD."tokenizer_version"
     OR NEW."preparation_evidence_id" IS DISTINCT FROM OLD."preparation_evidence_id"
     OR NEW."preparation_evidence_version" IS DISTINCT FROM OLD."preparation_evidence_version"
     OR NEW."prepared_payload_id" IS DISTINCT FROM OLD."prepared_payload_id"
     OR NEW."service_tier" IS DISTINCT FROM OLD."service_tier"
     OR NEW."billable_price_source" IS DISTINCT FROM OLD."billable_price_source"
     OR NEW."billable_price_id" IS DISTINCT FROM OLD."billable_price_id"
     OR NEW."billable_price_tier_key" IS DISTINCT FROM OLD."billable_price_tier_key"
     OR NEW."price_snapshot_json" IS DISTINCT FROM OLD."price_snapshot_json"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'UsageReservation immutable facts cannot be updated'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" IN ('released', 'settled') THEN
    RAISE EXCEPTION 'Terminal UsageReservation cannot transition'
      USING ERRCODE = '55000';
  END IF;
  IF (OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'reconciling', 'released', 'settled'))
     OR (OLD."status" = 'reconciling' AND NEW."status" NOT IN ('reconciling', 'released', 'settled'))
  THEN
    RAISE EXCEPTION 'UsageReservation lifecycle transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."held_units" < 0 OR NEW."held_units" > NEW."reservation_units"
     OR (NEW."status" IN ('released', 'settled') AND NEW."held_units" <> 0)
  THEN
    RAISE EXCEPTION 'UsageReservation hold transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IN ('released', 'settled') THEN
    SELECT * INTO usage_row
      FROM "provider_invocation_usage_facts" usage
      WHERE usage."provider_attempt_id" = NEW."provider_attempt_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Terminal UsageReservation requires final usage'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."posting_ledger_event_id" IS DISTINCT FROM usage_row."posting_ledger_event_id" THEN
      RAISE EXCEPTION 'UsageReservation posting does not match final usage'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'released' AND (
      usage_row."input_tokens" <> 0
      OR usage_row."cached_input_tokens" <> 0
      OR usage_row."cache_write_tokens" <> 0
      OR usage_row."output_tokens" <> 0
      OR usage_row."total_tokens" <> 0
      OR usage_row."actual_charge_units" <> 0
      OR usage_row."posting_ledger_event_id" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Released UsageReservation requires authoritative zero usage'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "usage_reservations_lifecycle_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "usage_reservations"
FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_usage_reservation_lifecycle"();

-- Service commerce records payment first. Fulfillment is a separate explicit
-- attempt; a failure preserves the paid order and advances only the fulfillment
-- to blocked.
ALTER TABLE "service_fulfillments" DROP CONSTRAINT "service_fulfillments_status_check";
ALTER TABLE "service_fulfillments" ADD CONSTRAINT "service_fulfillments_status_check"
  CHECK ("status" IN ('pending','ready','blocked','fulfilled','failed'));

CREATE OR REPLACE FUNCTION "friday_relay_guard_service_order_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."buyer_user_id" IS DISTINCT FROM OLD."buyer_user_id"
     OR NEW."target_partner_team_id" IS DISTINCT FROM OLD."target_partner_team_id"
     OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
     OR NEW."product_listing_id" IS DISTINCT FROM OLD."product_listing_id"
     OR NEW."payment_channel_id" IS DISTINCT FROM OLD."payment_channel_id"
     OR NEW."product_code" IS DISTINCT FROM OLD."product_code"
     OR NEW."product_version" IS DISTINCT FROM OLD."product_version"
     OR NEW."product_display_name" IS DISTINCT FROM OLD."product_display_name"
     OR NEW."fulfillment_effect" IS DISTINCT FROM OLD."fulfillment_effect"
     OR NEW."duration_seconds" IS DISTINCT FROM OLD."duration_seconds"
     OR NEW."partner_plan_id" IS DISTINCT FROM OLD."partner_plan_id"
     OR NEW."purchase_intent" IS DISTINCT FROM OLD."purchase_intent"
     OR NEW."expected_payment_amount_units" IS DISTINCT FROM OLD."expected_payment_amount_units"
     OR NEW."payment_asset" IS DISTINCT FROM OLD."payment_asset"
     OR NEW."payment_network" IS DISTINCT FROM OLD."payment_network"
     OR NEW."create_idempotency_key_hash" IS DISTINCT FROM OLD."create_idempotency_key_hash"
     OR NEW."create_request_hash" IS DISTINCT FROM OLD."create_request_hash"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'ServiceOrder frozen purchase facts cannot be updated' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'pending_payment' AND NEW."status" NOT IN ('pending_payment','pending_review','cancelled') THEN
    RAISE EXCEPTION 'ServiceOrder transition from pending_payment is invalid' USING ERRCODE = '55000';
  ELSIF OLD."status" = 'pending_review' AND NEW."status" NOT IN ('pending_review','paid','rejected','cancelled') THEN
    RAISE EXCEPTION 'ServiceOrder transition from pending_review is invalid' USING ERRCODE = '55000';
  ELSIF OLD."status" = 'paid' AND NEW."status" NOT IN ('paid','fulfilled') THEN
    RAISE EXCEPTION 'Paid ServiceOrder can only remain paid or become fulfilled' USING ERRCODE = '55000';
  ELSIF OLD."status" IN ('fulfilled','cancelled','rejected','failed') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Terminal ServiceOrder cannot transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "service_orders_transition_guard"
BEFORE UPDATE ON "service_orders"
FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_service_order_transition"();

CREATE OR REPLACE FUNCTION "friday_relay_guard_service_fulfillment_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
     OR NEW."effect_type" IS DISTINCT FROM OLD."effect_type"
     OR NEW."initiated_by_user_id" IS DISTINCT FROM OLD."initiated_by_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'ServiceFulfillment frozen facts cannot be updated' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'pending' AND NEW."status" NOT IN ('pending','ready','blocked') THEN
    RAISE EXCEPTION 'ServiceFulfillment transition from pending is invalid' USING ERRCODE = '55000';
  ELSIF OLD."status" = 'blocked' AND NEW."status" NOT IN ('blocked','ready') THEN
    RAISE EXCEPTION 'Blocked ServiceFulfillment requires explicit retry' USING ERRCODE = '55000';
  ELSIF OLD."status" = 'ready' AND NEW."status" NOT IN ('ready','fulfilled') THEN
    RAISE EXCEPTION 'Ready ServiceFulfillment transition is invalid' USING ERRCODE = '55000';
  ELSIF OLD."status" IN ('fulfilled','failed') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Terminal ServiceFulfillment cannot transition' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'fulfilled' AND (
    NEW."target_type" IS NULL OR NEW."target_id" IS NULL
    OR NEW."completed_by_user_id" IS NULL OR NEW."completed_at" IS NULL
    OR NEW."error_code" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Fulfilled ServiceFulfillment result is incomplete' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'blocked' AND NEW."error_code" IS NULL THEN
    RAISE EXCEPTION 'Blocked ServiceFulfillment requires an error code' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "service_fulfillments_transition_guard"
BEFORE UPDATE ON "service_fulfillments"
FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_service_fulfillment_transition"();
