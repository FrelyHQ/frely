-- Minimal accountless Pi Tunnel admission state. Runtime presence and Client
-- authorization remain in the single pi-tunnel process and are not persisted.
CREATE TABLE "pi_tunnel_devices" (
  "id" text COLLATE "C" PRIMARY KEY NOT NULL,
  "lifecycle" text COLLATE "C" NOT NULL,
  "activation_code_hash" text COLLATE "C" NOT NULL,
  "activation_expires_at" text COLLATE "C" NOT NULL,
  "activation_attempts_remaining" integer NOT NULL,
  "node_id" text COLLATE "C",
  "node_public_key_spki" text COLLATE "C",
  "node_key_thumbprint" text COLLATE "C",
  "activated_at" text COLLATE "C",
  "revoked_at" text COLLATE "C",
  "revocation_reason" text COLLATE "C",
  "created_at" text COLLATE "C" NOT NULL,
  CONSTRAINT "pi_tunnel_devices_id_check" CHECK ("id" ~ '^pi_device_[a-f0-9]{32}$'),
  CONSTRAINT "pi_tunnel_devices_lifecycle_check" CHECK ("lifecycle" IN ('pending', 'active', 'revoked')),
  CONSTRAINT "pi_tunnel_devices_activation_hash_check" CHECK ("activation_code_hash" ~ '^sha256:[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "pi_tunnel_devices_activation_attempts_check" CHECK ("activation_attempts_remaining" BETWEEN 0 AND 10),
  CONSTRAINT "pi_tunnel_devices_node_id_check" CHECK ("node_id" IS NULL OR "node_id" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "pi_tunnel_devices_node_spki_check" CHECK ("node_public_key_spki" IS NULL OR "node_public_key_spki" ~ '^[A-Za-z0-9_-]{59}$'),
  CONSTRAINT "pi_tunnel_devices_node_thumbprint_check" CHECK ("node_key_thumbprint" IS NULL OR "node_key_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "pi_tunnel_devices_node_identity_check" CHECK ("node_id" IS NULL OR "node_id" = "node_key_thumbprint"),
  CONSTRAINT "pi_tunnel_devices_revocation_reason_check" CHECK (
    "revocation_reason" IS NULL OR "revocation_reason" IN ('operator_revoked', 'security_response', 'key_compromise', 'device_replaced')
  ),
  CONSTRAINT "pi_tunnel_devices_shape_check" CHECK (
    (
      "lifecycle" = 'pending'
      AND "node_id" IS NULL AND "node_public_key_spki" IS NULL AND "node_key_thumbprint" IS NULL
      AND "activated_at" IS NULL AND "revoked_at" IS NULL AND "revocation_reason" IS NULL
    ) OR (
      "lifecycle" = 'active'
      AND "node_id" IS NOT NULL AND "node_public_key_spki" IS NOT NULL AND "node_key_thumbprint" IS NOT NULL
      AND "activated_at" IS NOT NULL AND "revoked_at" IS NULL AND "revocation_reason" IS NULL
    ) OR (
      "lifecycle" = 'revoked'
      AND "revoked_at" IS NOT NULL AND "revocation_reason" IS NOT NULL
      AND (
        ("node_id" IS NULL AND "node_public_key_spki" IS NULL AND "node_key_thumbprint" IS NULL AND "activated_at" IS NULL)
        OR
        ("node_id" IS NOT NULL AND "node_public_key_spki" IS NOT NULL AND "node_key_thumbprint" IS NOT NULL AND "activated_at" IS NOT NULL)
      )
    )
  )
);

CREATE UNIQUE INDEX "pi_tunnel_devices_node_id_unique" ON "pi_tunnel_devices" ("node_id") WHERE "node_id" IS NOT NULL;
CREATE UNIQUE INDEX "pi_tunnel_devices_node_thumbprint_unique" ON "pi_tunnel_devices" ("node_key_thumbprint") WHERE "node_key_thumbprint" IS NOT NULL;
CREATE INDEX "pi_tunnel_devices_activation_idx" ON "pi_tunnel_devices" ("lifecycle", "activation_expires_at", "id");
CREATE INDEX "pi_tunnel_devices_lifecycle_idx" ON "pi_tunnel_devices" ("lifecycle", "revoked_at", "id");

CREATE OR REPLACE FUNCTION "friday_relay_guard_pi_tunnel_device_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."activation_code_hash" IS DISTINCT FROM OLD."activation_code_hash"
    OR NEW."activation_expires_at" IS DISTINCT FROM OLD."activation_expires_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'pi_tunnel_device identity and activation facts are immutable';
  END IF;

  IF OLD."lifecycle" = 'revoked' THEN
    RAISE EXCEPTION 'revoked pi_tunnel_device is terminal';
  END IF;
  IF OLD."lifecycle" = 'active' AND NEW."lifecycle" <> 'revoked' THEN
    RAISE EXCEPTION 'active pi_tunnel_device can only become revoked';
  END IF;
  IF OLD."lifecycle" = 'pending' AND NEW."lifecycle" NOT IN ('pending', 'active', 'revoked') THEN
    RAISE EXCEPTION 'invalid pending pi_tunnel_device transition';
  END IF;

  IF NEW."activation_attempts_remaining" > OLD."activation_attempts_remaining"
    OR (OLD."lifecycle" <> 'pending' AND NEW."activation_attempts_remaining" IS DISTINCT FROM OLD."activation_attempts_remaining") THEN
    RAISE EXCEPTION 'pi_tunnel_device activation attempts are monotonic while pending';
  END IF;

  IF NOT (OLD."lifecycle" = 'pending' AND NEW."lifecycle" = 'active') THEN
    IF NEW."node_id" IS DISTINCT FROM OLD."node_id"
      OR NEW."node_public_key_spki" IS DISTINCT FROM OLD."node_public_key_spki"
      OR NEW."node_key_thumbprint" IS DISTINCT FROM OLD."node_key_thumbprint"
      OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at" THEN
      RAISE EXCEPTION 'pi_tunnel_device node identity is immutable outside activation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "pi_tunnel_devices_transition_guard"
  BEFORE UPDATE ON "pi_tunnel_devices"
  FOR EACH ROW EXECUTE FUNCTION "friday_relay_guard_pi_tunnel_device_transition"();
