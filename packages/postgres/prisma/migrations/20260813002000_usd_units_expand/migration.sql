-- Controlled USD six-decimal units expand. Legacy floating columns remain
-- compatibility evidence until the independently authorized contract release.
CREATE OR REPLACE FUNCTION "friday_relay_usd_units"(value double precision) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF value::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'USD amount must be finite' USING ERRCODE = '22003';
  END IF;
  RETURN round(value::numeric * 1000000)::bigint;
END $$;

ALTER TABLE "access_point_price_tiers"
  ADD COLUMN "input_price_units_per_1m" bigint,
  ADD COLUMN "cached_input_price_units_per_1m" bigint,
  ADD COLUMN "cache_write_price_units_per_1m" bigint,
  ADD COLUMN "output_price_units_per_1m" bigint;
ALTER TABLE "access_point_prices"
  ADD COLUMN "input_price_units_per_1m" bigint,
  ADD COLUMN "cached_input_price_units_per_1m" bigint,
  ADD COLUMN "cache_write_price_units_per_1m" bigint,
  ADD COLUMN "output_price_units_per_1m" bigint;
ALTER TABLE "plan_access_point_price_tiers"
  ADD COLUMN "input_price_units_per_1m" bigint,
  ADD COLUMN "cached_input_price_units_per_1m" bigint,
  ADD COLUMN "cache_write_price_units_per_1m" bigint,
  ADD COLUMN "output_price_units_per_1m" bigint;
ALTER TABLE "plan_access_point_prices"
  ADD COLUMN "input_price_units_per_1m" bigint,
  ADD COLUMN "cached_input_price_units_per_1m" bigint,
  ADD COLUMN "cache_write_price_units_per_1m" bigint,
  ADD COLUMN "output_price_units_per_1m" bigint;
ALTER TABLE "provider_model_cost_tiers"
  ADD COLUMN "input_price_units_per_1m" bigint,
  ADD COLUMN "cached_input_price_units_per_1m" bigint,
  ADD COLUMN "cache_write_price_units_per_1m" bigint,
  ADD COLUMN "output_price_units_per_1m" bigint;
ALTER TABLE "provider_model_costs"
  ADD COLUMN "input_price_units_per_1m" bigint,
  ADD COLUMN "cached_input_price_units_per_1m" bigint,
  ADD COLUMN "cache_write_price_units_per_1m" bigint,
  ADD COLUMN "output_price_units_per_1m" bigint;

CREATE OR REPLACE FUNCTION "friday_relay_price_units_compat"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."input_price_units_per_1m" := COALESCE(NEW."input_price_units_per_1m", "friday_relay_usd_units"(NEW."input_per_1m"));
  NEW."cached_input_price_units_per_1m" := COALESCE(NEW."cached_input_price_units_per_1m", "friday_relay_usd_units"(NEW."cached_input_per_1m"));
  NEW."cache_write_price_units_per_1m" := CASE WHEN NEW."cache_write_per_1m" IS NULL THEN NULL ELSE COALESCE(NEW."cache_write_price_units_per_1m", "friday_relay_usd_units"(NEW."cache_write_per_1m")) END;
  NEW."output_price_units_per_1m" := COALESCE(NEW."output_price_units_per_1m", "friday_relay_usd_units"(NEW."output_per_1m"));
  IF NEW."input_price_units_per_1m" <> "friday_relay_usd_units"(NEW."input_per_1m")
     OR NEW."cached_input_price_units_per_1m" <> "friday_relay_usd_units"(NEW."cached_input_per_1m")
     OR NEW."output_price_units_per_1m" <> "friday_relay_usd_units"(NEW."output_per_1m")
     OR (NEW."cache_write_per_1m" IS NULL) <> (NEW."cache_write_price_units_per_1m" IS NULL)
     OR (NEW."cache_write_per_1m" IS NOT NULL AND NEW."cache_write_price_units_per_1m" <> "friday_relay_usd_units"(NEW."cache_write_per_1m")) THEN
    RAISE EXCEPTION 'Legacy price and USD units disagree' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'access_point_price_tiers', 'access_point_prices',
    'plan_access_point_price_tiers', 'plan_access_point_prices',
    'provider_model_cost_tiers', 'provider_model_costs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', table_name);
    EXECUTE format('UPDATE %I SET input_price_units_per_1m = "friday_relay_usd_units"(input_per_1m), cached_input_price_units_per_1m = "friday_relay_usd_units"(cached_input_per_1m), cache_write_price_units_per_1m = CASE WHEN cache_write_per_1m IS NULL THEN NULL ELSE "friday_relay_usd_units"(cache_write_per_1m) END, output_price_units_per_1m = "friday_relay_usd_units"(output_per_1m)', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', table_name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN input_price_units_per_1m SET NOT NULL, ALTER COLUMN cached_input_price_units_per_1m SET NOT NULL, ALTER COLUMN output_price_units_per_1m SET NOT NULL', table_name);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (input_price_units_per_1m >= 0 AND cached_input_price_units_per_1m >= 0 AND (cache_write_price_units_per_1m IS NULL OR cache_write_price_units_per_1m >= 0) AND output_price_units_per_1m >= 0)', table_name, table_name || '_usd_units_nonnegative_check');
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "friday_relay_price_units_compat"()', table_name || '_usd_units_compat', table_name);
  END LOOP;
