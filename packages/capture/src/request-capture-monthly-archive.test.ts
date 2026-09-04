import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "@frely/config";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FilesystemArchiveRemote, type ArchiveRemote, type ArchiveRemoteObject } from "./archive-remote.js";
import {
  REQUEST_CAPTURE_ARCHIVE_CATALOG_COLUMNS,
  writeRequestCaptureArchiveCatalog,
} from "./request-capture-archive-catalog.js";
import {
  copyRequestCaptureArchiveBundle,
  captureManifestObjectKey,
  REQUEST_LIFECYCLE_ABANDONED_ERROR_CODE,
  queryRequestCaptureMonthlyArchives,
  queryRequestCaptureMonthlyArchivesWithFallback,
  purgeVerifiedRequestCaptureMonth,
  readRequestCaptureArchiveRecordByRequestId,
  readRequestCaptureArchiveManifest,
  readRequestCaptureArchiveRecord,
  runRequestCaptureMonthlyArchive,
  runRequestCaptureMonthlyArchiveCatchUp,
  verifyRequestCaptureMonthlyArchive,
} from "./request-capture-monthly-archive.js";
import { RequestCaptureV3Storage } from "./request-capture-v3.js";
import type { RequestLog } from "./contracts.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DEF-20260813 Capture cold archive self-describing Catalog", () => {
  test("moves complete v3 bundles and queries allowlisted metadata across months without PostgreSQL", async () => {
    const fixture = await createFixture();
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await copyAllMonths(fixture);
      const remote = new FilesystemArchiveRemote(fixture.migrated, { createRoot: false, enforcePrivateObjects: true });
      const byId = await queryRequestCaptureMonthlyArchives(remote, {
        months: ["2026-01", "2026-02"],
        filter: { requestId: "req_catalog_2" },
        scope: { kind: "request", requestId: "req_catalog_2" },
      });
      expect(byId.map((row) => row.requestId)).toEqual(["req_catalog_2"]);

      const combined = await queryRequestCaptureMonthlyArchives(remote, {
        months: ["2026-01", "2026-02"],
        filter: {
          status: "completed",
          userId: "user_1",
          teamId: "team_1",
          apiKeyId: "key_1",
          requestPath: "/v1/responses",
          requestModel: "model-a",
          startedAtGte: "2026-01-01T00:00:00.000Z",
          startedAtLt: "2026-03-01T00:00:00.000Z",
        },
        scope: { kind: "user", userId: "user_1" },
      });
      expect(combined.map((row) => row.requestId)).toEqual(["req_catalog_1", "req_catalog_3"]);
      expect(REQUEST_CAPTURE_ARCHIVE_CATALOG_COLUMNS).toEqual([
        "request_id", "started_at", "ended_at", "status", "user_id", "team_id", "api_key_id", "request_path",
        "request_model", "pack_object_key", "frame_offset", "frame_length", "frame_uncompressed_length", "frame_sha256",
        "record_offset", "record_length", "record_sha256", "capture_schema_version",
      ]);
      expect(JSON.stringify(combined)).not.toContain("body-secret");
      expect(JSON.stringify(combined)).not.toContain("provider-credential-secret");
      expect(JSON.stringify(combined)).not.toContain("raw-api-key-secret");

      const childEnvironment = { ...process.env };
      delete childEnvironment.DATABASE_URL;
      const childResult = JSON.parse(execFileSync("bun", [
        "packages/db-ops/src/cli-capture-archive.ts", "query",
        "--root", fixture.migrated,
        "--month", "2026-01",
        "--request-id", "req_catalog_2",
        "--offline-authorized",
        "--scope", "request:req_catalog_2",
      ], { cwd: process.cwd(), env: childEnvironment, encoding: "utf8" })) as { rows: Array<{ requestId: string }> };
      expect(childResult.rows.map((row) => row.requestId)).toEqual(["req_catalog_2"]);
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test("reads exactly one located pack frame and validates frame and record hashes", async () => {
    const fixture = await createFixture();
    await copyAllMonths(fixture);
    const base = new FilesystemArchiveRemote(fixture.migrated, { createRoot: false, enforcePrivateObjects: true });
    const remote = new TrackingArchiveRemote(base);
    const rows = await queryRequestCaptureMonthlyArchives(remote, {
      months: ["2026-01"],
      filter: { requestId: "req_catalog_2" },
      scope: { kind: "request", requestId: "req_catalog_2" },
    });
    const locator = rows[0]!;
    const manifest = await readRequestCaptureArchiveManifest(remote, "2026-01");
    remote.ranges.length = 0;
    const raw = await readRequestCaptureArchiveRecord({ remote, manifest, locator });
    expect(JSON.parse(raw.toString("utf8")).requestId).toBe("req_catalog_2");
    expect(remote.ranges).toEqual([{
      key: manifest.pack.objectKey,
      offset: locator.frameOffset,
      length: locator.frameLength,
    }]);
    expect(locator.frameLength).toBeLessThan(manifest.pack.bytes);
    expect(locator.frameUncompressedLength).toBeLessThanOrEqual(manifest.frameUncompressedBytes);

    await expect(readRequestCaptureArchiveRecord({
      remote,
      manifest,
      locator: { ...locator, frameOffset: manifest.pack.bytes },
    })).rejects.toMatchObject({ code: "request_capture_archive_locator_out_of_bounds" });
    await expect(readRequestCaptureArchiveRecord({
      remote,
      manifest,
      locator: { ...locator, frameSha256: "0".repeat(64) },
    })).rejects.toMatchObject({ code: "request_capture_archive_pack_frame_invalid" });
    await expect(readRequestCaptureArchiveRecord({
      remote,
      manifest,
      locator: { ...locator, recordSha256: "0".repeat(64) },
    })).rejects.toMatchObject({ code: "request_capture_archive_record_hash_mismatch" });

    const packPath = join(fixture.migrated, manifest.pack.objectKey);
    const pack = readFileSync(packPath);
    pack[locator.frameOffset + 8] ^= 0x01;
    writeFileSync(packPath, pack);
    await expect(readRequestCaptureArchiveRecord({ remote, manifest, locator }))
      .rejects.toMatchObject({ code: "request_capture_archive_pack_frame_invalid" });
  });

  test("fails closed for empty queries, unauthorized scopes, duplicate ids, and damaged bundle objects", async () => {
    const fixture = await createFixture();
    await copyAllMonths(fixture);
    const remote = new FilesystemArchiveRemote(fixture.migrated, { createRoot: false, enforcePrivateObjects: true });

    await expect(queryRequestCaptureMonthlyArchives(remote, {
      months: ["2026-01"],
      filter: {},
      scope: { kind: "platform_owner" },
    })).rejects.toMatchObject({ code: "request_capture_archive_query_empty" });
    await expect(queryRequestCaptureMonthlyArchives(remote, {
      months: ["2026-01"],
      filter: { requestId: "req_catalog_2" },
      scope: { kind: "request", requestId: "req_catalog_1" },
    })).rejects.toMatchObject({ code: "request_capture_archive_scope_unauthorized" });

    const manifest = await readRequestCaptureArchiveManifest(remote, "2026-01");
    const rows = await queryRequestCaptureMonthlyArchives(remote, {
      months: ["2026-01"],
      filter: { startedAtGte: manifest.cutoffGte, startedAtLt: manifest.cutoffLt },
      scope: { kind: "platform_owner" },
    });
    const duplicatePath = join(fixture.root, "duplicate.parquet");
    await expect(writeRequestCaptureArchiveCatalog(duplicatePath, [rows[0]!, rows[0]!]))
      .rejects.toMatchObject({ code: "request_capture_archive_catalog_duplicate_request_id" });

    const packPath = join(fixture.migrated, manifest.pack.objectKey);
    const pack = readFileSync(packPath);
    pack[pack.length - 1] ^= 0xff;
    writeFileSync(packPath, pack);
    await expect(verifyRequestCaptureMonthlyArchive({ remote, manifest }))
      .rejects.toMatchObject({ code: "request_capture_archive_object_mismatch" });
  });

  test("falls back to a bounded pack scan when a v3 Catalog is missing and fails closed for other bundle damage", async () => {
    const fixture = await createFixture();
    await copyAllMonths(fixture);
    const remote = new FilesystemArchiveRemote(fixture.migrated, { createRoot: false, enforcePrivateObjects: true });
    const manifest = await readRequestCaptureArchiveManifest(remote, "2026-01");
    const rows = await queryRequestCaptureMonthlyArchives(remote, {
      months: ["2026-01"],
      filter: { requestId: "req_catalog_1" },
      scope: { kind: "request", requestId: "req_catalog_1" },
    });
    const locator = rows[0]!;
    const catalogPath = join(fixture.migrated, manifest.catalog.objectKey);
    const packPath = join(fixture.migrated, manifest.pack.objectKey);
    const catalogBytes = readFileSync(catalogPath);
    const packBytes = readFileSync(packPath);

    rmSync(catalogPath);
    const fallbackRows = await queryRequestCaptureMonthlyArchivesWithFallback(remote, {
      months: ["2026-01"],
      filter: { requestId: "req_catalog_1" },
      scope: { kind: "request", requestId: "req_catalog_1" },
    });
    expect(fallbackRows).toEqual([expect.objectContaining({
      source: "pack_scan",
      archiveFormatVersion: 3,
      requestId: "req_catalog_1",
      userId: "user_1",
      requestModel: "model-a",
    })]);
    const fallbackRaw = await readRequestCaptureArchiveRecordByRequestId({
      remote,
      month: "2026-01",
      requestId: "req_catalog_1",
    });
    expect(JSON.parse(fallbackRaw!.toString("utf8")).requestId).toBe("req_catalog_1");
    await expect(queryRequestCaptureMonthlyArchivesWithFallback(remote, {
      months: ["2026-01"],
      filter: { requestPath: "/v1/responses" },
      scope: { kind: "platform_owner" },
    })).rejects.toMatchObject({ code: "request_capture_archive_pack_scan_filter_unavailable" });
    writeFileSync(catalogPath, catalogBytes, { mode: 0o600 });

    rmSync(packPath);
    await expect(readRequestCaptureArchiveRecord({ remote, manifest, locator })).rejects.toMatchObject({ code: "ENOENT" });
    writeFileSync(packPath, packBytes, { mode: 0o600 });

    const corruptCatalog = Buffer.from(catalogBytes);
    corruptCatalog[Math.floor(corruptCatalog.length / 2)] ^= 0xff;
    writeFileSync(catalogPath, corruptCatalog);
    await expect(queryRequestCaptureMonthlyArchives(remote, {
      months: ["2026-01"],
      filter: { requestId: "req_catalog_1" },
      scope: { kind: "request", requestId: "req_catalog_1" },
    })).rejects.toMatchObject({ code: "request_capture_archive_catalog_mismatch" });
  });

  test("queries and reads an archive-format-v2 month that never had a Parquet Catalog", async () => {
    const fixture = await createFixture();
    await writeLegacyV2Bundle(fixture, "2026-01");
    const remote = new FilesystemArchiveRemote(fixture.legacy, { createRoot: false, enforcePrivateObjects: true });
    const rows = await queryRequestCaptureMonthlyArchivesWithFallback(remote, {
      months: ["2026-01"],
      filter: { userId: "user_1", requestModel: "model-a" },
      scope: { kind: "user", userId: "user_1" },
    });
    expect(rows).toEqual([expect.objectContaining({
      source: "pack_scan",
      archiveFormatVersion: 2,
      archiveMonth: "2026-01",
      requestId: "req_catalog_1",
    })]);
    const raw = await readRequestCaptureArchiveRecordByRequestId({
      remote,
      month: "2026-01",
      requestId: "req_catalog_2",
    });
    expect(JSON.parse(raw!.toString("utf8")).requestId).toBe("req_catalog_2");

    const childEnvironment = { ...process.env };
    delete childEnvironment.DATABASE_URL;
    const childResult = JSON.parse(execFileSync("bun", [
      "packages/db-ops/src/cli-capture-archive.ts", "query",
      "--root", fixture.legacy,
      "--month", "2026-01",
      "--request-id", "req_catalog_2",
      "--offline-authorized",
      "--scope", "request:req_catalog_2",
    ], { cwd: process.cwd(), env: childEnvironment, encoding: "utf8" })) as { rows: Array<{ source: string; requestId: string }> };
    expect(childResult.rows).toEqual([expect.objectContaining({ source: "pack_scan", requestId: "req_catalog_2" })]);
  });
});

describe("DEF-20260830 Capture cold archive production responsibility", () => {
  test("DEF-20260904 archives the local Capture inventory when shared Request Logs span multiple instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-regional-inventory-v3-"));
    roots.push(root);
    const hot = join(root, "hot");
    const cold = join(root, "cold");
    for (const directory of [hot, cold]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const config = fixtureConfig(hot, cold);
    const storage = new RequestCaptureV3Storage({ archiveDirectory: hot });
    const captured = requestLog("req_captured", "2026-07-10T10:00:00.000Z", "completed", "user_1", null, "key_1", "/v1/responses", "model-a");
    const otherInstance = requestLog("req_other_instance", "2026-07-11T10:00:00.000Z", "completed", "user_1", null, "key_1", "/v1/responses", "model-a");
    const abandonedWithoutCapture = {
      ...requestLog("req_abandoned_without_capture", "2026-07-12T10:00:00.000Z", "failed", "user_1", null, "key_1", "/v1/responses", "model-a"),
      errorCode: REQUEST_LIFECYCLE_ABANDONED_ERROR_CODE,
    };
    const abandonedWithCapture = {
      ...requestLog("req_abandoned_with_capture", "2026-07-13T10:00:00.000Z", "failed", "user_1", null, "key_1", "/v1/responses", "model-a"),
      errorCode: REQUEST_LIFECYCLE_ABANDONED_ERROR_CODE,
    };
    for (const log of [captured, abandonedWithCapture]) {
      storage.writeExchange({
        requestLogStartedAt: log.startedAt,
        requestId: log.id,
        apiKeyId: log.apiKeyId,
        userId: log.userId,
        teamId: log.teamId,
        kind: "responses",
        reqModel: log.reqModel,
        originalPayload: { prompt: "private" },
        response: { status: log.status === "completed" ? 200 : 500, body: { ok: log.status === "completed" } },
      });
    }
    const logs = [captured, otherInstance, abandonedWithoutCapture, abandonedWithCapture];
    const source = monthSource(logs);

    const result = await runRequestCaptureMonthlyArchive({
      config,
      source,
      month: "2026-07",
      now: new Date("2026-08-15T00:00:00.000Z"),
      skipMountIdentityCheck: true,
    });
    const rows = await queryRequestCaptureMonthlyArchives(new FilesystemArchiveRemote(cold), {
      months: ["2026-07"],
      filter: { startedAtGte: "2026-07-01T00:00:00.000Z", startedAtLt: "2026-08-01T00:00:00.000Z" },
      scope: { kind: "platform_owner" },
    });

    expect(result).toMatchObject({ archiveMonth: "2026-07", recordCount: 2, idempotent: false });
    expect(rows.map((row) => row.requestId)).toEqual([captured.id, abandonedWithCapture.id]);
    await expect(runRequestCaptureMonthlyArchive({
      config,
      source,
      month: "2026-07",
      now: new Date("2026-08-15T00:00:00.000Z"),
      skipMountIdentityCheck: true,
    })).resolves.toMatchObject({ archiveMonth: "2026-07", recordCount: 2, idempotent: true });

    storage.writeExchange({
      requestLogStartedAt: "2026-07-14T10:00:00.000Z",
      requestId: "req_without_request_log",
      apiKeyId: "key_1",
      userId: "user_1",
      teamId: null,
      kind: "responses",
      reqModel: "model-a",
      originalPayload: { prompt: "private" },
      response: { status: 200, body: { ok: true } },
    });
    await expect(runRequestCaptureMonthlyArchive({
      config,
      source,
      month: "2026-07",
      now: new Date("2026-08-15T00:00:00.000Z"),
      skipMountIdentityCheck: true,
    })).rejects.toMatchObject({ code: "request_capture_archive_source_inventory_mismatch" });
  });

  test("archives a Capture whose null team identity was enriched on its Request Log", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-team-enrichment-v3-"));
    roots.push(root);
    const hot = join(root, "hot");
    const cold = join(root, "cold");
    for (const directory of [hot, cold]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const config = fixtureConfig(hot, cold);
    const storage = new RequestCaptureV3Storage({ archiveDirectory: hot });
    const log = requestLog("req_team_enriched", "2026-07-12T10:00:00.000Z", "completed", "user_1", "team_1", "key_1", "/v1/responses", "model-a");
    storage.writeExchange({
      requestLogStartedAt: log.startedAt,
      requestId: log.id,
      apiKeyId: log.apiKeyId,
      userId: log.userId,
      teamId: null,
      kind: "responses",
      reqModel: log.reqModel,
      originalPayload: { prompt: "private" },
      response: { status: 200, body: { ok: true } },
    });
    const source = monthSource([log]);

    const result = await runRequestCaptureMonthlyArchive({
      config,
      source,
      month: "2026-07",
      now: new Date("2026-08-15T00:00:00.000Z"),
      skipMountIdentityCheck: true,
    });
    const rows = await queryRequestCaptureMonthlyArchives(new FilesystemArchiveRemote(cold), {
      months: ["2026-07"],
      filter: { requestId: log.id },
      scope: { kind: "platform_owner" },
    });

    expect(result).toMatchObject({ archiveMonth: "2026-07", recordCount: 1 });
    expect(rows).toEqual([expect.objectContaining({ requestId: log.id, teamId: "team_1" })]);
  });

  test("rejects a Capture whose non-null team conflicts with its Request Log", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-team-conflict-v3-"));
    roots.push(root);
    const hot = join(root, "hot");
    const cold = join(root, "cold");
    for (const directory of [hot, cold]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const config = fixtureConfig(hot, cold);
    const storage = new RequestCaptureV3Storage({ archiveDirectory: hot });
    const log = requestLog("req_team_conflict", "2026-07-13T10:00:00.000Z", "completed", "user_1", "team_new", "key_1", "/v1/responses", "model-a");
    storage.writeExchange({
      requestLogStartedAt: log.startedAt,
      requestId: log.id,
      apiKeyId: log.apiKeyId,
      userId: log.userId,
      teamId: "team_old",
      kind: "responses",
      reqModel: log.reqModel,
      originalPayload: { prompt: "private" },
      response: { status: 200, body: { ok: true } },
    });

    await expect(runRequestCaptureMonthlyArchive({
      config,
      source: monthSource([log]),
      month: "2026-07",
      now: new Date("2026-08-15T00:00:00.000Z"),
      skipMountIdentityCheck: true,
    })).rejects.toMatchObject({ code: "request_capture_archive_source_request_mismatch" });
  });

  test("plans bounded hot and cold capacity without committing an archive", async () => {
    const fixture = createCatchUpFixture();
    const result = await runRequestCaptureMonthlyArchive({
      config: fixture.config,
      source: fixture.repository,
      month: "2026-02",
      now: new Date("2026-03-15T00:00:00.000Z"),
      dryRun: true,
      skipMountIdentityCheck: true,
    });

    expect(result.capacity.requiredHotStagingBytes).toBe(0);
    expect(result.capacity.requiredColdBytes).toBeGreaterThan(result.compressedBytes);
    expect(result.capacity.hotAvailableBytes).toBeGreaterThan(0);
    expect(result.capacity.coldAvailableBytes).toBeGreaterThan(result.capacity.requiredColdBytes);
    expect(existsSync(join(fixture.cold, captureManifestObjectKey("2026-02")))).toBe(false);
  });

  test("stages production archives on cold storage without consuming hot staging capacity", async () => {
    const fixture = createCatchUpFixture();
    const result = await runRequestCaptureMonthlyArchive({
      config: fixture.config,
      source: fixture.repository,
      month: "2026-02",
      now: new Date("2026-03-15T00:00:00.000Z"),
      skipMountIdentityCheck: true,
    });

    expect(result.capacity.requiredHotStagingBytes).toBe(0);
    expect(existsSync(join(fixture.hot, ".staging"))).toBe(false);
    expect(readdirSync(join(fixture.cold, ".staging"))).toEqual([]);
    expect(existsSync(join(fixture.cold, captureManifestObjectKey("2026-02")))).toBe(true);
  });

  test("isolates one blocked month, archives later months, and reports a stable failure", async () => {
    const fixture = createCatchUpFixture();
    const results = await runRequestCaptureMonthlyArchiveCatchUp({
      config: fixture.config,
      source: fixture.repository,
      now: new Date("2026-03-15T00:00:00.000Z"),
      skipMountIdentityCheck: true,
    });

    expect(results).toEqual([
      {
        archiveMonth: "2026-01",
        status: "blocked",
        failureCode: "request_capture_archive_source_invalid",
      },
      {
        archiveMonth: "2026-02",
        status: "archived",
        result: expect.objectContaining({ archiveMonth: "2026-02", idempotent: false }),
      },
    ]);
    expect(existsSync(join(fixture.cold, captureManifestObjectKey("2026-01")))).toBe(false);
    expect(existsSync(join(fixture.cold, captureManifestObjectKey("2026-02")))).toBe(true);
  });

  test("reports safe month progress and stable failure phases without Capture contents", async () => {
    const fixture = createCatchUpFixture();
    const progress: Array<Record<string, unknown>> = [];
    await runRequestCaptureMonthlyArchiveCatchUp({
      config: fixture.config,
      source: fixture.repository,
      now: new Date("2026-03-15T00:00:00.000Z"),
      skipMountIdentityCheck: true,
      onProgress: (event) => { progress.push(event); },
    });

    expect(progress.map((event) => event.phase)).toEqual(expect.arrayContaining([
      "month_started",
      "preflight",
      "source_inventory",
      "staging",
      "cold_verify",
      "completed",
      "month_failed",
    ]));
    expect(progress.some((event) => event.archiveMonth === "2026-02" && event.phase === "staging" && event.recordsProcessed === event.recordsTotal)).toBe(true);
    const serialized = JSON.stringify(progress);
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("raw-api-key-secret");
    expect(progress.find((event) => event.phase === "month_failed")).toMatchObject({
      archiveMonth: "2026-01",
      failureCode: "request_capture_archive_source_invalid",
    });
  });
});

