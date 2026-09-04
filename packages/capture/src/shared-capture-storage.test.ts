import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertSharedCaptureStorageProbeAbsent,
  inspectSharedCaptureStorage,
  publishSharedCaptureStorageProbe,
  readSharedCaptureStorageProbe,
  removeSharedCaptureStorageProbe,
  SHARED_CAPTURE_STORAGE_SCHEMA,
} from "./shared-capture-storage.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared Capture storage admission", () => {
  test("verifies identity, conditional idempotent publish, digest visibility, and cleanup", () => {
    const fixture = createFixture("capture_store_primary");
    const first = publishSharedCaptureStorageProbe({
      ...fixture.input,
      probeId: "probe_llm",
      writerId: "llm",
    });
    expect(first).toMatchObject({ storageId: "capture_store_primary", mountVerified: true, published: true, idempotent: false });

    const repeated = publishSharedCaptureStorageProbe({
      ...fixture.input,
      probeId: "probe_llm",
      writerId: "llm",
    });
    expect(repeated).toMatchObject({ probeDigest: first.probeDigest, published: false, idempotent: true });

    expect(readSharedCaptureStorageProbe({
      ...fixture.input,
      probeId: "probe_llm",
      expectedDigest: first.probeDigest,
      expectedWriterId: "llm",
    })).toMatchObject({ probeDigest: first.probeDigest, writerId: "llm" });
    expect(() => publishSharedCaptureStorageProbe({
      ...fixture.input,
      probeId: "probe_llm",
      writerId: "review-dev",
    })).toThrow(/shared_capture_storage_probe_digest_mismatch/u);

    expect(removeSharedCaptureStorageProbe({
      ...fixture.input,
      probeId: "probe_llm",
      expectedDigest: first.probeDigest,
    }).removed).toBe(true);
    expect(assertSharedCaptureStorageProbeAbsent({ ...fixture.input, probeId: "probe_llm" }).absent).toBe(true);
  });

  test("fails closed on storage identity, marker permissions, and mount drift", () => {
    const fixture = createFixture("capture_store_primary");
    expect(() => inspectSharedCaptureStorage({ ...fixture.input, expectedStorageId: "other_store" })).toThrow(/identity_mismatch/u);
    expect(() => inspectSharedCaptureStorage({ ...fixture.input, mountInfo: "" })).toThrow(/mount_unverified/u);
    chmodSync(fixture.markerPath, 0o644);
    expect(() => inspectSharedCaptureStorage(fixture.input)).toThrow(/marker_invalid/u);
  });
});

function createFixture(storageId: string) {
  const root = mkdtempSync(join(tmpdir(), "shared-capture-storage-"));
  roots.push(root);
  const archiveDirectory = join(root, "archives");
  const captureRoot = join(archiveDirectory, "capture-v3");
  mkdirSync(captureRoot, { recursive: true, mode: 0o700 });
  chmodSync(captureRoot, 0o700);
  const markerPath = join(captureRoot, ".shared-storage.json");
  writeFileSync(markerPath, `${JSON.stringify({ schema: SHARED_CAPTURE_STORAGE_SCHEMA, storageId })}\n`, { mode: 0o600 });
  chmodSync(markerPath, 0o600);
  const mountInfo = `1 2 0:1 / ${captureRoot} rw - tmpfs tmpfs rw\n`;
  return {
    markerPath,
    input: { archiveDirectory, expectedStorageId: storageId, mountInfo },
  };
}
