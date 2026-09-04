-- B2-0 expand: make ProviderModel logical identity physical and give each
-- authoritative Provider-model routing edge a stable ProviderModelId while
-- retaining the legacy Provider/name pair for mixed-version readers/writers.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "provider_models"
    GROUP BY "provider_id", "provider_model_name"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'ProviderModel identity is ambiguous; repair duplicates before B2-0 migration'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "access_point_targets" target
    LEFT JOIN "provider_models" model
      ON model."provider_id" = target."target_provider_id"
     AND model."provider_model_name" = target."target_provider_model_name"
    WHERE target."target_type" = 'provider-model'
      AND model."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Provider-model AccessPointTarget cannot resolve a stable ProviderModelId'
      USING ERRCODE = '23503';
  END IF;
END $$;

CREATE UNIQUE INDEX "provider_models_provider_identity_unique"
  ON "provider_models" ("provider_id", "provider_model_name");

ALTER TABLE "access_point_targets"
  ADD COLUMN "target_provider_model_id" text COLLATE "C";

-- Existing removal/identity guards intentionally reject identity updates.
-- Disable them only for the bounded in-migration backfill, then restore them.
DROP TRIGGER "access_point_targets_removal_guard" ON "access_point_targets";
DROP TRIGGER "access_point_targets_immutable_update" ON "access_point_targets";

UPDATE "access_point_targets" target
SET "target_provider_model_id" = model."id"
FROM "provider_models" model
WHERE target."target_type" = 'provider-model'
  AND model."provider_id" = target."target_provider_id"
  AND model."provider_model_name" = target."target_provider_model_name";

CREATE OR REPLACE FUNCTION "friday_relay_resolve_access_point_target_provider_model"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  resolved_provider_model_id text;
BEGIN
  IF NEW."target_type" = 'access-point' THEN
    IF NEW."target_provider_model_id" IS NOT NULL THEN
      RAISE EXCEPTION 'AccessPoint target cannot carry ProviderModelId'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT model."id"
  INTO resolved_provider_model_id
  FROM "provider_models" model
  WHERE model."provider_id" = NEW."target_provider_id"
    AND model."provider_model_name" = NEW."target_provider_model_name";

  IF resolved_provider_model_id IS NULL THEN
    RAISE EXCEPTION 'Provider-model AccessPointTarget cannot resolve ProviderModelId'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."target_provider_model_id" IS NULL THEN
    NEW."target_provider_model_id" := resolved_provider_model_id;
  ELSIF NEW."target_provider_model_id" IS DISTINCT FROM resolved_provider_model_id THEN
    RAISE EXCEPTION 'ProviderModelId does not match the legacy Provider/model reference'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "access_point_targets_provider_model_reference"
  BEFORE INSERT ON "access_point_targets"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_resolve_access_point_target_provider_model"();

ALTER TABLE "access_point_targets"
  ADD CONSTRAINT "access_point_targets_provider_model_fk"
    FOREIGN KEY ("target_provider_model_id") REFERENCES "provider_models" ("id")
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "access_point_targets_provider_model_id_shape_check" CHECK (
    ("target_type" = 'access-point' AND "target_provider_model_id" IS NULL)
    OR
    ("target_type" = 'provider-model' AND "target_provider_model_id" IS NOT NULL)
  );

CREATE INDEX "access_point_targets_target_provider_model_id_idx"
  ON "access_point_targets" ("target_provider_model_id", "access_point_id", "id")
  WHERE "target_provider_model_id" IS NOT NULL;

CREATE TRIGGER "access_point_targets_removal_guard"
  BEFORE UPDATE ON "access_point_targets"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_access_point_target_removal_guard"();
CREATE TRIGGER "access_point_targets_immutable_update"
  BEFORE UPDATE ON "access_point_targets"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_reject_immutable_update"(
    'AccessPoint target identity cannot be updated',
    'position', 'status', 'removed_at', 'updated_at'
  );
