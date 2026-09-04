import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestLog } from "./contracts.js";
import {
  readRequestLogsParquet,
  REQUEST_LOG_ARCHIVE_SCHEMA_VERSION,
  type RequestLogArchiveManifestV1,
  writeRequestLogsParquet,
} from "./request-log-archive.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Request Log archive failure-reason compatibility", () => {
  it("writes schema 5 without changing archive format 2", async () => {
    const path = await archivePath();
    expect(REQUEST_LOG_ARCHIVE_SCHEMA_VERSION).toBe(5);
    await writeRequestLogsParquet(path, [requestLog()]);

    const rows = await readRequestLogsParquet(path, manifest(5));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ingressHostname: "relay.example.test",
      ingressRouteId: "edge:relay.hk-v1",
      credentialFailureReason: "auth_unauthorized",
    });
  });

  it("reads schema 4 as a null credential failure reason", async () => {
    const path = await archivePath();
    await writeRequestLogsParquet(path, [requestLog()], 2, 4);

    const rows = await readRequestLogsParquet(path, manifest(4));
    expect(rows[0]?.ingressRouteId).toBe("edge:relay.hk-v1");
    expect(rows[0]?.credentialFailureReason).toBeNull();
  });

  it("reads schema 3 as a null route snapshot", async () => {
    const path = await archivePath();
    await writeRequestLogsParquet(path, [requestLog()], 2, 3);

    const rows = await readRequestLogsParquet(path, manifest(3));
    expect(rows[0]?.ingressHostname).toBe("relay.example.test");
    expect(rows[0]?.ingressRouteId).toBeNull();
  });

  it("rejects a credential failure reason on a non-failed Request Log", async () => {
    const path = await archivePath();
    await expect(writeRequestLogsParquet(path, [{ ...requestLog(), status: "succeeded" }]))
      .rejects.toMatchObject({ code: "request_log_archive_value_invalid" });
  });

  it("rejects a schema 5 column set declared as schema 4", async () => {
    const path = await archivePath();
    await writeRequestLogsParquet(path, [requestLog()]);

    await expect(readRequestLogsParquet(path, manifest(4)))
      .rejects.toMatchObject({ code: "request_log_archive_schema_mismatch" });
  });
});

async function archivePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "friday-relay-request-log-archive-test-"));
  directories.push(directory);
  return join(directory, "request-logs.parquet");
}

function requestLog(): RequestLog {
  return {
    id: "req_archive_route_1",
    apiKeyId: "key_1",
    userId: "user_1",
    teamId: null,
    planId: "plan_1",
    planSubscriptionId: "subscription_1",
    entryAccessPointId: "ap_1",
    billingScopeRef: "user:user_1",
    providerId: "provider_1",
    requestPath: "/v1/responses",
    ingressHostname: "relay.example.test",
    ingressRouteId: "edge:relay.hk-v1",
    reqModel: "model-a",
    tarModel: "model-a",
    ingressPluginsJson: "[]",
    pipelinePluginsJson: '{"schemaVersion":1,"planRevision":"test","invocations":[]}',
    status: "failed",
    errorCode: "cliproxy_provider_credentials_unauthorized",
    credentialFailureReason: "auth_unauthorized",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:00:01.000Z",
  };
}

function manifest(schemaVersion: 3 | 4 | 5): RequestLogArchiveManifestV1 {
  return {
    manifestVersion: 1,
    archiveFormatVersion: 2,
    schemaVersion,
    kind: "request-logs",
    cutoffGte: "2026-08-01T00:00:00.000Z",
    cutoffLt: "2026-09-01T00:00:00.000Z",
    recordCount: 1,
    objectKey: "request-logs.parquet",
    compressedBytes: 0,
    uncompressedBytes: 0,
    sha256: "0".repeat(64),
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}
