import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { archiveReadRemoteFromConfig, FilesystemArchiveRemote } from "./archive-remote.js";

afterEach(() => vi.restoreAllMocks());

describe("archive read remote", () => {
  test("prefers cold objects, falls back only for legacy missing objects, and fails closed when the mount disappears", async () => {
    const root = mkdtempSync(join(tmpdir(), "archive-read-remote-"));
    const hotRoot = join(root, "hot");
    const coldRoot = join(root, "cold");
    mkdirSync(hotRoot, { recursive: true, mode: 0o700 });
    mkdirSync(coldRoot, { recursive: true, mode: 0o700 });
    const hot = new FilesystemArchiveRemote(hotRoot);
    const cold = new FilesystemArchiveRemote(coldRoot, { createRoot: false, enforcePrivateObjects: true });
    await hot.put("legacy/object", Buffer.from("legacy"), digest("legacy"));
    await hot.put("shared/object", Buffer.from("hot"), digest("hot"));
    await cold.put("shared/object", Buffer.from("cold"), digest("cold"));

    const reader = archiveReadRemoteFromConfig(hotRoot, coldRoot);
    await expect(reader.read("legacy/object")).resolves.toEqual(Buffer.from("legacy"));
    await expect(reader.read("shared/object")).resolves.toEqual(Buffer.from("cold"));

    rmSync(coldRoot, { recursive: true, force: true });
    await expect(reader.read("legacy/object")).rejects.toMatchObject({ code: "archive_cold_mount_missing" });
  });

  test("falls back to exclusive copy when FUSE reports hard links as unimplemented", async () => {
    const root = mkdtempSync(join(tmpdir(), "archive-put-enosys-"));
    const coldRoot = join(root, "cold");
    mkdirSync(coldRoot, { recursive: true, mode: 0o700 });
    const remote = new FilesystemArchiveRemote(coldRoot, { createRoot: false, enforcePrivateObjects: true });
    const body = Buffer.from("manifest-commit");
    const link = vi.spyOn(fsPromises, "link").mockRejectedValueOnce(Object.assign(new Error("function not implemented"), { code: "ENOSYS" }));

    await remote.put("cold/v3/year=2026/month=07/capture/captures-manifest-v3.json", body, digest(body));

    expect(link).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(coldRoot, "cold/v3/year=2026/month=07/capture/captures-manifest-v3.json"))).toEqual(body);
    rmSync(root, { recursive: true, force: true });
  });

  test("reopens and retries an exact range after a transient filesystem read failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "archive-range-retry-"));
    const coldRoot = join(root, "cold");
    mkdirSync(coldRoot, { recursive: true, mode: 0o700 });
    const remote = new FilesystemArchiveRemote(coldRoot, { createRoot: false, enforcePrivateObjects: true });
    const key = "cold/v3/year=2026/month=07/capture/pack";
    const body = Buffer.from("transient-fuse-range-read");
    await remote.put(key, body, digest(body));
    const open = vi.spyOn(fsPromises, "open").mockRejectedValueOnce(Object.assign(new Error("transient input/output error"), { code: "EIO" }));

    await expect(remote.readRange(key, 10, 10)).resolves.toEqual(body.subarray(10, 20));
    expect(open).toHaveBeenCalledTimes(2);

    rmSync(root, { recursive: true, force: true });
  });

  test("returns a stable failure after transient range-read retries are exhausted", async () => {
    const root = mkdtempSync(join(tmpdir(), "archive-range-retry-exhausted-"));
    const coldRoot = join(root, "cold");
    mkdirSync(coldRoot, { recursive: true, mode: 0o700 });
    const remote = new FilesystemArchiveRemote(coldRoot, { createRoot: false, enforcePrivateObjects: true });
    const key = "cold/v3/year=2026/month=07/capture/pack";
    const body = Buffer.from("persistent-fuse-range-failure");
    await remote.put(key, body, digest(body));
    const open = vi.spyOn(fsPromises, "open").mockRejectedValue(Object.assign(new Error("persistent input/output error"), { code: "EIO" }));

    await expect(remote.readRange(key, 0, body.length)).rejects.toMatchObject({ code: "archive_remote_read_failed" });
    expect(open).toHaveBeenCalledTimes(4);

    rmSync(root, { recursive: true, force: true });
  });

  test("DEF-20260901 promotes one staged object without copy amplification and preserves immutable conflicts", async () => {
    const root = mkdtempSync(join(tmpdir(), "archive-promote-remote-"));
    const coldRoot = join(root, "cold");
    const staging = join(coldRoot, ".staging", "run");
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const remote = new FilesystemArchiveRemote(coldRoot, { createRoot: false, enforcePrivateObjects: true });
    const key = "cold/v3/year=2026/month=07/capture/pack";
    const body = Buffer.from("one-pass-archive");
    const source = join(staging, "pack");
    writeFileSync(source, body, { mode: 0o600 });

    await remote.promoteStagedFile(key, source, body.length, digest(body));

    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(coldRoot, key))).toEqual(body);

    const duplicate = join(staging, "duplicate");
    writeFileSync(duplicate, body, { mode: 0o600 });
    await remote.promoteStagedFile(key, duplicate, body.length, digest(body));
    expect(existsSync(duplicate)).toBe(false);

    const conflicting = join(staging, "conflicting");
    const other = Buffer.from("different-archive");
    writeFileSync(conflicting, other, { mode: 0o600 });
    await expect(remote.promoteStagedFile(key, conflicting, other.length, digest(other)))
      .rejects.toMatchObject({ code: "archive_object_conflict" });
    expect(readFileSync(join(coldRoot, key))).toEqual(body);
    expect(readFileSync(conflicting)).toEqual(other);

    rmSync(root, { recursive: true, force: true });
  });
});

function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
