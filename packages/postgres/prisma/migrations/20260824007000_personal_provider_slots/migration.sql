-- Add the personal Provider-slot product without rewriting existing Commerce,
-- Provider, AccessPoint, Plan, Subscription, or history rows.

ALTER TABLE "authority_products" DROP CONSTRAINT "authority_products_effect_check";
ALTER TABLE "authority_products" ADD CONSTRAINT "authority_products_effect_check"
  CHECK ("effect_code" IN ('team_create_unit', 'team_custom_provider_access', 'user_custom_provider_access'));
ALTER TABLE "authority_products" DROP CONSTRAINT "authority_products_effect_terms_check";
ALTER TABLE "authority_products" ADD CONSTRAINT "authority_products_effect_terms_check" CHECK (
  "effect_code" = 'team_create_unit'
  OR (
    "effect_code" IN ('team_custom_provider_access', 'user_custom_provider_access')
    AND "grant_units" = 1
    AND "max_unconsumed_units_per_user" IS NULL
    AND "max_current_owned_teams" IS NULL
    AND "max_lifetime_created_teams" IS NULL
    AND "refund_mode" = 'none'
    AND "refund_deadline_seconds" IS NULL
    AND ("effect_code" <> 'user_custom_provider_access' OR (
      ("max_lifetime_purchases_per_user" IS NULL OR "max_lifetime_purchases_per_user" >= 2)
      AND "grant_duration_seconds" % 86400 = 0
    ))
  )
);

ALTER TABLE "authority_purchases" DROP CONSTRAINT "authority_purchases_effect_check";
ALTER TABLE "authority_purchases" ADD CONSTRAINT "authority_purchases_effect_check"
  CHECK ("effect_code" IN ('team_create_unit', 'team_custom_provider_access', 'user_custom_provider_access'));
ALTER TABLE "authority_purchases" DROP CONSTRAINT "authority_purchases_effect_terms_check";
ALTER TABLE "authority_purchases" ADD CONSTRAINT "authority_purchases_effect_terms_check" CHECK (
  "effect_code" = 'team_create_unit'
  OR (
    "effect_code" IN ('team_custom_provider_access', 'user_custom_provider_access')
    AND "grant_units" = 1
    AND "max_unconsumed_units_per_user" IS NULL
    AND "max_current_owned_teams" IS NULL
    AND "max_lifetime_created_teams" IS NULL
    AND "refund_mode" = 'none'
    AND "refund_deadline_seconds" IS NULL
    AND ("effect_code" <> 'user_custom_provider_access' OR (
      ("max_lifetime_purchases_per_user" IS NULL OR "max_lifetime_purchases_per_user" >= 2)
      AND "grant_duration_seconds" % 86400 = 0
    ))
  )
);

CREATE TABLE "user_provider_slots" (
  "id" text COLLATE "C" PRIMARY KEY NOT NULL,
  "user_id" text COLLATE "C" NOT NULL,
  "managed_plan_id" text COLLATE "C" NOT NULL,
  "provider_id" text COLLATE "C",
  "created_by_authority_purchase_id" text COLLATE "C" NOT NULL,
  "retention_expired_at" text COLLATE "C",
  "cleanup_status" text COLLATE "C" NOT NULL DEFAULT 'not_due',
  "cleanup_error_code" text COLLATE "C",
  "cleanup_updated_at" text COLLATE "C",
  "created_at" text COLLATE "C" NOT NULL,
  CONSTRAINT "user_provider_slots_cleanup_shape_check" CHECK (
    ("retention_expired_at" IS NULL AND "cleanup_status" = 'not_due' AND "cleanup_error_code" IS NULL)
    OR ("retention_expired_at" IS NOT NULL AND "cleanup_status" IN ('pending', 'blocked', 'complete'))
  ),
  CONSTRAINT "user_provider_slots_cleanup_error_check" CHECK (
    ("cleanup_status" = 'blocked' AND "cleanup_error_code" IS NOT NULL)
    OR ("cleanup_status" <> 'blocked' AND "cleanup_error_code" IS NULL)
  )
);