END $$;

ALTER TABLE "plans" ADD COLUMN "purchase_amount_units" bigint;
ALTER TABLE "plans" DISABLE TRIGGER USER;
UPDATE "plans" SET "purchase_amount_units" = "friday_relay_usd_units"("purchase_amount");
ALTER TABLE "plans" ENABLE TRIGGER USER;
ALTER TABLE "plans" ALTER COLUMN "purchase_amount_units" SET NOT NULL;
ALTER TABLE "plans" ADD CONSTRAINT "plans_purchase_amount_units_check" CHECK ("purchase_amount_units" >= 0);

CREATE OR REPLACE FUNCTION "friday_relay_plan_units_compat"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."purchase_amount_units" := COALESCE(NEW."purchase_amount_units", "friday_relay_usd_units"(NEW."purchase_amount"));
  IF NEW."purchase_amount_units" <> "friday_relay_usd_units"(NEW."purchase_amount") THEN
    RAISE EXCEPTION 'Legacy Plan amount and USD units disagree' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "plans_usd_units_compat" BEFORE INSERT OR UPDATE ON "plans"
FOR EACH ROW EXECUTE FUNCTION "friday_relay_plan_units_compat"();

ALTER TABLE "budget_policies" ADD COLUMN "limit_amount_units" bigint;
ALTER TABLE "governance_budget_policies" ADD COLUMN "limit_amount_units" bigint;
ALTER TABLE "plan_budget_limits" ADD COLUMN "limit_amount_units" bigint;
ALTER TABLE "budget_policies" DISABLE TRIGGER USER;
ALTER TABLE "governance_budget_policies" DISABLE TRIGGER USER;
ALTER TABLE "plan_budget_limits" DISABLE TRIGGER USER;
UPDATE "budget_policies" SET "limit_amount_units" = CASE WHEN "metric" = 'amount' THEN "friday_relay_usd_units"("limit_value") ELSE NULL END;
UPDATE "governance_budget_policies" SET "limit_amount_units" = CASE WHEN "metric" = 'amount' THEN "friday_relay_usd_units"("limit_value") ELSE NULL END;
UPDATE "plan_budget_limits" SET "limit_amount_units" = CASE WHEN "metric" = 'amount' THEN "friday_relay_usd_units"("limit_value") ELSE NULL END;
ALTER TABLE "budget_policies" ENABLE TRIGGER USER;
ALTER TABLE "governance_budget_policies" ENABLE TRIGGER USER;
ALTER TABLE "plan_budget_limits" ENABLE TRIGGER USER;

