ALTER TABLE "identity_migration_batches"
  ADD COLUMN IF NOT EXISTS "snapshot_digest" text COLLATE "C",
  ADD COLUMN IF NOT EXISTS "observed_user_count" integer;

-- No operational runner existed before this expand migration. A sentinel keeps
-- an unexpectedly pre-existing batch fail-closed instead of inventing evidence.
UPDATE "identity_migration_batches"
SET "snapshot_digest" = repeat('0', 64),
    "observed_user_count" = 0
WHERE "snapshot_digest" IS NULL OR "observed_user_count" IS NULL;

ALTER TABLE "identity_migration_batches"
  ALTER COLUMN "snapshot_digest" SET NOT NULL,
  ALTER COLUMN "observed_user_count" SET NOT NULL;

ALTER TABLE "identity_migration_batches"
  DROP CONSTRAINT IF EXISTS "identity_migration_batches_snapshot_digest_check",
  ADD CONSTRAINT "identity_migration_batches_snapshot_digest_check"
    CHECK ("snapshot_digest" ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS "identity_migration_batches_observed_user_count_check",
  ADD CONSTRAINT "identity_migration_batches_observed_user_count_check"
    CHECK ("observed_user_count" >= 0);

CREATE OR REPLACE FUNCTION "friday_relay_validate_identity_migration_batch_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = NEW."status" AND (
    OLD."started_at" IS DISTINCT FROM NEW."started_at"
    OR OLD."completed_at" IS DISTINCT FROM NEW."completed_at"
  ) THEN
    RAISE EXCEPTION 'identity migration batch same-state mutation is forbidden' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    OLD."status" = NEW."status"
    OR (OLD."status" = 'preflighted' AND NEW."status" = 'running' AND NEW."started_at" IS NOT NULL AND NEW."completed_at" IS NULL)
    OR (OLD."status" = 'running' AND NEW."status" IN ('completed', 'completed_with_frozen') AND NEW."started_at" IS NOT NULL AND NEW."completed_at" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'invalid identity migration batch transition' USING ERRCODE = '55000';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."migration_kind" IS DISTINCT FROM NEW."migration_kind"
    OR OLD."rule_version" IS DISTINCT FROM NEW."rule_version"
    OR OLD."snapshot_digest" IS DISTINCT FROM NEW."snapshot_digest"
    OR OLD."observed_user_count" IS DISTINCT FROM NEW."observed_user_count"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'identity migration batch immutable fields changed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
