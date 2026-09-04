import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { Client } from "pg";
import { from as copyFrom, to as copyTo } from "pg-copy-streams";
import { INSTANCE_DATA_PROFILE, listRequiredInstanceDataTables, type InstanceDataColumnTransform } from "@frely/postgres/instance-data-profile";

const ARTIFACT_SCHEMA = "friday-relay.instance-data-artifact.v1";
const ARTIFACT_MAGIC = Buffer.from("FRIDAY-RELAY-INSTANCE-DATA-V1\n", "utf8");
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const ALLOWED_SOURCE_INSTANCES = new Set(["review"]);

export type InstanceDataArtifactPayload = Readonly<{
  name: string;
  kind: "schema" | "migration-ledger" | "table" | "sequences";
  table: string | null;
  size: number;
  sha256: string;
}>;

export type InstanceDataArtifactManifest = Readonly<{
  schema: typeof ARTIFACT_SCHEMA;
  profile: Readonly<{ id: string; version: number; schema: string; requiredTables: readonly string[] }>;
  source: Readonly<{ instance: string; databaseFingerprint: string; serverVersionNum: number }>;
  snapshot: Readonly<{ boundaryDigest: string; startedAt: string; completedAt: string }>;
  sourceSchema: Readonly<{ sha256: string }>;
  migrationLedger: Readonly<{
    rowCount: number;
    sha256: string;
    appliedHead: string | null;
    failedMigrationNames: readonly string[];
    rolledBackRowCount: number;
  }>;
  tables: readonly Readonly<{
    name: string;
    columns: readonly string[];
    primaryKey: readonly string[];
    rowCount: number;
    contentSha256: string;
    transformedColumns: readonly Readonly<{ name: string; kind: "constant" | "null" }> [];
  }>[];
  closure: Readonly<{ status: "valid"; checkedForeignKeys: number; externalReferenceCount: 0; checkedBusinessReferences: number }>;
  payloads: readonly InstanceDataArtifactPayload[];
  createdAt: string;
  expiresAt: string;
}>;

export type InspectedInstanceDataArtifact = Readonly<{
  manifest: InstanceDataArtifactManifest;
  artifactPath: string;
  artifactSha256: string;
  artifactSize: number;
  payloadOffsets: Readonly<Record<string, Readonly<{ start: number; end: number }>>>;
}>;

type TableMetadata = Readonly<{
  name: string;
  columns: readonly Readonly<{ name: string; sqlType: string }>[];
  primaryKey: readonly string[];
}>;

type ExportOptions = Readonly<{
  connectionString: string;
  sourceInstance: string;
  outputPath: string;
  now?: Date;
  ttlMs?: number;
}>;

type RestoreOptions = Readonly<{
  connectionString: string;
  artifactPath: string;
}>;

