-- Entrance AccessPoint request overrides are part of the routing revision and
-- are applied once before request admission and Provider invocation.
ALTER TABLE "access_points"
  ADD COLUMN "request_overrides_json" text COLLATE "C" NOT NULL DEFAULT '{}';

ALTER TABLE "access_points"
  ADD CONSTRAINT "access_points_request_overrides_check" CHECK (
    friday_relay_json_type("request_overrides_json") = 'object'
    AND octet_length("request_overrides_json") <= 8192
  );
