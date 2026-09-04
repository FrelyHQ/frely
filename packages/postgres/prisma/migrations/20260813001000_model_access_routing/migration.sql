-- Model Access first vertical slice: irreversible AccessPoint and target removal.
ALTER TABLE "access_points" ADD COLUMN "removed_at" text COLLATE "C";
ALTER TABLE "access_point_targets" ADD COLUMN "removed_at" text COLLATE "C";

-- CreateDisabledAccessPoint idempotency is owned by the AccessPoint row. The
-- key is scoped so different principals may safely use the same client token;
-- the canonical request hash detects accidental key reuse with new semantics.
ALTER TABLE "access_points"
  ADD COLUMN "creation_idempotency_key_hash" text COLLATE "C",
  ADD COLUMN "creation_request_hash" text COLLATE "C";

ALTER TABLE "access_points"
  ADD CONSTRAINT "access_points_removed_shape_check"
  CHECK ("removed_at" IS NULL OR "status" = 'disabled');
ALTER TABLE "access_point_targets"
  ADD CONSTRAINT "access_point_targets_removed_shape_check"
  CHECK ("removed_at" IS NULL OR "status" = 'disabled');

CREATE INDEX "access_points_scope_occupancy_idx"
  ON "access_points" ("scope_ref", "id")
  WHERE "removed_at" IS NULL;
CREATE UNIQUE INDEX "access_points_create_idempotency_unique"
  ON "access_points" ("scope_ref", "owner_id", "creation_idempotency_key_hash")
  WHERE "creation_idempotency_key_hash" IS NOT NULL;
ALTER TABLE "access_point_prices"
  ADD COLUMN "initial_price" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "access_point_prices_initial_boolean_check" CHECK ("initial_price" IN (0, 1));
CREATE UNIQUE INDEX "access_point_prices_initial_unique"
  ON "access_point_prices" ("access_point_id")
  WHERE "initial_price" = 1;
CREATE INDEX "access_point_targets_inbound_active_idx"
  ON "access_point_targets" ("target_access_point_id", "access_point_id", "id")
  WHERE "removed_at" IS NULL AND "target_access_point_id" IS NOT NULL;
CREATE UNIQUE INDEX "access_point_targets_enabled_position_unique"
  ON "access_point_targets" ("access_point_id", "position")
  WHERE "removed_at" IS NULL AND "status" = 'enabled';

CREATE OR REPLACE FUNCTION "friday_relay_access_point_removal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."removed_at" IS NOT NULL AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION 'Removed AccessPoint is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."removed_at" IS NULL AND NEW."removed_at" IS NOT NULL THEN
    IF NEW."status" <> 'disabled' THEN
      RAISE EXCEPTION 'AccessPoint must be disabled before removal' USING ERRCODE = '23514';
    END IF;
    IF (to_jsonb(OLD) - 'removed_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'removed_at' - 'updated_at') THEN
      RAISE EXCEPTION 'RemoveAccessPoint may only set removed_at' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "access_points_removal_guard"
  BEFORE UPDATE ON "access_points"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_access_point_removal_guard"();

CREATE OR REPLACE FUNCTION "friday_relay_access_point_target_removal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."removed_at" IS NOT NULL AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    RAISE EXCEPTION 'Removed AccessPointTarget is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."removed_at" IS NULL AND NEW."removed_at" IS NOT NULL AND NEW."status" <> 'disabled' THEN
    RAISE EXCEPTION 'AccessPointTarget must be disabled before removal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "access_point_targets_removal_guard"
  BEFORE UPDATE ON "access_point_targets"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_access_point_target_removal_guard"();

DROP TRIGGER IF EXISTS "access_point_targets_immutable_update" ON "access_point_targets";
CREATE TRIGGER "access_point_targets_immutable_update"
  BEFORE UPDATE ON "access_point_targets"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_immutable_update"(
    'AccessPoint target identity cannot be updated',
    'position', 'status', 'removed_at', 'updated_at'
  );

CREATE TRIGGER "access_points_no_delete"
  BEFORE DELETE ON "access_points"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_delete"();
CREATE TRIGGER "access_point_targets_no_delete"
  BEFORE DELETE ON "access_point_targets"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_delete"();