export async function exportInstanceDataArtifact(options: ExportOptions): Promise<InspectedInstanceDataArtifact> {
  if (!ALLOWED_SOURCE_INSTANCES.has(options.sourceInstance)) {
    throw artifactError("instance_data_source_not_allowlisted", "Instance-data export source is not allowlisted");
  }
  requireConnectionString(options.connectionString);
  const outputPath = requireAbsoluteOutputPath(options.outputPath);
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1000) {
    throw artifactError("instance_data_artifact_ttl_invalid", "Instance-data artifact TTL is outside the bounded policy");
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "friday-relay-instance-data-export-"));
  const client = new Client({ connectionString: options.connectionString, application_name: "friday-relay-instance-data-export" });
  let transactionOpen = false;
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE");
    transactionOpen = true;
    await assertReadOnlyReader(client);
    const startedAt = now.toISOString();
    const snapshotResult = await client.query<{ snapshot_id: string; boundary: string; database_name: string; server_version_num: string }>(`
      SELECT pg_export_snapshot() AS snapshot_id,
             pg_current_snapshot()::text AS boundary,
             current_database() AS database_name,
             current_setting('server_version_num') AS server_version_num
    `);
    const snapshot = snapshotResult.rows[0];
    if (!snapshot?.snapshot_id || !snapshot.boundary || !snapshot.database_name || !/^\d+$/u.test(snapshot.server_version_num)) {
      throw artifactError("instance_data_snapshot_invalid", "PostgreSQL did not return a valid consistent snapshot boundary");
    }

    const requiredTables = [...listRequiredInstanceDataTables()].sort();
    const tableMetadata = await loadTableMetadata(client, requiredTables);
    const closure = await inspectReferenceClosure(client, requiredTables);
    const schemaPath = join(tempRoot, "schema.sql");
    await dumpCanonicalSchema(options.connectionString, snapshot.snapshot_id, schemaPath);
    const schemaSha256 = sha256File(schemaPath);

    const payloadFiles: Array<{ payload: InstanceDataArtifactPayload; path: string }> = [];
    payloadFiles.push({
      payload: payloadForFile("schema.sql", "schema", null, schemaPath),
      path: schemaPath,
    });

    const migrationMetadata = await loadMigrationMetadata(client);
    const migrationPath = join(tempRoot, "_prisma_migrations.copy");
    const migrationColumns = await loadColumns(client, "_prisma_migrations");
    await copyQueryToFile(client, buildCopySelect("_prisma_migrations", migrationColumns, ["started_at", "id"], {}), migrationPath);
    const migrationPayload = payloadForFile("migration-ledger.copy", "migration-ledger", "_prisma_migrations", migrationPath);
    payloadFiles.push({ payload: migrationPayload, path: migrationPath });

    const tables: InstanceDataArtifactManifest["tables"][number][] = [];
    for (const metadata of tableMetadata) {
      const tablePath = join(tempRoot, `${metadata.name}.copy`);
      const transforms = INSTANCE_DATA_PROFILE.columnTransforms[metadata.name] ?? {};
      await copyQueryToFile(client, buildCopySelect(metadata.name, metadata.columns, metadata.primaryKey, transforms), tablePath);
      const countResult = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${quoteIdentifier(metadata.name)}`);
      const rowCount = parseSafeCount(countResult.rows[0]?.count, `table ${metadata.name}`);
      const tablePayload = payloadForFile(`tables/${metadata.name}.copy`, "table", metadata.name, tablePath);
      payloadFiles.push({ payload: tablePayload, path: tablePath });
      tables.push(Object.freeze({
        name: metadata.name,
        columns: Object.freeze(metadata.columns.map((column) => column.name)),
        primaryKey: Object.freeze([...metadata.primaryKey]),
        rowCount,
        contentSha256: tablePayload.sha256,
        transformedColumns: Object.freeze(Object.entries(transforms).sort(([left], [right]) => left.localeCompare(right)).map(([name, transform]) => Object.freeze({ name, kind: transform.kind }))),
      }));
    }

    const sequencesPath = join(tempRoot, "sequences.json");
    const sequences = await loadSequenceState(client);
    writeFileSync(sequencesPath, `${JSON.stringify(sequences)}\n`, { encoding: "utf8", mode: 0o600 });
    payloadFiles.push({ payload: payloadForFile("sequences.json", "sequences", null, sequencesPath), path: sequencesPath });

    const completedAt = new Date(Math.max(Date.now(), now.valueOf())).toISOString();
    const manifest: InstanceDataArtifactManifest = deepFreeze({
      schema: ARTIFACT_SCHEMA,
      profile: {
        id: INSTANCE_DATA_PROFILE.profileId,
        version: INSTANCE_DATA_PROFILE.version,
        schema: INSTANCE_DATA_PROFILE.schema,
        requiredTables,
      },
      source: {
        instance: options.sourceInstance,
        databaseFingerprint: sha256Text(`${options.sourceInstance}\0${snapshot.database_name}`),
        serverVersionNum: Number(snapshot.server_version_num),
      },
      snapshot: {
        boundaryDigest: sha256Text(snapshot.boundary),
        startedAt,
        completedAt,
      },
      sourceSchema: { sha256: schemaSha256 },
      migrationLedger: {
        rowCount: migrationMetadata.rowCount,
        sha256: migrationPayload.sha256,
        appliedHead: migrationMetadata.appliedHead,
        failedMigrationNames: migrationMetadata.failedMigrationNames,
        rolledBackRowCount: migrationMetadata.rolledBackRowCount,
      },
      tables,
      closure,
      payloads: payloadFiles.map((entry) => entry.payload),
      createdAt: startedAt,
      expiresAt: new Date(now.valueOf() + ttlMs).toISOString(),
    });
    validateArtifactManifest(manifest);
    await writeArtifact(outputPath, manifest, payloadFiles);
    await client.query("COMMIT");
    transactionOpen = false;
    return inspectInstanceDataArtifact(outputPath, { verifyPayloads: true, requireUnexpired: true, now });
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function inspectInstanceDataArtifact(
  artifactPathValue: string,
  options: Readonly<{ verifyPayloads?: boolean; requireUnexpired?: boolean; now?: Date }> = {},
): InspectedInstanceDataArtifact {
  const artifactPath = requirePrivateArtifactPath(artifactPathValue);
  const stat = statSync(artifactPath);
  if (!Number.isSafeInteger(stat.size) || stat.size <= ARTIFACT_MAGIC.length + 4 || stat.size > MAX_ARTIFACT_BYTES) {
    throw artifactError("instance_data_artifact_size_invalid", "Instance-data artifact size is outside the bounded policy");
  }
  const descriptor = openSync(artifactPath, "r");
  try {
    const prefix = Buffer.alloc(ARTIFACT_MAGIC.length + 4);
    if (readSync(descriptor, prefix, 0, prefix.length, 0) !== prefix.length || !prefix.subarray(0, ARTIFACT_MAGIC.length).equals(ARTIFACT_MAGIC)) {
      throw artifactError("instance_data_artifact_magic_invalid", "Instance-data artifact magic is invalid");
    }
    const headerLength = prefix.readUInt32BE(ARTIFACT_MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
      throw artifactError("instance_data_artifact_header_size_invalid", "Instance-data artifact header size is invalid");
    }
    const header = Buffer.alloc(headerLength);
    if (readSync(descriptor, header, 0, headerLength, prefix.length) !== headerLength) {
      throw artifactError("instance_data_artifact_truncated", "Instance-data artifact header is truncated");
    }
    let manifestValue: unknown;
    try { manifestValue = JSON.parse(header.toString("utf8")); }
    catch { throw artifactError("instance_data_artifact_manifest_invalid", "Instance-data artifact manifest is invalid JSON"); }
    const manifest = validateArtifactManifest(manifestValue);
    const payloadOffsets: Record<string, Readonly<{ start: number; end: number }>> = {};
    let offset = prefix.length + headerLength;
    for (const payload of manifest.payloads) {
      const endExclusive = offset + payload.size;
      if (!Number.isSafeInteger(endExclusive) || endExclusive > stat.size) {
        throw artifactError("instance_data_artifact_truncated", "Instance-data artifact payload is truncated");
      }
      payloadOffsets[payload.name] = Object.freeze({ start: offset, end: endExclusive - 1 });
      if (options.verifyPayloads !== false) {
        const digest = sha256FileRange(artifactPath, offset, payload.size);
        if (digest !== payload.sha256) {
          throw artifactError("instance_data_artifact_payload_digest_mismatch", "Instance-data artifact payload digest does not match its manifest");
        }
      }
      offset = endExclusive;
    }
    if (offset !== stat.size) throw artifactError("instance_data_artifact_trailing_bytes", "Instance-data artifact contains trailing bytes");
    const now = options.now ?? new Date();
    if (options.requireUnexpired !== false && Date.parse(manifest.expiresAt) <= now.valueOf()) {
      throw artifactError("instance_data_artifact_expired", "Instance-data artifact has expired");
    }
    return deepFreeze({
      manifest,
      artifactPath,
      artifactSha256: sha256File(artifactPath),
      artifactSize: stat.size,
      payloadOffsets,
    });
  } finally {
    closeSync(descriptor);
  }
}

export async function restoreInstanceDataArtifact(options: RestoreOptions): Promise<Readonly<{
  schema: "friday-relay.instance-data-restore.v1";
  status: "restored_and_verified";
  artifactSha256: string;
  sourceInstance: string;
  sourceMigrationHead: string | null;
  requiredTableCount: number;
  totalRowCount: number;
}>> {
  requireConnectionString(options.connectionString);
  const inspected = inspectInstanceDataArtifact(options.artifactPath, { verifyPayloads: true, requireUnexpired: true });
  const tempRoot = mkdtempSync(join(tmpdir(), "friday-relay-instance-data-restore-"));
  const schemaPath = join(tempRoot, "schema.sql");
  try {
    const bootstrap = new Client({ connectionString: options.connectionString, application_name: "friday-relay-instance-data-restore" });
    await bootstrap.connect();
    try {
      const existing = await bootstrap.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p','S')");
      if (parseSafeCount(existing.rows[0]?.count, "target schema") !== 0) {
        throw artifactError("instance_data_restore_target_not_empty", "Instance-data restore target must be an empty database");
      }
    } finally {
      await bootstrap.end();
    }

    await extractPayload(inspected, "schema.sql", schemaPath);
    await runPostgresTool("psql", ["-X", "-v", "ON_ERROR_STOP=1", "--file", schemaPath], options.connectionString, { timeoutMs: 10 * 60_000 });

    const client = new Client({ connectionString: options.connectionString, application_name: "friday-relay-instance-data-restore" });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await restoreCopyPayload(client, inspected, "migration-ledger.copy", "_prisma_migrations", await loadColumns(client, "_prisma_migrations"));
      for (const table of inspected.manifest.tables) {
        await restoreCopyPayload(client, inspected, `tables/${table.name}.copy`, table.name, table.columns.map((name) => Object.freeze({ name, sqlType: "" })));
      }
      const sequencesPath = join(tempRoot, "sequences.json");
      await extractPayload(inspected, "sequences.json", sequencesPath);
      const sequences = parseSequencePayload(readFileSync(sequencesPath, "utf8"));
      for (const sequence of sequences) {
        await client.query("SELECT setval(format('%I.%I', $1::text, $2::text)::regclass, $3::bigint, $4::boolean)", [
          sequence.schemaname,
          sequence.sequencename,
          sequence.last_value,
          sequence.is_called,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }

    await verifyRestoredInstanceData({ connectionString: options.connectionString, inspected });
    return deepFreeze({
      schema: "friday-relay.instance-data-restore.v1",
      status: "restored_and_verified",
      artifactSha256: inspected.artifactSha256,
      sourceInstance: inspected.manifest.source.instance,
      sourceMigrationHead: inspected.manifest.migrationLedger.appliedHead,
      requiredTableCount: inspected.manifest.tables.length,
      totalRowCount: inspected.manifest.tables.reduce((sum, table) => sum + table.rowCount, 0),
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function verifyRestoredInstanceData(options: Readonly<{ connectionString: string; inspected: InspectedInstanceDataArtifact }>): Promise<void> {
  const client = new Client({ connectionString: options.connectionString, application_name: "friday-relay-instance-data-verify" });
  const tempRoot = mkdtempSync(join(tmpdir(), "friday-relay-instance-data-verify-"));
  try {
    await client.connect();
    const schemaPath = join(tempRoot, "schema.sql");
    await dumpCanonicalSchema(options.connectionString, null, schemaPath);
    if (sha256File(schemaPath) !== options.inspected.manifest.sourceSchema.sha256) {
      throw artifactError("instance_data_restore_schema_mismatch", "Restored schema does not match the source schema artifact");
    }
    const requiredTables = options.inspected.manifest.profile.requiredTables;
    const metadata = await loadTableMetadata(client, requiredTables);
    await inspectReferenceClosure(client, requiredTables);
    const migrationPath = join(tempRoot, "migration.copy");
    const migrationColumns = await loadColumns(client, "_prisma_migrations");
    await copyQueryToFile(client, buildCopySelect("_prisma_migrations", migrationColumns, ["started_at", "id"], {}), migrationPath);
    if (sha256File(migrationPath) !== options.inspected.manifest.migrationLedger.sha256) {
      throw artifactError("instance_data_restore_migration_ledger_mismatch", "Restored Prisma migration ledger does not match the source artifact");
    }
    for (const table of metadata) {
      const expected = options.inspected.manifest.tables.find((entry) => entry.name === table.name);
      if (!expected) throw artifactError("instance_data_restore_table_manifest_missing", "Restored table has no artifact manifest entry");
      const countResult = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${quoteIdentifier(table.name)}`);
      if (parseSafeCount(countResult.rows[0]?.count, `table ${table.name}`) !== expected.rowCount) {
        throw artifactError("instance_data_restore_row_count_mismatch", "Restored table row count does not match the source artifact");
      }
      const tablePath = join(tempRoot, `${table.name}.copy`);
      const transforms = INSTANCE_DATA_PROFILE.columnTransforms[table.name] ?? {};
      await copyQueryToFile(client, buildCopySelect(table.name, table.columns, table.primaryKey, transforms), tablePath);
      if (sha256File(tablePath) !== expected.contentSha256) {
        throw artifactError("instance_data_restore_content_mismatch", "Restored table content does not match the source artifact");
      }
    }
    const expectedSequences = parseSequencePayload(readArtifactPayloadText(options.inspected, "sequences.json"));
    const restoredSequences = await loadSequenceState(client);
    if (JSON.stringify(restoredSequences) !== JSON.stringify(expectedSequences)) {
      throw artifactError("instance_data_restore_sequence_mismatch", "Restored sequence state does not match the source artifact");
    }
  } finally {
    await client.end().catch(() => undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertReadOnlyReader(client: Client): Promise<void> {
  const role = await client.query<{
    transaction_read_only: string;
    default_transaction_read_only: string;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    database_create: boolean;
    database_temporary: boolean;
    schema_create: boolean;
  }>(`
    SELECT current_setting('transaction_read_only') AS transaction_read_only,
           current_setting('default_transaction_read_only') AS default_transaction_read_only,
           role.rolsuper, role.rolcreatedb, role.rolcreaterole, role.rolreplication, role.rolbypassrls,
           has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
           has_database_privilege(current_user, current_database(), 'TEMPORARY') AS database_temporary,
           has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
    FROM pg_roles role
    WHERE role.rolname = current_user
  `);
  const row = role.rows[0];
  if (!row || row.transaction_read_only !== "on" || row.default_transaction_read_only !== "on"
    || row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls
    || row.database_create || row.database_temporary || row.schema_create) {
    throw artifactError("instance_data_reader_privilege_invalid", "Instance-data reader is not an enforced least-privilege read-only role");
  }
  const unexpectedWrites = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND has_table_privilege(current_user, relation.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  `);
  if (parseSafeCount(unexpectedWrites.rows[0]?.count, "reader writable tables") !== 0) {
    throw artifactError("instance_data_reader_privilege_invalid", "Instance-data reader has write privileges on a public table");
  }
  const rowSecurity = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND relation.relname = ANY($1::text[])
      AND (relation.relrowsecurity OR relation.relforcerowsecurity)
  `, [[...listRequiredInstanceDataTables(), "_prisma_migrations"]]);
  if (parseSafeCount(rowSecurity.rows[0]?.count, "exported tables with row-level security") !== 0) {
    throw artifactError("instance_data_reader_privilege_invalid", "Instance-data export cannot prove complete contents while a required table uses row-level security");
  }
  const sequencePrivileges = await client.query<{ missing_select: string; writable: string }>(`
    SELECT count(*) FILTER (WHERE NOT has_sequence_privilege(current_user, relation.oid, 'SELECT'))::text AS missing_select,
           count(*) FILTER (WHERE has_sequence_privilege(current_user, relation.oid, 'USAGE,UPDATE'))::text AS writable
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind = 'S'
  `);
  if (parseSafeCount(sequencePrivileges.rows[0]?.missing_select, "reader unreadable sequences") !== 0
    || parseSafeCount(sequencePrivileges.rows[0]?.writable, "reader writable sequences") !== 0) {
    throw artifactError("instance_data_reader_privilege_invalid", "Instance-data reader must have SELECT-only access to every public sequence");
  }
  const tables = [...listRequiredInstanceDataTables(), "_prisma_migrations"];
  for (const table of tables) {
    if (!TABLE_NAME.test(table)) throw artifactError("instance_data_profile_table_invalid", "Instance-data profile contains an invalid table name");
    const privileges = await client.query<{ can_select: boolean; can_write: boolean }>(`
      SELECT has_table_privilege(current_user, $1, 'SELECT') AS can_select,
             has_table_privilege(current_user, $1, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write
    `, [`public.${table}`]);
    if (privileges.rows[0]?.can_select !== true || privileges.rows[0]?.can_write !== false) {
      throw artifactError("instance_data_reader_privilege_invalid", "Instance-data reader lacks exact read-only table privileges");
    }
  }
}

async function loadTableMetadata(client: Client, requiredTables: readonly string[]): Promise<readonly TableMetadata[]> {
  const result: TableMetadata[] = [];
  for (const table of requiredTables) {
    const columns = await loadColumns(client, table);
    const primary = await client.query<{ column_name: string }>(`
      SELECT attribute.attname AS column_name
      FROM pg_index index
      JOIN pg_class relation ON relation.oid = index.indrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN unnest(index.indkey) WITH ORDINALITY AS key(attnum, ordering) ON true
      JOIN pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
      WHERE namespace.nspname = 'public' AND relation.relname = $1 AND index.indisprimary
      ORDER BY key.ordering
    `, [table]);
    const primaryKey = primary.rows.map((row) => row.column_name);
    if (columns.length === 0 || primaryKey.length === 0) {
      throw artifactError("instance_data_table_identity_invalid", "Every core-llm table must exist and have a primary key");
    }
    result.push(Object.freeze({ name: table, columns, primaryKey: Object.freeze(primaryKey) }));
  }
  return Object.freeze(result);
}

async function loadColumns(client: Client, table: string): Promise<readonly Readonly<{ name: string; sqlType: string }>[]> {
  if (!TABLE_NAME.test(table)) throw artifactError("instance_data_table_name_invalid", "Instance-data table name is invalid");
  const columns = await client.query<{ column_name: string; sql_type: string }>(`
    SELECT attribute.attname AS column_name, format_type(attribute.atttypid, attribute.atttypmod) AS sql_type
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relname = $1
      AND relation.relkind IN ('r','p') AND attribute.attnum > 0 AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  `, [table]);
  return Object.freeze(columns.rows.map((row) => Object.freeze({ name: row.column_name, sqlType: row.sql_type })));
}

async function inspectReferenceClosure(client: Client, requiredTablesValue: readonly string[]): Promise<InstanceDataArtifactManifest["closure"]> {
  const requiredTables = new Set(requiredTablesValue);
  const constraints = await client.query<{
    constraint_name: string;
    child_table: string;
    parent_schema: string;
    parent_table: string;
    child_columns: string[];
    parent_columns: string[];
  }>(`
    SELECT constraint_relation.conname AS constraint_name,
           child.relname AS child_table,
           parent_namespace.nspname AS parent_schema,
           parent.relname AS parent_table,
           array_agg(child_attribute.attname::text ORDER BY key.ordering) AS child_columns,
           array_agg(parent_attribute.attname::text ORDER BY key.ordering) AS parent_columns
    FROM pg_constraint constraint_relation
    JOIN pg_class child ON child.oid = constraint_relation.conrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = constraint_relation.confrelid
    JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
    JOIN unnest(constraint_relation.conkey, constraint_relation.confkey) WITH ORDINALITY AS key(child_attnum, parent_attnum, ordering) ON true
    JOIN pg_attribute child_attribute ON child_attribute.attrelid = child.oid AND child_attribute.attnum = key.child_attnum
    JOIN pg_attribute parent_attribute ON parent_attribute.attrelid = parent.oid AND parent_attribute.attnum = key.parent_attnum
    WHERE constraint_relation.contype = 'f' AND child_namespace.nspname = 'public' AND child.relname = ANY($1::text[])
    GROUP BY constraint_relation.oid, constraint_relation.conname, child.relname, parent_namespace.nspname, parent.relname
    ORDER BY child.relname, constraint_relation.conname
  `, [requiredTablesValue]);
  let externalReferenceCount = 0;
  for (const constraint of constraints.rows) {
    if (constraint.child_columns.length === 0 || constraint.child_columns.length !== constraint.parent_columns.length) {
      throw artifactError("instance_data_reference_closure_invalid", "Core-llm foreign-key metadata is invalid");
    }
    const childPredicate = constraint.child_columns.map((column) => `child_row.${quoteIdentifier(column)} IS NOT NULL`).join(" AND ");
    let count;
    if (constraint.parent_schema === "public" && requiredTables.has(constraint.parent_table)) {
      const parentMatch = constraint.child_columns.map((column, index) => {
        const parentColumn = constraint.parent_columns[index];
        if (!parentColumn) throw artifactError("instance_data_reference_closure_invalid", "Core-llm foreign-key metadata is invalid");
        return `parent_row.${quoteIdentifier(parentColumn)} = child_row.${quoteIdentifier(column)}`;
      }).join(" AND ");
      count = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM ${quoteIdentifier(constraint.child_table)} AS child_row
        WHERE ${childPredicate}
          AND NOT EXISTS (
            SELECT 1 FROM ${quoteIdentifier(constraint.parent_table)} AS parent_row WHERE ${parentMatch}
          )
      `);
    } else {
      count = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM ${quoteIdentifier(constraint.child_table)} AS child_row
        WHERE ${childPredicate}
      `);
    }
    externalReferenceCount += parseSafeCount(count.rows[0]?.count, `constraint ${constraint.constraint_name}`);
  }
  if (externalReferenceCount !== 0) {
    throw artifactError("instance_data_reference_closure_invalid", "Core-llm rows reference data outside the selected profile");
  }
  return deepFreeze({
    status: "valid",
    checkedForeignKeys: constraints.rowCount ?? constraints.rows.length,
    externalReferenceCount: 0,
    checkedBusinessReferences: INSTANCE_DATA_PROFILE.businessReferences.length,
  });
}

async function loadMigrationMetadata(client: Client): Promise<InstanceDataArtifactManifest["migrationLedger"]> {
  const result = await client.query<{
    row_count: string;
    applied_head: string | null;
    failed_names: string[] | null;
    rolled_back_count: string;
  }>(`
    SELECT count(*)::text AS row_count,
           (array_agg(migration_name ORDER BY finished_at DESC NULLS LAST, started_at DESC, id DESC)
             FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL))[1] AS applied_head,
           coalesce(array_agg(migration_name ORDER BY started_at, id)
             FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL), ARRAY[]::text[]) AS failed_names,
           count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::text AS rolled_back_count
    FROM "_prisma_migrations"
  `);
  const row = result.rows[0];
  if (!row) throw artifactError("instance_data_migration_ledger_invalid", "Prisma migration ledger metadata is unavailable");
  return deepFreeze({
    rowCount: parseSafeCount(row.row_count, "migration ledger"),
    sha256: "sha256:" + "0".repeat(64),
    appliedHead: row.applied_head,
    failedMigrationNames: Object.freeze(row.failed_names ?? []),
    rolledBackRowCount: parseSafeCount(row.rolled_back_count, "rolled-back migration ledger"),
  });
}

function buildCopySelect(
  table: string,
  columns: readonly Readonly<{ name: string; sqlType: string }>[],
  primaryKey: readonly string[],
  transforms: Readonly<Record<string, InstanceDataColumnTransform>>,
): string {
  const columnNames = new Set(columns.map((column) => column.name));
  for (const name of Object.keys(transforms)) {
    if (!columnNames.has(name)) throw artifactError("instance_data_transform_column_missing", "Instance-data transform references a missing column");
  }
  const selection = columns.map((column) => {
    const transform = transforms[column.name];
    if (!transform) return quoteIdentifier(column.name);
    if (transform.kind === "null") return `NULL::${column.sqlType} AS ${quoteIdentifier(column.name)}`;
    return `${quoteLiteral(transform.value)}::${column.sqlType} AS ${quoteIdentifier(column.name)}`;
  }).join(", ");
  const ordering = primaryKey.map(quoteIdentifier).join(", ");
  return `COPY (SELECT ${selection} FROM ${quoteIdentifier(table)} ORDER BY ${ordering}) TO STDOUT WITH (FORMAT binary)`;
}

async function copyQueryToFile(client: Client, copySql: string, outputPath: string): Promise<void> {
  const stream = client.query(copyTo(copySql));
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_PAYLOAD_BYTES) stream.destroy(artifactError("instance_data_payload_too_large", "Instance-data payload exceeds the bounded size policy"));
  });
  await pipeline(stream, createWriteStream(outputPath, { mode: 0o600, flags: "wx" }));
}