CREATE OR REPLACE FUNCTION "friday_relay_budget_units_compat"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."metric" = 'amount' THEN
    NEW."limit_amount_units" := COALESCE(NEW."limit_amount_units", "friday_relay_usd_units"(NEW."limit_value"));
    IF NEW."limit_amount_units" <> "friday_relay_usd_units"(NEW."limit_value") OR NEW."limit_amount_units" < 0 THEN
      RAISE EXCEPTION 'Legacy budget amount and USD units disagree' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."limit_amount_units" IS NOT NULL THEN
    RAISE EXCEPTION 'Token budget cannot contain amount units' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "budget_policies_usd_units_compat" BEFORE INSERT OR UPDATE ON "budget_policies" FOR EACH ROW EXECUTE FUNCTION "friday_relay_budget_units_compat"();
CREATE TRIGGER "governance_budget_policies_usd_units_compat" BEFORE INSERT OR UPDATE ON "governance_budget_policies" FOR EACH ROW EXECUTE FUNCTION "friday_relay_budget_units_compat"();
CREATE TRIGGER "plan_budget_limits_usd_units_compat" BEFORE INSERT OR UPDATE ON "plan_budget_limits" FOR EACH ROW EXECUTE FUNCTION "friday_relay_budget_units_compat"();
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_amount_units_shape_check" CHECK (("metric" = 'amount') = ("limit_amount_units" IS NOT NULL));
ALTER TABLE "governance_budget_policies" ADD CONSTRAINT "governance_budget_policies_amount_units_shape_check" CHECK (("metric" = 'amount') = ("limit_amount_units" IS NOT NULL));
ALTER TABLE "plan_budget_limits" ADD CONSTRAINT "plan_budget_limits_amount_units_shape_check" CHECK (("metric" = 'amount') = ("limit_amount_units" IS NOT NULL));

ALTER TABLE "billing_access_point_edges" ADD COLUMN "amount_units" bigint;
ALTER TABLE "billing_provider_cost_events" ADD COLUMN "amount_units" bigint;
ALTER TABLE "billing_events" ADD COLUMN "billable_amount_units" bigint, ADD COLUMN "provider_cost_amount_units" bigint, ADD COLUMN "gross_margin_amount_units" bigint;
ALTER TABLE "billing_history_refs" ADD COLUMN "billable_amount_units" bigint, ADD COLUMN "provider_cost_amount_units" bigint, ADD COLUMN "gross_margin_amount_units" bigint;
ALTER TABLE "history_archive_fact_refs" ADD COLUMN "amount_units" bigint;
ALTER TABLE "billing_access_point_edges" DISABLE TRIGGER USER;
ALTER TABLE "billing_provider_cost_events" DISABLE TRIGGER USER;
ALTER TABLE "billing_events" DISABLE TRIGGER USER;
ALTER TABLE "billing_history_refs" DISABLE TRIGGER USER;
ALTER TABLE "history_archive_fact_refs" DISABLE TRIGGER USER;
UPDATE "billing_access_point_edges" SET "amount_units" = "friday_relay_usd_units"("amount");
UPDATE "billing_provider_cost_events" SET "amount_units" = "friday_relay_usd_units"("amount");
UPDATE "billing_events" SET "billable_amount_units" = "friday_relay_usd_units"("billable_amount"), "provider_cost_amount_units" = "friday_relay_usd_units"("provider_cost_amount"), "gross_margin_amount_units" = "friday_relay_usd_units"("gross_margin_amount");
UPDATE "billing_history_refs" SET "billable_amount_units" = "friday_relay_usd_units"("billable_amount"), "provider_cost_amount_units" = "friday_relay_usd_units"("provider_cost_amount"), "gross_margin_amount_units" = "friday_relay_usd_units"("gross_margin_amount");
UPDATE "history_archive_fact_refs" SET "amount_units" = CASE WHEN "amount" IS NULL THEN NULL ELSE "friday_relay_usd_units"("amount") END;
ALTER TABLE "billing_access_point_edges" ENABLE TRIGGER USER;
ALTER TABLE "billing_provider_cost_events" ENABLE TRIGGER USER;
ALTER TABLE "billing_events" ENABLE TRIGGER USER;
ALTER TABLE "billing_history_refs" ENABLE TRIGGER USER;
ALTER TABLE "history_archive_fact_refs" ENABLE TRIGGER USER;
ALTER TABLE "billing_access_point_edges" ALTER COLUMN "amount_units" SET NOT NULL;
ALTER TABLE "billing_provider_cost_events" ALTER COLUMN "amount_units" SET NOT NULL;
ALTER TABLE "billing_events" ALTER COLUMN "billable_amount_units" SET NOT NULL, ALTER COLUMN "provider_cost_amount_units" SET NOT NULL, ALTER COLUMN "gross_margin_amount_units" SET NOT NULL;
ALTER TABLE "billing_history_refs" ALTER COLUMN "billable_amount_units" SET NOT NULL, ALTER COLUMN "provider_cost_amount_units" SET NOT NULL, ALTER COLUMN "gross_margin_amount_units" SET NOT NULL;

