import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { exportInstanceDataArtifact, restoreInstanceDataArtifact } from "./instance-data-artifact.js";
import { listRequiredInstanceDataTables } from "@frely/postgres/instance-data-profile";

const docker = process.env.FRIDAY_RELAY_DOCKER_CLI ?? "docker";
const image = process.env.FRIDAY_RELAY_INSTANCE_DATA_POSTGRES_IMAGE
  ?? "postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a";
const root = realpathSync(mkdtempSync(join(tmpdir(), "friday-relay-instance-data-verify-")));
const container = `friday-relay-instance-data-verify-${process.pid}`;
const password = "fixture-superuser-password";
const readerPassword = "fixture-reader-password";
let phase = "container_start";

try {
  exec(["run", "--detach", "--rm", "--name", container, "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=friday_source", "-p", "127.0.0.1::5432", image]);
  waitForPostgres();
  phase = "source_prepare";
  const port = mappedPort();
  const adminSourceUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/friday_source`;
  const adminDatabaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
  const readerUrl = `postgresql://instance_data_reader:${readerPassword}@127.0.0.1:${port}/friday_source`;
  await prepareSource(adminSourceUrl, adminDatabaseUrl);
  phase = "artifact_export";
  installPostgresToolWrappers();
  process.env.PATH = `${join(root, "bin")}:${process.env.PATH ?? ""}`;
  process.env.FRIDAY_RELAY_INSTANCE_DATA_VERIFY_CONTAINER = container;

  const artifactPath = join(root, "artifact.frid");
  const inspected = await exportInstanceDataArtifact({
    connectionString: readerUrl,
    sourceInstance: "review",
    outputPath: artifactPath,
    now: new Date(),
  });
  if (inspected.manifest.tables.length !== listRequiredInstanceDataTables().length
    || inspected.manifest.closure.status !== "valid"
    || inspected.manifest.tables.find((table) => table.name === "api_keys")?.rowCount !== 1) {
    throw new Error("instance_data_export_evidence_invalid");
  }

  const targetUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/friday_target`;
  phase = "artifact_restore";
  const restored = await restoreInstanceDataArtifact({ connectionString: targetUrl, artifactPath });
  if (restored.status !== "restored_and_verified" || restored.artifactSha256 !== inspected.artifactSha256) {
    throw new Error("instance_data_restore_evidence_invalid");
  }
  phase = "restored_content_verify";
  const target = new Client({ connectionString: targetUrl });
  await target.connect();
  try {
    const apiKey = await target.query<{ key_value: string; key_hash: string }>("SELECT key_value, key_hash FROM api_keys WHERE id = 'key_fixture'");
    const controls = await target.query<{ password_hash: string | null }>("SELECT password_hash FROM user_controls WHERE id = 'user_fixture'");
    const excluded = await target.query<{ account_count: string; session_count: string; verification_count: string }>(`
      SELECT (SELECT count(*)::text FROM account) AS account_count,
             (SELECT count(*)::text FROM session) AS session_count,
             (SELECT count(*)::text FROM verification) AS verification_count
    `);
    const sequence = await target.query<{ last_value: string; is_called: boolean }>("SELECT last_value::text, is_called FROM fixture_sequence");
    if (apiKey.rows[0]?.key_value !== "friday-relay-clone-redacted" || apiKey.rows[0]?.key_hash !== "fixture-key-hash"
      || controls.rows[0]?.password_hash !== null || excluded.rows[0]?.account_count !== "0"
      || excluded.rows[0]?.session_count !== "0" || excluded.rows[0]?.verification_count !== "0") {
      throw new Error("instance_data_secret_redaction_invalid");
    }
    if (sequence.rows[0]?.last_value !== "2" || sequence.rows[0]?.is_called !== true) {
      throw new Error("instance_data_sequence_state_invalid");
    }
  } finally {
    await target.end();
  }

  phase = "completed";
  process.stdout.write(`${JSON.stringify({
    schema: "friday-relay.instance-data-artifact-verification.v1",
    status: "passed",
    profileVersion: inspected.manifest.profile.version,
    requiredTableCount: inspected.manifest.tables.length,
    artifactDigestVerified: true,
    restoreVerified: true,
    secretRedactionVerified: true,
    excludedRowsVerified: true,
    sequenceStateVerified: true,
  })}\n`);
} catch (error) {
  process.stderr.write(`instance_data_verification_phase=${phase}\n`);
  try { process.stderr.write(exec(["logs", "--tail", "80", container])); } catch {}
  throw error;
} finally {
  try { exec(["rm", "--force", container]); } catch {}
  rmSync(root, { recursive: true, force: true });
}

async function prepareSource(sourceUrl: string, adminDatabaseUrl: string): Promise<void> {
  const source = new Client({ connectionString: sourceUrl });
  await source.connect();
  try {
    for (const table of listRequiredInstanceDataTables()) {
      if (table === "api_keys") {
        await source.query("CREATE TABLE api_keys (id text PRIMARY KEY, user_id text NOT NULL, key_hash text NOT NULL, key_value text NOT NULL)");
      } else if (table === "user_controls") {
        await source.query("CREATE TABLE user_controls (id text PRIMARY KEY, password_hash text NULL)");
      } else {
        await source.query(`CREATE TABLE ${quoteIdentifier(table)} (id text PRIMARY KEY)`);
      }
    }
    await source.query("ALTER TABLE api_keys ADD CONSTRAINT api_keys_user_fixture_fk FOREIGN KEY (user_id) REFERENCES user_controls(id) NOT VALID");
    await source.query(`
      CREATE TABLE account (id text PRIMARY KEY, password text NULL, access_token text NULL);
      CREATE TABLE session (id text PRIMARY KEY, token text NOT NULL);
      CREATE TABLE verification (id text PRIMARY KEY, value text NOT NULL);
      CREATE TABLE _prisma_migrations (
        id varchar(36) PRIMARY KEY,
        checksum varchar(64) NOT NULL,
        finished_at timestamptz NULL,
        migration_name varchar(255) NOT NULL,
        logs text NULL,
        rolled_back_at timestamptz NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        applied_steps_count integer NOT NULL DEFAULT 0
      );
      CREATE SEQUENCE fixture_sequence;
    `);
    await source.query("BEGIN");
    await source.query("SET CONSTRAINTS ALL DEFERRED");
    await source.query("INSERT INTO user_controls (id, password_hash) VALUES ('user_fixture', 'raw-password-hash')");
    await source.query("INSERT INTO api_keys (id, user_id, key_hash, key_value) VALUES ('key_fixture', 'user_fixture', 'fixture-key-hash', 'fr_raw_fixture_key')");
    await source.query("COMMIT");
    await source.query("INSERT INTO account (id, password, access_token) VALUES ('account_fixture', 'raw-password', 'raw-oauth-token')");
    await source.query("INSERT INTO session (id, token) VALUES ('session_fixture', 'raw-session-token')");
    await source.query("INSERT INTO verification (id, value) VALUES ('verification_fixture', 'raw-verification-token')");
    await source.query("SELECT nextval('fixture_sequence')");
    await source.query("SELECT nextval('fixture_sequence')");
    await source.query(`INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
      VALUES ('migration-fixture', repeat('a', 64), now(), '20260901000000_fixture', 1)`);
    await source.query(`
      CREATE ROLE instance_data_reader LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      ALTER ROLE instance_data_reader SET default_transaction_read_only = on;
      REVOKE CREATE, TEMPORARY ON DATABASE friday_source FROM PUBLIC;
      REVOKE CREATE, TEMPORARY ON DATABASE friday_source FROM instance_data_reader;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT CONNECT ON DATABASE friday_source TO instance_data_reader;
      GRANT USAGE ON SCHEMA public TO instance_data_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO instance_data_reader;
      GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO instance_data_reader;
    `);
  } finally {
    await source.end();
  }
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try { await admin.query("CREATE DATABASE friday_target"); }
  finally { await admin.end(); }
}

function installPostgresToolWrappers(): void {
  const bin = join(root, "bin");
  execFileSync("mkdir", ["-p", bin]);
  const common = `#!/bin/sh\nset -eu\ncontainer="$FRIDAY_RELAY_INSTANCE_DATA_VERIFY_CONTAINER"\n`;
  writeFileSync(join(bin, "pg_dump"), `${common}
out=""
args=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--file" ]; then out="$2"; shift 2; continue; fi
  args="$args $(printf %s "$1" | sed "s/'/'\\\\''/g")"
  shift
done
eval "docker exec -i -e PGPASSWORD=\\\"$PGPASSWORD\\\" -e PGUSER=\\\"$PGUSER\\\" -e PGDATABASE=\\\"$PGDATABASE\\\" -e PGHOST=127.0.0.1 -e PGPORT=5432 $container pg_dump $args" > "$out"
`, { mode: 0o700 });
  writeFileSync(join(bin, "psql"), `${common}
input=""
args=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--file" ]; then input="$2"; shift 2; continue; fi
  args="$args $(printf %s "$1" | sed "s/'/'\\\\''/g")"
  shift
done
eval "docker exec -i -e PGPASSWORD=\\\"$PGPASSWORD\\\" -e PGUSER=\\\"$PGUSER\\\" -e PGDATABASE=\\\"$PGDATABASE\\\" -e PGHOST=127.0.0.1 -e PGPORT=5432 $container psql $args" < "$input"
`, { mode: 0o700 });
  chmodSync(join(bin, "pg_dump"), 0o700);
  chmodSync(join(bin, "psql"), 0o700);
}

function waitForPostgres(): void {
  let consecutiveReady = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if (exec(["exec", container, "psql", "-U", "postgres", "-d", "friday_source", "-Atqc", "SELECT 1"]).trim() === "1") {
        consecutiveReady += 1;
        if (consecutiveReady >= 2) return;
      } else consecutiveReady = 0;
    } catch { consecutiveReady = 0; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("instance_data_postgres_not_ready");
}

function mappedPort(): string {
  const output = exec(["port", container, "5432/tcp"]).trim();
  const match = /:(\d+)$/u.exec(output);
  if (!match) throw new Error("instance_data_postgres_port_invalid");
  return match[1]!;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error("invalid_table_name");
  return `"${value}"`;
}

function exec(args: string[]): string {
  return execFileSync(docker, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