CREATE UNIQUE INDEX "user_provider_slots_managed_plan_unique" ON "user_provider_slots" ("managed_plan_id");
CREATE UNIQUE INDEX "user_provider_slots_provider_unique" ON "user_provider_slots" ("provider_id") WHERE "provider_id" IS NOT NULL;
CREATE UNIQUE INDEX "user_provider_slots_purchase_unique" ON "user_provider_slots" ("created_by_authority_purchase_id");
CREATE INDEX "user_provider_slots_user_created_idx" ON "user_provider_slots" ("user_id", "created_at", "id");
CREATE INDEX "user_provider_slots_cleanup_idx" ON "user_provider_slots" ("cleanup_status", "retention_expired_at", "id");

ALTER TABLE "user_provider_slots" ADD CONSTRAINT "user_provider_slots_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "user_provider_slots" ADD CONSTRAINT "user_provider_slots_managed_plan_id_fk"
  FOREIGN KEY ("managed_plan_id") REFERENCES "plans" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "user_provider_slots" ADD CONSTRAINT "user_provider_slots_provider_id_fk"
  FOREIGN KEY ("provider_id") REFERENCES "providers" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "user_provider_slots" ADD CONSTRAINT "user_provider_slots_purchase_id_fk"
  FOREIGN KEY ("created_by_authority_purchase_id") REFERENCES "authority_purchases" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE "user_provider_entitlement_periods" (
  "id" text COLLATE "C" PRIMARY KEY NOT NULL,
  "provider_slot_id" text COLLATE "C" NOT NULL,
  "user_id" text COLLATE "C" NOT NULL,
  "source_authority_purchase_id" text COLLATE "C" NOT NULL,
  "source_authority_product_id" text COLLATE "C" NOT NULL,
  "source_product_code_snapshot" text COLLATE "C" NOT NULL,
  "source_product_version_snapshot" integer NOT NULL,
  "source_product_display_name_snapshot" text COLLATE "C" NOT NULL,
  "purchase_amount_units_snapshot" bigint NOT NULL,
  "duration_days_snapshot" integer NOT NULL,
  "renewal_admitted_at" text COLLATE "C" NOT NULL,
  "fulfillment_succeeded_at" text COLLATE "C" NOT NULL,
  "effective_start" text COLLATE "C" NOT NULL,
  "effective_end" text COLLATE "C" NOT NULL,
  "plan_subscription_id" text COLLATE "C" NOT NULL,
  "lifecycle" text COLLATE "C" NOT NULL DEFAULT 'active',
  "created_at" text COLLATE "C" NOT NULL,
  CONSTRAINT "user_provider_entitlement_periods_duration_check" CHECK ("duration_days_snapshot" BETWEEN 1 AND 3650),
  CONSTRAINT "user_provider_entitlement_periods_lifecycle_check" CHECK ("lifecycle" = 'active'),
  CONSTRAINT "user_provider_entitlement_periods_window_check" CHECK (
    "effective_start" < "effective_end"
    AND "renewal_admitted_at" <= "fulfillment_succeeded_at"
  )
);

CREATE UNIQUE INDEX "user_provider_entitlement_periods_purchase_unique" ON "user_provider_entitlement_periods" ("source_authority_purchase_id");
CREATE UNIQUE INDEX "user_provider_entitlement_periods_subscription_unique" ON "user_provider_entitlement_periods" ("plan_subscription_id");
CREATE INDEX "user_provider_entitlement_periods_slot_end_idx" ON "user_provider_entitlement_periods" ("provider_slot_id", "effective_end", "id");
CREATE INDEX "user_provider_entitlement_periods_user_end_idx" ON "user_provider_entitlement_periods" ("user_id", "effective_end", "id");

ALTER TABLE "user_provider_entitlement_periods" ADD CONSTRAINT "user_provider_entitlement_periods_slot_id_fk"
  FOREIGN KEY ("provider_slot_id") REFERENCES "user_provider_slots" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "user_provider_entitlement_periods" ADD CONSTRAINT "user_provider_entitlement_periods_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "user_provider_entitlement_periods" ADD CONSTRAINT "user_provider_entitlement_periods_purchase_id_fk"
  FOREIGN KEY ("source_authority_purchase_id") REFERENCES "authority_purchases" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "user_provider_entitlement_periods" ADD CONSTRAINT "user_provider_entitlement_periods_product_id_fk"
  FOREIGN KEY ("source_authority_product_id") REFERENCES "authority_products" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "user_provider_entitlement_periods" ADD CONSTRAINT "user_provider_entitlement_periods_subscription_id_fk"
  FOREIGN KEY ("plan_subscription_id") REFERENCES "plan_subscriptions" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "access_points" ADD COLUMN "personal_provider_slot_id" text COLLATE "C";