CREATE OR REPLACE FUNCTION "friday_relay_single_amount_units_compat"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."amount_units" := COALESCE(NEW."amount_units", "friday_relay_usd_units"(NEW."amount"));
  IF NEW."amount_units" <> "friday_relay_usd_units"(NEW."amount") THEN RAISE EXCEPTION 'Legacy amount and USD units disagree' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "billing_access_point_edges_usd_units_compat" BEFORE INSERT OR UPDATE ON "billing_access_point_edges" FOR EACH ROW EXECUTE FUNCTION "friday_relay_single_amount_units_compat"();
CREATE TRIGGER "billing_provider_cost_events_usd_units_compat" BEFORE INSERT OR UPDATE ON "billing_provider_cost_events" FOR EACH ROW EXECUTE FUNCTION "friday_relay_single_amount_units_compat"();

CREATE OR REPLACE FUNCTION "friday_relay_billing_amount_units_compat"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."billable_amount_units" := COALESCE(NEW."billable_amount_units", "friday_relay_usd_units"(NEW."billable_amount"));
  NEW."provider_cost_amount_units" := COALESCE(NEW."provider_cost_amount_units", "friday_relay_usd_units"(NEW."provider_cost_amount"));
  NEW."gross_margin_amount_units" := COALESCE(NEW."gross_margin_amount_units", "friday_relay_usd_units"(NEW."gross_margin_amount"));
  IF NEW."billable_amount_units" <> "friday_relay_usd_units"(NEW."billable_amount")
     OR NEW."provider_cost_amount_units" <> "friday_relay_usd_units"(NEW."provider_cost_amount")
     OR NEW."gross_margin_amount_units" <> "friday_relay_usd_units"(NEW."gross_margin_amount") THEN
    RAISE EXCEPTION 'Legacy billing amounts and USD units disagree' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "billing_events_usd_units_compat" BEFORE INSERT OR UPDATE ON "billing_events" FOR EACH ROW EXECUTE FUNCTION "friday_relay_billing_amount_units_compat"();
CREATE TRIGGER "billing_history_refs_usd_units_compat" BEFORE INSERT OR UPDATE ON "billing_history_refs" FOR EACH ROW EXECUTE FUNCTION "friday_relay_billing_amount_units_compat"();

CREATE OR REPLACE FUNCTION "friday_relay_history_amount_units_compat"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."amount_units" := CASE WHEN NEW."amount" IS NULL THEN NULL ELSE COALESCE(NEW."amount_units", "friday_relay_usd_units"(NEW."amount")) END;
  IF (NEW."amount" IS NULL) <> (NEW."amount_units" IS NULL)
     OR (NEW."amount" IS NOT NULL AND NEW."amount_units" <> "friday_relay_usd_units"(NEW."amount")) THEN
    RAISE EXCEPTION 'Legacy archive amount and USD units disagree' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "history_archive_fact_refs_usd_units_compat" BEFORE INSERT OR UPDATE ON "history_archive_fact_refs" FOR EACH ROW EXECUTE FUNCTION "friday_relay_history_amount_units_compat"();