describe("DEF-20260903 Capture idempotent FUSE read amplification", () => {
  test("revalidates an existing bundle without repeating cold range reads for every hot record", async () => {
    const fixture = await createFixture();
    const remote = new FilesystemArchiveRemote(fixture.cold, { createRoot: false, enforcePrivateObjects: true });
    const manifest = await readRequestCaptureArchiveManifest(remote, "2026-01");
    const readRange = vi.spyOn(FilesystemArchiveRemote.prototype, "readRange");

    await expect(runRequestCaptureMonthlyArchive({
      config: fixture.config,
      source: fixture.repository,
      month: "2026-01",
      now: new Date("2026-04-01T00:00:00.000Z"),
      skipMountIdentityCheck: true,
    })).resolves.toMatchObject({ archiveMonth: "2026-01", idempotent: true });
    expect(readRange).toHaveBeenCalledTimes(manifest.frameCount + 1);

    readRange.mockClear();
    const changed = fixture.logs[0]!;
    rmSync(fixture.storage.pathForRequest(changed.startedAt, changed.id));
    fixture.storage.writeExchange({
      requestLogStartedAt: changed.startedAt,
      requestId: changed.id,
      apiKeyId: changed.apiKeyId,
      userId: changed.userId,
      teamId: changed.teamId,
      kind: "responses",
      reqModel: changed.reqModel,
      originalPayload: { prompt: "changed-private-capture" },
      response: { status: 200, body: { ok: true } },
    });
    await expect(runRequestCaptureMonthlyArchive({
      config: fixture.config,
      source: fixture.repository,
      month: "2026-01",
      now: new Date("2026-04-01T00:00:00.000Z"),
      skipMountIdentityCheck: true,
    })).rejects.toMatchObject({ code: "request_capture_archive_source_drift" });
    expect(readRange).toHaveBeenCalledTimes(manifest.frameCount + 1);
  });
});