ALTER TABLE "access_points" ADD CONSTRAINT "access_points_personal_provider_slot_id_fk"
  FOREIGN KEY ("personal_provider_slot_id") REFERENCES "user_provider_slots" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "access_points_personal_slot_occupancy_idx"
  ON "access_points" ("personal_provider_slot_id", "id")
  WHERE "personal_provider_slot_id" IS NOT NULL AND "removed_at" IS NULL;

CREATE OR REPLACE FUNCTION "friday_relay_reject_user_provider_entitlement_period_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'user_provider_entitlement_periods are append-only';
END;
$$;
CREATE TRIGGER "user_provider_entitlement_periods_append_only_update"
  BEFORE UPDATE ON "user_provider_entitlement_periods"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_user_provider_entitlement_period_mutation"();
CREATE TRIGGER "user_provider_entitlement_periods_append_only_delete"
  BEFORE DELETE ON "user_provider_entitlement_periods"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_user_provider_entitlement_period_mutation"();

CREATE OR REPLACE FUNCTION "friday_relay_guard_user_provider_slot_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."managed_plan_id" IS DISTINCT FROM OLD."managed_plan_id"
    OR NEW."created_by_authority_purchase_id" IS DISTINCT FROM OLD."created_by_authority_purchase_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'user_provider_slot identity is immutable';
  END IF;
  IF OLD."retention_expired_at" IS NOT NULL AND NEW."retention_expired_at" IS DISTINCT FROM OLD."retention_expired_at" THEN
    RAISE EXCEPTION 'user_provider_slot terminal fact is immutable';
  END IF;
  IF OLD."retention_expired_at" IS NOT NULL AND NEW."provider_id" IS DISTINCT FROM OLD."provider_id" AND NEW."provider_id" IS NOT NULL THEN
    RAISE EXCEPTION 'terminal user_provider_slot cannot bind a Provider';
  END IF;
  IF OLD."cleanup_status" = 'complete' AND NEW."cleanup_status" <> 'complete' THEN
    RAISE EXCEPTION 'completed user_provider_slot cleanup cannot reopen';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "user_provider_slots_transition_guard"
  BEFORE UPDATE ON "user_provider_slots"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_user_provider_slot_transition"();

CREATE OR REPLACE FUNCTION "friday_relay_guard_personal_access_point_slot"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  slot_user_id text;
  slot_provider_id text;
  slot_retention_expired_at text;
  occupied_count bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."personal_provider_slot_id" IS DISTINCT FROM OLD."personal_provider_slot_id" THEN
    RAISE EXCEPTION 'AccessPoint personal Provider slot is immutable';
  END IF;
  IF NEW."personal_provider_slot_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "user_id", "provider_id", "retention_expired_at"
    INTO slot_user_id, slot_provider_id, slot_retention_expired_at
    FROM "user_provider_slots"
    WHERE "id" = NEW."personal_provider_slot_id"
    FOR UPDATE;
  IF NOT FOUND OR slot_provider_id IS NULL THEN
    RAISE EXCEPTION 'personal AccessPoint requires a slot-bound Provider';
  END IF;
  IF slot_retention_expired_at IS NOT NULL AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'terminal personal Provider slot cannot accept AccessPoints';
  END IF;
  IF slot_retention_expired_at IS NOT NULL AND TG_OP = 'UPDATE'
    AND OLD."removed_at" IS NOT NULL AND NEW."removed_at" IS NULL THEN
    RAISE EXCEPTION 'terminal personal Provider slot cannot reactivate AccessPoints';
  END IF;
  IF NEW."owner_id" <> slot_user_id OR NEW."scope_ref" <> ('user:' || slot_user_id) THEN
    RAISE EXCEPTION 'personal AccessPoint owner and scope must match its slot';
  END IF;
  IF NEW."removed_at" IS NULL THEN
    SELECT COUNT(*) INTO occupied_count
      FROM "access_points"
      WHERE "personal_provider_slot_id" = NEW."personal_provider_slot_id"
        AND "removed_at" IS NULL
        AND "id" <> NEW."id";
    IF occupied_count >= 100 THEN
      RAISE EXCEPTION 'personal Provider slot AccessPoint limit reached';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "access_points_personal_slot_guard"
  BEFORE INSERT OR UPDATE ON "access_points"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_personal_access_point_slot"();

CREATE OR REPLACE FUNCTION "friday_relay_validate_personal_access_point_target"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_access_point_id text;
  slot_provider_id text;
  target_count bigint;
  matched_count bigint;
