ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "migration_frozen_at" text COLLATE "C";
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "migration_freeze_reason" text COLLATE "C";

CREATE TABLE IF NOT EXISTS "identity_migration_batches" (
  "id" text COLLATE "C" PRIMARY KEY NOT NULL,
  "migration_kind" text COLLATE "C" NOT NULL,
  "rule_version" text COLLATE "C" NOT NULL,
  "status" text COLLATE "C" NOT NULL,
  "created_at" text COLLATE "C" NOT NULL,
  "started_at" text COLLATE "C",
  "completed_at" text COLLATE "C",
  CONSTRAINT "identity_migration_batches_kind_check" CHECK ("migration_kind" = 'canonical_email_v1'),
  CONSTRAINT "identity_migration_batches_rule_check" CHECK ("rule_version" = 'canonical-email-v1'),
  CONSTRAINT "identity_migration_batches_status_check" CHECK ("status" IN ('preflighted', 'running', 'completed', 'completed_with_frozen'))
);

CREATE TABLE IF NOT EXISTS "identity_migration_records" (
  "id" text COLLATE "C" PRIMARY KEY NOT NULL,
  "batch_id" text COLLATE "C" NOT NULL,
  "email_fingerprint" text COLLATE "C" NOT NULL,
  "source_user_id" text COLLATE "C" NOT NULL,
  "survivor_user_id" text COLLATE "C" NOT NULL,
  "outcome" text COLLATE "C" NOT NULL,
  "conflict_types_json" text COLLATE "C" NOT NULL,
  "created_at" text COLLATE "C" NOT NULL,
  CONSTRAINT "identity_migration_records_fingerprint_check" CHECK ("email_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "identity_migration_records_outcome_check" CHECK ("outcome" IN ('canonicalize_pending', 'merge_pending', 'freeze_pending', 'canonicalized', 'merged', 'frozen')),
  CONSTRAINT "identity_migration_records_conflicts_json_check" CHECK (jsonb_typeof("conflict_types_json"::jsonb) = 'array')
);

DO $$ BEGIN
  ALTER TABLE "identity_migration_records"
    ADD CONSTRAINT "identity_migration_records_batch_id_fk"
    FOREIGN KEY ("batch_id") REFERENCES "identity_migration_batches" ("id")
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "identity_migration_batches_kind_created_idx"
  ON "identity_migration_batches" ("migration_kind", "created_at", "id");
CREATE INDEX IF NOT EXISTS "identity_migration_records_batch_created_idx"
  ON "identity_migration_records" ("batch_id", "created_at", "id");
CREATE INDEX IF NOT EXISTS "identity_migration_records_source_created_idx"
  ON "identity_migration_records" ("source_user_id", "created_at", "id");

DROP TRIGGER IF EXISTS "identity_migration_records_no_update" ON "identity_migration_records";
DROP TRIGGER IF EXISTS "identity_migration_records_no_delete" ON "identity_migration_records";
CREATE TRIGGER "identity_migration_records_no_update"
  BEFORE UPDATE ON "identity_migration_records" FOR EACH ROW
  EXECUTE FUNCTION "friday_relay_reject_append_only_mutation"();
CREATE TRIGGER "identity_migration_records_no_delete"
  BEFORE DELETE ON "identity_migration_records" FOR EACH ROW
  EXECUTE FUNCTION "friday_relay_reject_append_only_mutation"();

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
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'identity migration batch immutable fields changed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "identity_migration_batches_transition" ON "identity_migration_batches";
CREATE TRIGGER "identity_migration_batches_transition"
  BEFORE UPDATE ON "identity_migration_batches" FOR EACH ROW
  EXECUTE FUNCTION "friday_relay_validate_identity_migration_batch_transition"();
DROP TRIGGER IF EXISTS "identity_migration_batches_no_delete" ON "identity_migration_batches";
CREATE TRIGGER "identity_migration_batches_no_delete"
  BEFORE DELETE ON "identity_migration_batches" FOR EACH ROW
  EXECUTE FUNCTION "friday_relay_reject_append_only_mutation"();
