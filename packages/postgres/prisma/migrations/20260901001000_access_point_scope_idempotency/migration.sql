DROP INDEX IF EXISTS "access_points_create_idempotency_unique";

CREATE UNIQUE INDEX "access_points_create_idempotency_unique"
  ON "access_points" ("scope_ref", "creation_idempotency_key_hash")
  WHERE "creation_idempotency_key_hash" IS NOT NULL;