async function restoreCopyPayload(
  client: Client,
  inspected: InspectedInstanceDataArtifact,
  payloadName: string,
  table: string,
  columns: readonly Readonly<{ name: string }>[],
): Promise<void> {
  const range = inspected.payloadOffsets[payloadName];
  if (!range) throw artifactError("instance_data_artifact_payload_missing", "Instance-data artifact is missing a required payload");
  const sql = `COPY ${quoteIdentifier(table)} (${columns.map((column) => quoteIdentifier(column.name)).join(", ")}) FROM STDIN WITH (FORMAT binary)`;
  await pipeline(createReadStream(inspected.artifactPath, { start: range.start, end: range.end }), client.query(copyFrom(sql)));
}

async function dumpCanonicalSchema(connectionString: string, snapshotId: string | null, outputPath: string): Promise<void> {
  const rawPath = `${outputPath}.raw`;
  const args = ["--schema-only", "--no-owner", "--no-privileges", "--quote-all-identifiers", "--file", rawPath];
  if (snapshotId) args.push("--snapshot", snapshotId);
  await runPostgresTool("pg_dump", args, connectionString, { timeoutMs: 10 * 60_000 });
  const normalized = readFileSync(rawPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith("\\restrict ") && !line.startsWith("\\unrestrict ")
      && !line.startsWith("-- Dumped from database version") && !line.startsWith("-- Dumped by pg_dump version"))
    .join("\n");
  writeFileSync(outputPath, normalized.endsWith("\n") ? normalized : `${normalized}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  rmSync(rawPath, { force: true });
}

async function runPostgresTool(
  executable: "pg_dump" | "psql",
  args: readonly string[],
  connectionString: string,
  options: Readonly<{ timeoutMs: number }>,
): Promise<void> {
  const connection = postgresEnvironment(connectionString);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ...connection, PGCONNECT_TIMEOUT: "10" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(artifactError("instance_data_postgres_tool_unavailable", "Required PostgreSQL client tool is unavailable"));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(artifactError("instance_data_postgres_tool_failed", `PostgreSQL client tool failed (${signal ? "signal" : "exit"})`));
    });
  });
}

function postgresEnvironment(connectionString: string): NodeJS.ProcessEnv {
  let parsed: URL;
  try { parsed = new URL(connectionString); }
  catch { throw artifactError("instance_data_connection_string_invalid", "Instance-data PostgreSQL connection string is invalid"); }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
    throw artifactError("instance_data_connection_string_invalid", "Instance-data PostgreSQL connection string is invalid");
  }
  const env: NodeJS.ProcessEnv = {
    PGHOST: decodeURIComponent(parsed.hostname),
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
  };
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) env.PGSSLMODE = sslMode;
  return env;
}

async function writeArtifact(
  outputPath: string,
  manifest: InstanceDataArtifactManifest,
  payloadFiles: readonly Readonly<{ payload: InstanceDataArtifactPayload; path: string }>[],
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.partial-${process.pid}`;
  const header = Buffer.from(JSON.stringify(manifest), "utf8");
  if (header.length > MAX_HEADER_BYTES) throw artifactError("instance_data_artifact_header_size_invalid", "Instance-data artifact header is too large");
  const totalSize = ARTIFACT_MAGIC.length + 4 + header.length + payloadFiles.reduce((sum, entry) => sum + entry.payload.size, 0);
  if (!Number.isSafeInteger(totalSize) || totalSize > MAX_ARTIFACT_BYTES) throw artifactError("instance_data_artifact_size_invalid", "Instance-data artifact exceeds the bounded size policy");
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeSync(descriptor, ARTIFACT_MAGIC);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    writeSync(descriptor, length);
    writeSync(descriptor, header);
  } finally {
    closeSync(descriptor);
  }
  try {
    for (const entry of payloadFiles) await pipeline(createReadStream(entry.path), createWriteStream(temporaryPath, { flags: "a", mode: 0o600 }));
    await rename(temporaryPath, outputPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function extractPayload(inspected: InspectedInstanceDataArtifact, payloadName: string, outputPath: string): Promise<void> {
  const range = inspected.payloadOffsets[payloadName];
  if (!range) throw artifactError("instance_data_artifact_payload_missing", "Instance-data artifact is missing a required payload");
  await pipeline(createReadStream(inspected.artifactPath, { start: range.start, end: range.end }), createWriteStream(outputPath, { mode: 0o600, flags: "wx" }));
}

function payloadForFile(name: string, kind: InstanceDataArtifactPayload["kind"], table: string | null, path: string): InstanceDataArtifactPayload {
  const size = statSync(path).size;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PAYLOAD_BYTES) throw artifactError("instance_data_payload_size_invalid", "Instance-data payload size is invalid");
  return deepFreeze({ name, kind, table, size, sha256: sha256File(path) });
}

function validateArtifactManifest(value: unknown): InstanceDataArtifactManifest {
  const manifest = value as InstanceDataArtifactManifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.schema !== ARTIFACT_SCHEMA) {
    throw artifactError("instance_data_artifact_manifest_invalid", "Instance-data artifact manifest schema is invalid");
  }
  const expectedTables = [...listRequiredInstanceDataTables()].sort();
  if (manifest.profile?.id !== INSTANCE_DATA_PROFILE.profileId || manifest.profile.version !== INSTANCE_DATA_PROFILE.version
    || manifest.profile.schema !== INSTANCE_DATA_PROFILE.schema || JSON.stringify(manifest.profile.requiredTables) !== JSON.stringify(expectedTables)) {
    throw artifactError("instance_data_artifact_profile_mismatch", "Instance-data artifact profile does not match the current core-llm contract");
  }
  if (!ALLOWED_SOURCE_INSTANCES.has(manifest.source?.instance) || !SHA256.test(manifest.source.databaseFingerprint)
    || !Number.isSafeInteger(manifest.source.serverVersionNum) || manifest.source.serverVersionNum < 180000) {
    throw artifactError("instance_data_artifact_source_invalid", "Instance-data artifact source identity is invalid");
  }
  for (const time of [manifest.snapshot?.startedAt, manifest.snapshot?.completedAt, manifest.createdAt, manifest.expiresAt]) {
    if (typeof time !== "string" || !ISO_TIME.test(time) || Number.isNaN(Date.parse(time))) throw artifactError("instance_data_artifact_time_invalid", "Instance-data artifact time is invalid");
  }
  if (!SHA256.test(manifest.snapshot.boundaryDigest) || !SHA256.test(manifest.sourceSchema?.sha256)
    || !SHA256.test(manifest.migrationLedger?.sha256)) {
    throw artifactError("instance_data_artifact_digest_invalid", "Instance-data artifact digest metadata is invalid");
  }
  if (!Array.isArray(manifest.tables) || manifest.tables.length !== expectedTables.length
    || JSON.stringify(manifest.tables.map((table) => table.name).sort()) !== JSON.stringify(expectedTables)) {
    throw artifactError("instance_data_artifact_table_set_invalid", "Instance-data artifact table set is invalid");
  }
  for (const table of manifest.tables) {
    if (!TABLE_NAME.test(table.name) || !Array.isArray(table.columns) || table.columns.length === 0 || table.columns.some((column: string) => !TABLE_NAME.test(column))
      || !Array.isArray(table.primaryKey) || table.primaryKey.length === 0 || table.primaryKey.some((column: string) => !table.columns.includes(column))
      || !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || !SHA256.test(table.contentSha256)
      || !Array.isArray(table.transformedColumns)) {
      throw artifactError("instance_data_artifact_table_invalid", "Instance-data artifact table metadata is invalid");
    }
    const expectedTransforms = Object.entries(INSTANCE_DATA_PROFILE.columnTransforms[table.name] ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([name, transform]) => ({ name, kind: transform.kind }));
    if (JSON.stringify(table.transformedColumns) !== JSON.stringify(expectedTransforms)) {
      throw artifactError("instance_data_artifact_transform_mismatch", "Instance-data artifact column transforms do not match the current security contract");
    }
  }
  if (manifest.closure?.status !== "valid" || manifest.closure.externalReferenceCount !== 0
    || !Number.isSafeInteger(manifest.closure.checkedForeignKeys) || manifest.closure.checkedForeignKeys < 0
    || manifest.closure.checkedBusinessReferences !== INSTANCE_DATA_PROFILE.businessReferences.length) {
    throw artifactError("instance_data_artifact_closure_invalid", "Instance-data artifact reference closure is invalid");
  }
  if (!Array.isArray(manifest.payloads) || manifest.payloads.length !== expectedTables.length + 3) {
    throw artifactError("instance_data_artifact_payload_set_invalid", "Instance-data artifact payload set is invalid");
  }
  const names = new Set<string>();
  for (const payload of manifest.payloads) {
    if (typeof payload.name !== "string" || names.has(payload.name) || !["schema", "migration-ledger", "table", "sequences"].includes(payload.kind)
      || !Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > MAX_PAYLOAD_BYTES || !SHA256.test(payload.sha256)) {
      throw artifactError("instance_data_artifact_payload_invalid", "Instance-data artifact payload metadata is invalid");
    }
    names.add(payload.name);
  }
  if (!names.has("schema.sql") || !names.has("migration-ledger.copy") || !names.has("sequences.json")
    || expectedTables.some((table) => !names.has(`tables/${table}.copy`))) {
    throw artifactError("instance_data_artifact_payload_set_invalid", "Instance-data artifact is missing a required payload");
  }
  return deepFreeze(manifest);
}

async function loadSequenceState(client: Client): Promise<readonly Readonly<{ schemaname: string; sequencename: string; start_value: string; increment_by: string; last_value: string; is_called: boolean }>[]> {
  const metadata = await client.query<{ schemaname: string; sequencename: string; start_value: string; increment_by: string }>(`
    SELECT schemaname, sequencename, start_value::text, increment_by::text
    FROM pg_sequences
    WHERE schemaname = 'public'
    ORDER BY schemaname, sequencename
  `);
  const result = [];
  for (const sequence of metadata.rows) {
    if (!TABLE_NAME.test(sequence.sequencename)) throw artifactError("instance_data_sequence_payload_invalid", "Instance-data sequence name is invalid");
    const state = await client.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text, is_called FROM ${quoteIdentifier(sequence.schemaname)}.${quoteIdentifier(sequence.sequencename)}`,
    );
    const row = state.rows[0];
    if (!row || !/^-?\d+$/u.test(row.last_value) || typeof row.is_called !== "boolean") {
      throw artifactError("instance_data_sequence_payload_invalid", "Instance-data sequence state is invalid");
    }
    result.push(Object.freeze({ ...sequence, last_value: row.last_value, is_called: row.is_called }));
  }
  return Object.freeze(result);
}

function readArtifactPayloadText(inspected: InspectedInstanceDataArtifact, payloadName: string): string {
  const range = inspected.payloadOffsets[payloadName];
  if (!range) throw artifactError("instance_data_artifact_payload_missing", "Instance-data artifact is missing a required payload");
  const descriptor = openSync(inspected.artifactPath, "r");
  try {
    const size = range.end - range.start + 1;
    if (size > MAX_HEADER_BYTES) throw artifactError("instance_data_sequence_payload_invalid", "Instance-data sequence payload is too large");
    const buffer = Buffer.alloc(size);
    if (readSync(descriptor, buffer, 0, size, range.start) !== size) throw artifactError("instance_data_artifact_truncated", "Instance-data artifact payload is truncated");
    return buffer.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function parseSequencePayload(value: string): readonly Readonly<{ schemaname: string; sequencename: string; start_value: string; increment_by: string; last_value: string; is_called: boolean }>[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw artifactError("instance_data_sequence_payload_invalid", "Instance-data sequence payload is invalid JSON"); }
  if (!Array.isArray(parsed)) throw artifactError("instance_data_sequence_payload_invalid", "Instance-data sequence payload is invalid");
  for (const item of parsed) {
    const row = item as Record<string, unknown>;
    if (row.schemaname !== "public" || typeof row.sequencename !== "string" || !TABLE_NAME.test(row.sequencename)
      || typeof row.start_value !== "string" || !/^-?\d+$/u.test(row.start_value)
      || typeof row.increment_by !== "string" || !/^-?\d+$/u.test(row.increment_by)
      || typeof row.last_value !== "string" || !/^-?\d+$/u.test(row.last_value) || typeof row.is_called !== "boolean") {
      throw artifactError("instance_data_sequence_payload_invalid", "Instance-data sequence payload contains invalid metadata");
    }
  }
  return deepFreeze(parsed as Array<{ schemaname: string; sequencename: string; start_value: string; increment_by: string; last_value: string; is_called: boolean }>);
}

function requirePrivateArtifactPath(pathValue: string): string {
  const path = resolve(pathValue);
  if (pathValue !== path) throw artifactError("instance_data_artifact_path_invalid", "Instance-data artifact path must be absolute");
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || realpathSync(path) !== path || (state.mode & 0o077) !== 0) {
    throw artifactError("instance_data_artifact_permissions_invalid", "Instance-data artifact must be a canonical owner-only regular file");
  }
  return path;
}

function requireAbsoluteOutputPath(pathValue: string): string {
  const path = resolve(pathValue);
  if (pathValue !== path || basename(path).startsWith(".")) throw artifactError("instance_data_artifact_path_invalid", "Instance-data artifact output path must be explicit and absolute");
  return path;
}

function requireConnectionString(value: string): void {
  if (typeof value !== "string" || value.length < 16 || /[\r\n\0]/u.test(value)) throw artifactError("instance_data_connection_string_invalid", "Instance-data PostgreSQL connection string is invalid");
}

function quoteIdentifier(value: string): string {
  if (!TABLE_NAME.test(value)) throw artifactError("instance_data_identifier_invalid", "Instance-data SQL identifier is invalid");
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseSafeCount(value: string | undefined, label: string): number {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw artifactError("instance_data_count_invalid", `Invalid ${label} count`);
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw artifactError("instance_data_count_invalid", `Invalid ${label} count`);
  return count;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256File(path: string): string {
  return sha256FileRange(path, 0, statSync(path).size);
}

function sha256FileRange(path: string, start: number, size: number): string {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = start;
    let remaining = size;
    while (remaining > 0) {
      const readLength = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), offset);
      if (readLength <= 0) throw artifactError("instance_data_artifact_truncated", "Instance-data artifact payload is truncated");
      hash.update(buffer.subarray(0, readLength));
      offset += readLength;
      remaining -= readLength;
    }
  } finally {
    closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function artifactError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
