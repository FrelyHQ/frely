ALTER TABLE "request_logs"
  ADD COLUMN "ingress_route_id" text COLLATE "C";

ALTER TABLE "request_log_archive_entries"
  ADD COLUMN "ingress_route_id" text COLLATE "C";

ALTER TABLE "request_logs"
  ADD CONSTRAINT "request_logs_ingress_route_id_check"
  CHECK (
    "ingress_route_id" IS NULL
    OR (
      char_length("ingress_route_id") BETWEEN 1 AND 128
      AND "ingress_route_id" ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
    )
  );

ALTER TABLE "request_log_archive_entries"
  ADD CONSTRAINT "request_log_archive_entries_ingress_route_id_check"
  CHECK (
    "ingress_route_id" IS NULL
    OR (
      char_length("ingress_route_id") BETWEEN 1 AND 128
      AND "ingress_route_id" ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
    )
  );

CREATE OR REPLACE FUNCTION "friday_relay_validate_request_log_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.api_key_id IS DISTINCT FROM NEW.api_key_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.request_path IS DISTINCT FROM NEW.request_path
    OR OLD.ingress_hostname IS DISTINCT FROM NEW.ingress_hostname
    OR OLD.ingress_route_id IS DISTINCT FROM NEW.ingress_route_id
    OR OLD.req_model IS DISTINCT FROM NEW.req_model
    OR OLD.ingress_plugins_json IS DISTINCT FROM NEW.ingress_plugins_json
    OR OLD.started_at IS DISTINCT FROM NEW.started_at
    OR NOT (
      OLD.pipeline_plugins_json IS NOT DISTINCT FROM NEW.pipeline_plugins_json
      OR (
        OLD.pipeline_plugins_json = '{"schemaVersion":1,"planRevision":"pending","invocations":[]}'
        AND NEW.pipeline_plugins_json IS DISTINCT FROM OLD.pipeline_plugins_json
      )
    )
    OR NOT (OLD.team_id IS NOT DISTINCT FROM NEW.team_id OR (OLD.team_id IS NULL AND NEW.team_id IS NOT NULL))
    OR NOT (OLD.plan_id IS NOT DISTINCT FROM NEW.plan_id OR (OLD.plan_id IS NULL AND NEW.plan_id IS NOT NULL))
    OR NOT (OLD.plan_subscription_id IS NOT DISTINCT FROM NEW.plan_subscription_id OR (OLD.plan_subscription_id IS NULL AND NEW.plan_subscription_id IS NOT NULL))
    OR NOT (OLD.entry_access_point_id IS NOT DISTINCT FROM NEW.entry_access_point_id OR (OLD.entry_access_point_id IS NULL AND NEW.entry_access_point_id IS NOT NULL))
    OR NOT (OLD.billing_scope_ref IS NOT DISTINCT FROM NEW.billing_scope_ref OR (OLD.billing_scope_ref IS NULL AND NEW.billing_scope_ref IS NOT NULL))
    OR NOT (OLD.provider_id IS NOT DISTINCT FROM NEW.provider_id OR (OLD.provider_id IS NULL AND NEW.provider_id IS NOT NULL))
    OR NOT (OLD.tar_model IS NOT DISTINCT FROM NEW.tar_model OR (OLD.tar_model IS NULL AND NEW.tar_model IS NOT NULL))
  THEN
    RAISE EXCEPTION 'request_logs immutable fields cannot be updated' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
