-- Slice 3 structural cutover: the former users table becomes the Friday
-- control-plane table. Better Auth identity rows were backfilled by the
-- preceding migration and remain the only email/password/session authority.
ALTER TABLE "users" RENAME TO "user_controls";
ALTER INDEX "users_team_idx" RENAME TO "user_controls_team_idx";
DROP INDEX "users_email_unique";

-- Keep the identity/control relationship one-to-one while creating the
-- foreign key on the Better Auth side so controls can be inserted before the
-- standard user row in a single application transaction.
ALTER TABLE "user"
  ADD CONSTRAINT "user_controls_id_user_fk"
  FOREIGN KEY ("id") REFERENCES "user_controls" ("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Friday refresh tokens are the legacy session authority. Better Auth owns
-- every post-cutover session, so no pre-cutover refresh credential may remain
-- usable after the structural cutover.
DELETE FROM "refresh_tokens";

-- Keep the former columns nullable and frozen during the rollback window.
-- Better Auth is already the sole runtime identity/credential writer; a
-- later cleanup migration may remove these copies after the stable window.
ALTER TABLE "user_controls"
  ALTER COLUMN "email" DROP NOT NULL,
  ALTER COLUMN "password_hash" DROP NOT NULL;