describe("DEF-20260901 verified month Capture reclamation", () => {
  test("plans and purges only the explicit verified month while auto-purge and hot retention remain unchanged", async () => {
    const fixture = await createFixture();
    const januaryPaths = fixture.logs
      .filter((log) => log.startedAt.startsWith("2026-01"))
      .map((log) => fixture.storage.pathForRequest(log.startedAt, log.id));
    const februaryPath = fixture.storage.pathForRequest(fixture.logs[2]!.startedAt, fixture.logs[2]!.id);
    fixture.logs.push(requestLog(
      "req_other_instance_without_local_capture",
      "2026-01-05T10:00:00.000Z",
      "completed",
      "user_3",
      null,
      "key_3",
      "/v1/responses",
      "model-c",
    ));

    expect(fixture.config.requestCapture.archive.autoPurge).toBe(false);
    expect(fixture.config.requestCapture.hotDays).toBe(90);
    const planned = await purgeVerifiedRequestCaptureMonth({
      config: fixture.config,
      source: fixture.repository,
      month: "2026-01",
      now: new Date("2026-02-15T00:00:00.000Z"),
      execute: false,
      skipMountIdentityCheck: true,
    });
    expect(planned).toMatchObject({
      archiveMonth: "2026-01",
      execute: false,
      eligibleCount: 2,
      removedCount: 0,
      alreadyMissingCount: 0,
      remainingEligibleCount: 2,
    });
    expect(planned.reclaimableBytes).toBeGreaterThan(0);
    expect(januaryPaths.every((path) => existsSync(path))).toBe(true);
    await expect(purgeVerifiedRequestCaptureMonth({
      config: {
        ...fixture.config,
        requestCapture: {
          ...fixture.config.requestCapture,
          archive: { ...fixture.config.requestCapture.archive, autoPurge: true },
        },
      },
      source: fixture.repository,
      month: "2026-01",
      now: new Date("2026-02-15T00:00:00.000Z"),
      execute: true,
      skipMountIdentityCheck: true,
    })).rejects.toMatchObject({ code: "request_capture_verified_month_purge_requires_auto_purge_disabled" });

    const applied = await purgeVerifiedRequestCaptureMonth({
      config: fixture.config,
      source: fixture.repository,
      month: "2026-01",
      now: new Date("2026-02-15T00:00:00.000Z"),
      execute: true,
      skipMountIdentityCheck: true,
    });
    expect(applied).toMatchObject({
      archiveMonth: "2026-01",
      execute: true,
      eligibleCount: 2,
      removedCount: 2,
      alreadyMissingCount: 0,
      remainingEligibleCount: 0,
    });
    expect(applied.removedBytes).toBe(planned.reclaimableBytes);
    expect(januaryPaths.every((path) => !existsSync(path))).toBe(true);
    expect(existsSync(februaryPath)).toBe(true);
    expect(fixture.logs).toHaveLength(4);

    await expect(purgeVerifiedRequestCaptureMonth({
      config: fixture.config,
      source: fixture.repository,
      month: "2026-01",
      now: new Date("2026-02-15T00:00:00.000Z"),
      execute: true,
      skipMountIdentityCheck: true,
    })).resolves.toMatchObject({ removedCount: 0, alreadyMissingCount: 2, remainingEligibleCount: 0 });
  });

  test("rejects a manifest source snapshot that is not derived from the verified pack", async () => {
    const fixture = await createFixture();
    const remote = new FilesystemArchiveRemote(fixture.cold, { createRoot: false, enforcePrivateObjects: true });
    const manifest = await readRequestCaptureArchiveManifest(remote, "2026-01");

    await expect(verifyRequestCaptureMonthlyArchive({
      remote,
      manifest: { ...manifest, sourceSnapshotSha256: "0".repeat(64) },
    })).rejects.toMatchObject({ code: "request_capture_archive_source_snapshot_mismatch" });
  });
});

