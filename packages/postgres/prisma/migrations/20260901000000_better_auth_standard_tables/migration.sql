-- MODERNIZATION-12 Slice 1: add Better Auth's four standard tables and make
-- an idempotent, same-ID backfill from the pre-cutover users table.
--
-- The Friday users table remains the current business/auth source during this
-- additive slice. Canonical-email, credential-format, and collision checks are
-- a separate read-only operator preflight: this migration must remain
-- deployable on takeover fixtures that intentionally contain those facts.
-- Preserve every existing credential value in the standard account row. The
-- Better Auth verifier accepts only the project's scrypt format, so malformed
-- legacy values remain unusable until repaired without being silently dropped.

CREATE TABLE "user" (
  "id" text COLLATE "C" PRIMARY KEY NOT NULL,
  "name" text COLLATE "C" NOT NULL,
  "email" text COLLATE "C" NOT NULL,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text COLLATE "C",
  "created_at" timestamptz(3) NOT NULL,
  "updated_at" timestamptz(3) NOT NULL
);

CREATE UNIQUE INDEX "user_email_unique" ON "user" ("email");

CREATE TABLE "account" (
  "id" text COLLATE "C" PRIMARY KEY NOT NULL,
  "account_id" text COLLATE "C" NOT NULL,
  "provider_id" text COLLATE "C" NOT NULL,
  "user_id" text COLLATE "C" NOT NULL,
  "issuer" text COLLATE "C" NOT NULL,
  "access_token" text COLLATE "C",
  "refresh_token" text COLLATE "C",
  "id_token" text COLLATE "C",
  "access_token_expires_at" timestamptz(3),
  "refresh_token_expires_at" timestamptz(3),
  "scope" text COLLATE "C",
  "password" text COLLATE "C",
  "created_at" timestamptz(3) NOT NULL,
  "updated_at" timestamptz(3) NOT NULL,
  CONSTRAINT "account_user_id_user_fk" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "account_issuer_account_id_unique" ON "account" ("issuer", "account_id");
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");

CREATE TABLE "session" (
  "id" text COLLATE "C" PRIMARY KEY NOT NULL,
  "expires_at" timestamptz(3) NOT NULL,
  "token" text COLLATE "C" NOT NULL,
  "created_at" timestamptz(3) NOT NULL,
  "updated_at" timestamptz(3) NOT NULL,
  "ip_address" text COLLATE "C",
  "user_agent" text COLLATE "C",
  "user_id" text COLLATE "C" NOT NULL,
  CONSTRAINT "session_user_id_user_fk" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "session_token_unique" ON "session" ("token");
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");

CREATE TABLE "verification" (
  "id" text COLLATE "C" PRIMARY KEY NOT NULL,
  "identifier" text COLLATE "C" NOT NULL,
  "value" text COLLATE "C" NOT NULL,
  "expires_at" timestamptz(3) NOT NULL,
  "created_at" timestamptz(3) NOT NULL,
  "updated_at" timestamptz(3) NOT NULL
);

CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

INSERT INTO "user" ("id", "name", "email", "email_verified", "image", "created_at", "updated_at")
SELECT "id", 'Friday User ' || "id", "email", false, NULL, "created_at"::timestamptz, "updated_at"::timestamptz
FROM "users"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "account" (
  "id", "account_id", "provider_id", "user_id", "issuer", "password", "created_at", "updated_at"
)
SELECT
  'auth_account_' || "id", "id", 'credential', "id", 'local:credential', "password_hash",
  "created_at"::timestamptz, "updated_at"::timestamptz
FROM "users"
WHERE "password_hash" IS NOT NULL
ON CONFLICT ("issuer", "account_id") DO NOTHING;
