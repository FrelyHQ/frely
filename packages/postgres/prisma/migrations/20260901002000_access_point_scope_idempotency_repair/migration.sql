DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "scope_ref", "creation_idempotency_key_hash"
      FROM "access_points"
      WHERE "creation_idempotency_key_hash" IS NOT NULL
      GROUP BY "scope_ref", "creation_idempotency_key_hash"
      HAVING COUNT(DISTINCT "owner_id") > 1
    ) legacy_duplicates
  ) THEN
    RAISE EXCEPTION 'access_point_scope_idempotency_legacy_duplicates';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "access_points_create_idempotency_unique"
  ON "access_points" ("scope_ref", "creation_idempotency_key_hash")
  WHERE "creation_idempotency_key_hash" IS NOT NULL;
