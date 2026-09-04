CREATE TABLE "api_key_plan_source_restrictions" (
    "api_key_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'restricted',
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    CONSTRAINT "api_key_plan_source_restrictions_pkey" PRIMARY KEY ("api_key_id"),
    CONSTRAINT "api_key_plan_source_restrictions_api_key_fk"
      FOREIGN KEY ("api_key_id") REFERENCES "api_keys" ("id")
      ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "api_key_plan_source_restrictions_mode_check" CHECK ("mode" = 'restricted')
);

CREATE TABLE "api_key_plan_source_selections" (
    "id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "subscription_scope_ref" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "api_key_plan_source_selections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_key_plan_source_selections_restriction_fk"
      FOREIGN KEY ("api_key_id") REFERENCES "api_key_plan_source_restrictions" ("api_key_id")
      ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "api_key_plan_source_selections_unique"
      UNIQUE ("api_key_id", "plan_id", "subscription_scope_ref")
);

CREATE INDEX "api_key_plan_source_selections_lookup_idx"
  ON "api_key_plan_source_selections" ("api_key_id", "plan_id", "subscription_scope_ref");

CREATE TABLE "api_key_team_scope_selections" (
    "id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "api_key_team_scope_selections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_key_team_scope_selections_restriction_fk"
      FOREIGN KEY ("api_key_id") REFERENCES "api_key_plan_source_restrictions" ("api_key_id")
      ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "api_key_team_scope_selections_unique"
      UNIQUE ("api_key_id", "team_id")
);

CREATE INDEX "api_key_team_scope_selections_lookup_idx"
  ON "api_key_team_scope_selections" ("api_key_id", "team_id");