function monthSource(logs: RequestLog[]) {
  return {
    listRecentRequestLogs: async (filter: { startedAtGte?: string; startedAtLte?: string } = {}, limit = 10_000, offset = 0) => logs
      .filter((row) => (!filter.startedAtGte || row.startedAt >= filter.startedAtGte)
        && (!filter.startedAtLte || row.startedAt <= filter.startedAtLte))
      .slice(offset, offset + limit),
  };
}

function createCatchUpFixture(): {
  root: string;
  hot: string;
  cold: string;
  config: AppConfig;
  repository: { listRecentRequestLogs: (filter?: { startedAtGte?: string; startedAtLte?: string }, limit?: number, offset?: number) => Promise<RequestLog[]> };
} {
  const root = mkdtempSync(join(tmpdir(), "capture-catch-up-v3-"));
  roots.push(root);
  const hot = join(root, "hot");
  const cold = join(root, "cold");
  for (const directory of [hot, cold]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = fixtureConfig(hot, cold);
  const storage = new RequestCaptureV3Storage({ archiveDirectory: hot });
  const logs = [
    requestLog("req_blocked_month", "2026-01-03T10:00:00.000Z", "completed", "user_1", "team_1", "key_1", "/v1/responses", "model-a"),
    requestLog("req_later_month", "2026-02-03T10:00:00.000Z", "completed", "user_1", "team_1", "key_1", "/v1/responses", "model-a"),
  ];
  for (const log of logs) {
    storage.writeExchange({
      requestLogStartedAt: log.startedAt,
      requestId: log.id,
      apiKeyId: log.apiKeyId,
      userId: log.userId,
      teamId: log.teamId,
      kind: "responses",
      reqModel: log.reqModel,
      originalPayload: { prompt: `private-${log.id}` },
      response: { status: 200, body: { ok: true } },
    });
  }
  writeFileSync(storage.pathForRequest(logs[0]!.startedAt, logs[0]!.id), "not-zstd", { mode: 0o600 });
  const repository = {
    listRecentRequestLogs: async (filter: { startedAtGte?: string; startedAtLte?: string } = {}, limit = 10_000, offset = 0) => logs
      .filter((row) => (!filter.startedAtGte || row.startedAt >= filter.startedAtGte)
        && (!filter.startedAtLte || row.startedAt <= filter.startedAtLte))
      .slice(offset, offset + limit),
  };
  return { root, hot, cold, config, repository };
}

async function createFixture(): Promise<{
  root: string;
  hot: string;
  cold: string;
  migrated: string;
  legacy: string;
  staging: string;
  config: AppConfig;
  storage: RequestCaptureV3Storage;
  logs: RequestLog[];
  repository: ReturnType<typeof monthSource>;
}> {
  const root = mkdtempSync(join(tmpdir(), "capture-catalog-v3-"));
  roots.push(root);
  const hot = join(root, "hot");
  const cold = join(root, "cold");
  const migrated = join(root, "migrated");
  const legacy = join(root, "legacy");
  const staging = join(root, "staging");
  for (const directory of [hot, cold, migrated, legacy, staging]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = fixtureConfig(hot, cold);
  const storage = new RequestCaptureV3Storage({ archiveDirectory: hot });
  const logs = [
    requestLog("req_catalog_1", "2026-01-03T10:00:00.000Z", "completed", "user_1", "team_1", "key_1", "/v1/responses?secret=query", "model-a"),
    requestLog("req_catalog_2", "2026-01-04T10:00:00.000Z", "failed", "user_2", null, "key_2", "https://relay.invalid/v1/chat/completions?token=secret", "model-b"),
    requestLog("req_catalog_3", "2026-02-03T10:00:00.000Z", "completed", "user_1", "team_1", "key_1", "/v1/responses?another=query", "model-a"),
  ];
  for (const log of logs) {
    storage.writeExchange({
      requestLogStartedAt: log.startedAt,
      requestId: log.id,
      apiKeyId: log.apiKeyId,
      userId: log.userId,
      teamId: log.teamId,
      kind: "responses",
      reqModel: log.reqModel,
      originalPayload: {
        prompt: `body-secret-${log.id}-${"x".repeat(1024)}`,
        authorization: "raw-api-key-secret",
        providerCredential: "provider-credential-secret",
      },
      response: { status: log.status === "completed" ? 200 : 500, body: { ok: log.status === "completed" } },
    });
  }
  const repository = {
    listRecentRequestLogs: async (filter: { startedAtGte?: string; startedAtLte?: string } = {}, limit = 10_000, offset = 0) => logs
      .filter((row) => (!filter.startedAtGte || row.startedAt >= filter.startedAtGte)
        && (!filter.startedAtLte || row.startedAt <= filter.startedAtLte))
      .slice(offset, offset + limit),
  };
  await runRequestCaptureMonthlyArchive({ config, source: repository, month: "2026-01", now: new Date("2026-04-01T00:00:00.000Z"), skipMountIdentityCheck: true });
  await runRequestCaptureMonthlyArchive({ config, source: repository, month: "2026-02", now: new Date("2026-04-01T00:00:00.000Z"), skipMountIdentityCheck: true });
  return { root, hot, cold, migrated, legacy, staging, config, storage, logs, repository };
}

async function writeLegacyV2Bundle(fixture: Awaited<ReturnType<typeof createFixture>>, month: string): Promise<void> {
  const source = new FilesystemArchiveRemote(fixture.cold, { createRoot: false, enforcePrivateObjects: true });
  const manifest = await readRequestCaptureArchiveManifest(source, month);
  const pack = readFileSync(join(fixture.cold, manifest.pack.objectKey));
  Buffer.from("FRCAPV2\0", "ascii").copy(pack, 0);
  const sha256 = createHash("sha256").update(pack).digest("hex");
  const [year, value] = month.split("-");
  const prefix = join(fixture.legacy, "cold", "v2", `year=${year}`, `month=${value}`, "capture");
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const packName = `captures-v3-${sha256}.zstpack`;
  writeFileSync(join(prefix, packName), pack, { mode: 0o600 });
  writeFileSync(join(prefix, "captures-manifest-v2.json"), `${JSON.stringify({
    manifestVersion: 2,
    archiveFormatVersion: 2,
    kind: "request-capture-month",
    archiveMonth: month,
    cutoffGte: manifest.cutoffGte,
    cutoffLt: manifest.cutoffLt,
    sourceSnapshotSha256: manifest.sourceSnapshotSha256,
    recordCount: manifest.recordCount,
    frameCount: manifest.frameCount,
    uncompressedBytes: manifest.uncompressedBytes,
    compressedBytes: pack.length,
    pack: {
      objectKey: `cold/v2/year=${year}/month=${value}/capture/${packName}`,
      bytes: pack.length,
      sha256,
    },
    createdAt: manifest.createdAt,
    verifierVersion: "capture-monthly-v2",
  })}\n`, { mode: 0o600 });
}

async function copyAllMonths(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  const source = new FilesystemArchiveRemote(fixture.cold, { createRoot: false, enforcePrivateObjects: true });
  const target = new FilesystemArchiveRemote(fixture.migrated, { createRoot: false, enforcePrivateObjects: true });
  for (const month of ["2026-01", "2026-02"]) {
    await copyRequestCaptureArchiveBundle({ source, target, month, stagingDirectory: fixture.staging });
  }
}

function fixtureConfig(hot: string, cold: string): AppConfig {
  return {
    archive: { directory: hot, coldDirectory: cold, requireColdMount: false },
    requestCapture: {
      hotDays: 90,
      archive: { enabled: true, autoPurge: false, purgeBatchSize: 10, zstdLevel: 6, frameUncompressedBytes: 2_500 },
      download: { maxFiles: 100, maxCompressedBytes: 10_000_000 },
    },
  } as unknown as AppConfig;
}

function requestLog(
  id: string,
  startedAt: string,
  status: "completed" | "failed",
  userId: string,
  teamId: string | null,
  apiKeyId: string,
  requestPath: string,
  reqModel: string,
): RequestLog {
  return {
    id,
    apiKeyId,
    userId,
    teamId,
    planId: null,
    planSubscriptionId: null,
    entryAccessPointId: null,
    billingScopeRef: null,
    providerId: null,
    requestPath,
    ingressHostname: null,
    ingressRouteId: null,
    reqModel,
    tarModel: null,
    ingressPluginsJson: "[]",
    pipelinePluginsJson: '{"schemaVersion":1,"planRevision":"test","invocations":[]}',
    status,
    errorCode: status === "failed" ? "provider_error" : null,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
  };
}

class TrackingArchiveRemote implements ArchiveRemote {
  readonly ranges: Array<{ key: string; offset: number; length: number }> = [];
  constructor(private readonly inner: ArchiveRemote) {}
  put(key: string, body: Uint8Array, sha256: string): Promise<void> { return this.inner.put(key, body, sha256); }
  putFile(key: string, path: string, bytes: number, sha256: string): Promise<void> { return this.inner.putFile(key, path, bytes, sha256); }
  head(key: string): Promise<ArchiveRemoteObject> { return this.inner.head(key); }
  read(key: string): Promise<Buffer> { return this.inner.read(key); }
  readRange(key: string, offset: number, length: number): Promise<Buffer> {
    this.ranges.push({ key, offset, length });
    return this.inner.readRange(key, offset, length);
  }
  openRead(key: string): Promise<NodeJS.ReadableStream> { return this.inner.openRead(key); }
  downloadToFile(key: string, path: string): Promise<void> { return this.inner.downloadToFile(key, path); }
}
