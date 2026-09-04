-- Resulting inventory digest: b22d7fe6158ce70bbf003095d1fa8454e96c520599f8007dc141b95fffc61c93.
DO $$
BEGIN
  IF to_regclass('friday_relay_task_leases') IS NULL
     AND to_regclass('friday_relay_job_leases') IS NOT NULL THEN
    ALTER TABLE "friday_relay_job_leases" RENAME TO "friday_relay_task_leases";
    ALTER TABLE "friday_relay_task_leases" RENAME COLUMN "job_key" TO "task_key";
    ALTER TABLE "friday_relay_task_leases" RENAME CONSTRAINT "friday_relay_job_leases_pkey" TO "friday_relay_task_leases_pkey";
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "seller_settlement_events_release_candidate_idx"
  ON "seller_settlement_events" ("release_at", "plan_subscription_id", "authority_purchase_id", "seller_scope_ref", "window_start")
  WHERE "event_type" = 'revenue';
CREATE INDEX IF NOT EXISTS "seller_settlement_events_state_idx"
  ON "seller_settlement_events" ("plan_subscription_id", "authority_purchase_id", "seller_scope_ref", "window_start", "event_type");
CREATE INDEX IF NOT EXISTS "budget_claims_settlement_idx"
  ON "budget_claims" ("plan_subscription_id", "provider_attempt_id");
CREATE TABLE IF NOT EXISTS "seller_settlement_backfill_state" (
  "backfill_key" text COLLATE "C" PRIMARY KEY,
  "completed_at" text COLLATE "C" NOT NULL
);

CREATE TABLE IF NOT EXISTS "seller_settlement_windows" (
  "window_key" text COLLATE "C" PRIMARY KEY,
  "plan_subscription_id" text COLLATE "C",
  "authority_purchase_id" text COLLATE "C",
  "seller_scope_ref" text COLLATE "C" NOT NULL,
  "window_start" text COLLATE "C" NOT NULL,
  "window_end" text COLLATE "C" NOT NULL,
  "release_at" text COLLATE "C" NOT NULL,
  "next_attempt_at" text COLLATE "C" NOT NULL,
  "status" text COLLATE "C" NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'released', 'non_positive')),
  "updated_at" text COLLATE "C" NOT NULL,
  CONSTRAINT "seller_settlement_windows_typed_source_check" CHECK (("plan_subscription_id" IS NOT NULL) <> ("authority_purchase_id" IS NOT NULL)),
  CONSTRAINT "seller_settlement_windows_plan_fk" FOREIGN KEY ("plan_subscription_id") REFERENCES "plan_subscriptions" ("id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "seller_settlement_windows_authority_fk" FOREIGN KEY ("authority_purchase_id") REFERENCES "authority_purchases" ("id") DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "seller_settlement_windows_due_idx" ON "seller_settlement_windows" ("status", "next_attempt_at", "release_at", "window_key");
CREATE INDEX IF NOT EXISTS "seller_settlement_windows_source_idx" ON "seller_settlement_windows" ("plan_subscription_id", "authority_purchase_id", "seller_scope_ref", "window_start");

DO $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE card_chain AS (
      SELECT subscription."id" AS subscription_id, card."id" AS card_id, card."replaces_card_id"
      FROM "plan_subscriptions" subscription
      INNER JOIN "cards" card ON card."id" = subscription."origin_card_id" AND card."issuance_type" = 'purchase'
      UNION ALL
      SELECT chain.subscription_id, parent."id", parent."replaces_card_id"
      FROM card_chain chain INNER JOIN "cards" parent ON parent."id" = chain."replaces_card_id"
    )
    SELECT 1 FROM card_chain root
    WHERE root."replaces_card_id" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "plan_purchase_orders" purchase
        WHERE purchase."card_id" = root.card_id AND purchase."status" IN ('fulfilled', 'reversed')
      )
      AND NOT EXISTS (
        SELECT 1 FROM "credit_ledger_events" ledger
        WHERE ledger."card_id" = root.card_id AND ledger."event_type" = 'card_purchase' AND ledger."amount_units" < 0
      )
  ) THEN
    RAISE EXCEPTION 'historical paid Plan Card is missing its root purchase fact' USING ERRCODE = '55000';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "seller_settlement_events"
    GROUP BY "plan_subscription_id", "authority_purchase_id", "seller_scope_ref", "window_start"
    HAVING COUNT(*) FILTER (WHERE "event_type" = 'release') > 0
      AND SUM(CASE WHEN "event_type" = 'release' THEN "amount_units" ELSE 0 END)
      <> GREATEST(0, SUM(CASE "event_type" WHEN 'revenue' THEN "amount_units" WHEN 'upstream_cost' THEN -"amount_units" WHEN 'reversal' THEN -"amount_units" ELSE 0 END))
  ) THEN
    RAISE EXCEPTION 'historical seller settlement window requires reconciliation before writer cutover' USING ERRCODE = '55000';
  END IF;