BEGIN
  IF TG_ARGV[0] = 'target' THEN
    IF TG_OP = 'DELETE' THEN checked_access_point_id := OLD."access_point_id";
    ELSE checked_access_point_id := NEW."access_point_id";
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN checked_access_point_id := OLD."id";
    ELSE checked_access_point_id := NEW."id";
    END IF;
  END IF;
  SELECT slot."provider_id" INTO slot_provider_id
    FROM "access_points" ap
    JOIN "user_provider_slots" slot ON slot."id" = ap."personal_provider_slot_id"
    WHERE ap."id" = checked_access_point_id AND ap."removed_at" IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COUNT(*), COUNT(*) FILTER (WHERE target."target_type" = 'provider-model'
      AND target."target_provider_id" = slot_provider_id
      AND model."id" = target."target_provider_model_id"
      AND model."provider_id" = slot_provider_id
      AND model."provider_model_name" = target."target_provider_model_name")
    INTO target_count, matched_count
    FROM "access_point_targets" target
    LEFT JOIN "provider_models" model ON model."id" = target."target_provider_model_id"
    WHERE target."access_point_id" = checked_access_point_id AND target."removed_at" IS NULL;
  IF target_count <> 1 OR matched_count <> 1 THEN
    RAISE EXCEPTION 'personal AccessPoint must target exactly one ProviderModel belonging to its slot Provider';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "access_points_personal_target_guard"
  AFTER INSERT OR UPDATE ON "access_points"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_validate_personal_access_point_target"('access_point');
CREATE CONSTRAINT TRIGGER "access_point_targets_personal_slot_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "access_point_targets"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_validate_personal_access_point_target"('target');

CREATE OR REPLACE FUNCTION "friday_relay_guard_slot_bound_provider"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user_provider_slots" WHERE "provider_id" = OLD."id") AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
    OR NEW."scope_ref" IS DISTINCT FROM OLD."scope_ref"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."base_url_resolver" IS DISTINCT FROM OLD."base_url_resolver"
    OR NEW."credential_resolver" IS DISTINCT FROM OLD."credential_resolver"
    OR NEW."models_resolver" IS DISTINCT FROM OLD."models_resolver"
    OR NEW."config_json" IS DISTINCT FROM OLD."config_json"
    OR NEW."cpa_instance_id" IS DISTINCT FROM OLD."cpa_instance_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'slot-bound personal Provider definition is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "providers_personal_slot_definition_guard"
  BEFORE UPDATE ON "providers"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_slot_bound_provider"();

CREATE OR REPLACE FUNCTION "friday_relay_guard_slot_bound_provider_binding"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user_provider_slots" WHERE "provider_id" = NEW."provider_id")
    AND (NEW."auth_method" <> 'oauth' OR NEW."credential_ownership" <> 'cpa-managed') THEN
    RAISE EXCEPTION 'slot-bound personal Provider binding must remain CPA-managed OAuth';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "provider_bindings_personal_slot_guard"
  BEFORE INSERT OR UPDATE ON "provider_bindings"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_slot_bound_provider_binding"();

CREATE OR REPLACE FUNCTION "friday_relay_validate_personal_provider_slot_binding"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  provider_matches boolean;
BEGIN
  IF NEW."provider_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT TRUE INTO provider_matches
    FROM "providers" provider
    JOIN "provider_bindings" binding ON binding."provider_id" = provider."id"
    WHERE provider."id" = NEW."provider_id"
      AND provider."owner_id" = NEW."user_id"
      AND provider."scope_ref" = ('user:' || NEW."user_id")
      AND provider."kind" = 'codex'
      AND provider."base_url_resolver" = 'literal:'
      AND provider."credential_resolver" = 'oauth:'
      AND provider."models_resolver" = 'cliproxyapi:catalog'
      AND provider."config_json" = '{}'
      AND provider."cpa_instance_id" = 'cpa_default'
      AND binding."auth_method" = 'oauth'
      AND binding."credential_ownership" = 'cpa-managed';
  IF provider_matches IS NOT TRUE THEN
    RAISE EXCEPTION 'personal Provider slot requires the fixed server-managed Codex OAuth definition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "user_provider_slots_provider_binding_guard"
  BEFORE INSERT OR UPDATE OF "provider_id" ON "user_provider_slots"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_validate_personal_provider_slot_binding"();