END $$;

INSERT INTO "seller_settlement_windows" (
  "window_key", "plan_subscription_id", "authority_purchase_id", "seller_scope_ref",
  "window_start", "window_end", "release_at", "next_attempt_at", "status", "updated_at"
)
SELECT
  (CASE WHEN "plan_subscription_id" IS NOT NULL THEN 'plan:' || "plan_subscription_id" ELSE 'authority:' || "authority_purchase_id" END)
    || ':' || "seller_scope_ref" || ':' || "window_start",
  "plan_subscription_id", "authority_purchase_id", "seller_scope_ref", "window_start",
  MIN("window_end"), MIN("release_at"), MIN("release_at"),
  CASE WHEN COUNT(*) FILTER (WHERE "event_type" = 'release') > 0 THEN 'released' ELSE 'open' END,
  MAX("created_at")
FROM "seller_settlement_events"
GROUP BY "plan_subscription_id", "authority_purchase_id", "seller_scope_ref", "window_start"
ON CONFLICT ("window_key") DO NOTHING;

CREATE OR REPLACE FUNCTION "friday_relay_project_seller_settlement_window"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  projected_key text;
  expected_key text;
BEGIN
  expected_key := (CASE WHEN NEW."plan_subscription_id" IS NOT NULL THEN 'plan:' || NEW."plan_subscription_id" ELSE 'authority:' || NEW."authority_purchase_id" END)
    || ':' || NEW."seller_scope_ref" || ':' || NEW."window_start";
  IF NEW."event_type" = 'release' THEN
    UPDATE "seller_settlement_windows"
    SET "status" = 'released', "updated_at" = NEW."created_at"
    WHERE "window_key" = expected_key AND "status" = 'open'
    RETURNING "window_key" INTO projected_key;
    IF projected_key IS NULL AND NOT EXISTS (
      SELECT 1 FROM "seller_settlement_events" prior
      WHERE prior."event_type" = NEW."event_type" AND prior."source_type" = NEW."source_type"
        AND prior."source_id" = NEW."source_id" AND prior."window_start" = NEW."window_start"
    ) THEN
      RAISE EXCEPTION 'seller settlement window is not open' USING ERRCODE = '55000';
    END IF;
  ELSE
    INSERT INTO "seller_settlement_windows" (
      "window_key", "plan_subscription_id", "authority_purchase_id", "seller_scope_ref",
      "window_start", "window_end", "release_at", "next_attempt_at", "status", "updated_at"
    ) VALUES (
      expected_key, NEW."plan_subscription_id", NEW."authority_purchase_id", NEW."seller_scope_ref",
      NEW."window_start", NEW."window_end", NEW."release_at", NEW."release_at", 'open', NEW."created_at"
    )
    ON CONFLICT ("window_key") DO UPDATE SET "updated_at" = EXCLUDED."updated_at"
    WHERE "seller_settlement_windows"."status" = 'open'
      AND "seller_settlement_windows"."plan_subscription_id" IS NOT DISTINCT FROM EXCLUDED."plan_subscription_id"
      AND "seller_settlement_windows"."authority_purchase_id" IS NOT DISTINCT FROM EXCLUDED."authority_purchase_id"
      AND "seller_settlement_windows"."seller_scope_ref" = EXCLUDED."seller_scope_ref"
      AND "seller_settlement_windows"."window_start" = EXCLUDED."window_start"
      AND "seller_settlement_windows"."window_end" = EXCLUDED."window_end"
      AND "seller_settlement_windows"."release_at" = EXCLUDED."release_at"
    RETURNING "window_key" INTO projected_key;
    IF projected_key IS NULL AND NOT EXISTS (
      SELECT 1 FROM "seller_settlement_events" prior
      WHERE prior."event_type" = NEW."event_type" AND prior."source_type" = NEW."source_type"
        AND prior."source_id" = NEW."source_id" AND prior."window_start" = NEW."window_start"
    ) THEN
      RAISE EXCEPTION 'seller settlement window is closed' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "seller_settlement_events_window_projection" ON "seller_settlement_events";
CREATE TRIGGER "seller_settlement_events_window_projection"
  BEFORE INSERT ON "seller_settlement_events"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_project_seller_settlement_window"();
