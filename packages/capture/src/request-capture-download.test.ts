import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { prepareRequestCaptureDownload, requestCaptureFileStream, requestCaptureTarStream } from "./request-capture-download.js";
import { RequestCaptureV3Storage } from "./request-capture-v3.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// REQ-MEMBER-009: authorized Request Logs map to byte-identical Capture v3
// downloads without decompression, projection, merging, or recompression.
describe("Request Capture v3 direct download", () => {
  test("streams a single source file byte-for-byte", async () => {
    const { storage, logs } = fixture(["req_first"]);
    const prepared = await prepareRequestCaptureDownload(storage, logs, { maxFiles: 10, maxCompressedBytes: 10_000_000 });
    const expected = readFileSync(prepared.files[0]!.path);
    const onComplete = vi.fn();

    const actual = Buffer.from(await new Response(requestCaptureFileStream(prepared.files[0]!, { onComplete })).arrayBuffer());

    expect(actual).toEqual(expected);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  test("awaits the terminal hook before completing the download stream", async () => {
    const { storage, logs } = fixture(["req_first"]);
    const prepared = await prepareRequestCaptureDownload(storage, logs, { maxFiles: 10, maxCompressedBytes: 10_000_000 });
    let releaseHook!: () => void;
    let markHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => { markHookStarted = resolve; });
    const hookRelease = new Promise<void>((resolve) => { releaseHook = resolve; });
    const response = new Response(requestCaptureFileStream(prepared.files[0]!, {
      async onComplete() { markHookStarted(); await hookRelease; }
    })).arrayBuffer();
    let responseCompleted = false;
    void response.then(() => { responseCompleted = true; });

    await hookStarted;
    await Promise.resolve();
    expect(responseCompleted).toBe(false);
    releaseHook();
    await response;
    expect(responseCompleted).toBe(true);
  });

  test("does not emit a second failure hook when terminal Audit fails", async () => {
    const { storage, logs } = fixture(["req_first"]);
    const prepared = await prepareRequestCaptureDownload(storage, logs, { maxFiles: 10, maxCompressedBytes: 10_000_000 });
    const onError = vi.fn();

    await expect(new Response(requestCaptureFileStream(prepared.files[0]!, {
      async onComplete() { throw new Error("audit unavailable"); },
      onError,
    })).arrayBuffer()).rejects.toThrowError("audit unavailable");
    expect(onError).not.toHaveBeenCalled();
  });

  test("writes source files to a valid tar in Request Log order and skips missing files", async () => {
    const { storage, logs } = fixture(["req_second", "req_first"]);
    logs.splice(1, 0, { id: "req_missing", startedAt: "2026-07-14T00:01:00.000Z" });
    const prepared = await prepareRequestCaptureDownload(storage, logs, { maxFiles: 10, maxCompressedBytes: 10_000_000 });

    const tar = Buffer.from(await new Response(requestCaptureTarStream(prepared.files)).arrayBuffer());
    const entries = parseTar(tar);

    expect(prepared).toMatchObject({ candidateCount: 3, missingCount: 1 });
    expect(entries.map((entry) => entry.name)).toEqual(["req_second.jsonl.zst", "req_first.jsonl.zst"]);
    expect(entries.map((entry) => entry.body)).toEqual(prepared.files.map((file) => readFileSync(file.path)));
    expect(tar.subarray(-1024)).toEqual(Buffer.alloc(1024));
  });

  test("supports long request ids through a logical PAX path", async () => {
    const requestId = `req_${"a".repeat(150)}`;
    const { storage, logs } = fixture([requestId]);
    const prepared = await prepareRequestCaptureDownload(storage, logs, { maxFiles: 10, maxCompressedBytes: 10_000_000 });

    const entries = parseTar(Buffer.from(await new Response(requestCaptureTarStream(prepared.files)).arrayBuffer()));

    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe(`${requestId}.jsonl.zst`);
    expect(entries[0]!.body).toEqual(readFileSync(prepared.files[0]!.path));
  });

  test("rejects candidate, byte, permission, and traversal violations before streaming", async () => {
    const { storage, logs } = fixture(["req_first", "req_second"]);
    await expect(prepareRequestCaptureDownload(storage, logs, { maxFiles: 1, maxCompressedBytes: 10_000_000 })).rejects.toMatchObject({ code: "request_capture_download_too_large", status: 413 });
    await expect(prepareRequestCaptureDownload(storage, logs, { maxFiles: 10, maxCompressedBytes: 1 })).rejects.toMatchObject({ code: "request_capture_download_too_large", status: 413 });

    const path = storage.pathForRequest(logs[0]!.startedAt, logs[0]!.id);
    chmodSync(path, 0o644);
    await expect(prepareRequestCaptureDownload(storage, [logs[0]!], { maxFiles: 10, maxCompressedBytes: 10_000_000 })).rejects.toMatchObject({ code: "request_capture_file_permissions_invalid", status: 503 });
    expect(() => storage.pathForRequest(logs[0]!.startedAt, "../escape")).toThrow(/request id is invalid/i);
  });

  test("reports stream cancellation without completing", async () => {
    const { storage, logs } = fixture(["req_first"]);
    const prepared = await prepareRequestCaptureDownload(storage, logs, { maxFiles: 10, maxCompressedBytes: 10_000_000 });
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    const stream = requestCaptureTarStream(prepared.files, { onComplete, onCancel });
    const reader = stream.getReader();

    await reader.read();
    await reader.cancel();

    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
    expect(onComplete).not.toHaveBeenCalled();
  });

  test("settles source file ownership before concurrent cancellations return", async () => {
    const { storage, logs } = fixture(["req_first"]);
    const prepared = await prepareRequestCaptureDownload(storage, logs, { maxFiles: 10, maxCompressedBytes: 10_000_000 });
    const readers = Array.from({ length: 64 }, () => requestCaptureTarStream(prepared.files).getReader());

    await Promise.all(readers.map(async (reader) => {
      await reader.read();
      await reader.cancel();
    }));
  });
});

function fixture(requestIds: string[]) {
  const root = mkdtempSync(join(tmpdir(), "friday-relay-capture-download-"));
  roots.push(root);
  const storage = new RequestCaptureV3Storage({ archiveDirectory: root });
  const logs = requestIds.map((id, index) => {
    const startedAt = `2026-07-14T00:0${index}:00.000Z`;
    storage.writeExchange({
      requestLogStartedAt: startedAt,
      requestId: id,
      apiKeyId: "key_owner",
      userId: "user_owner",
      teamId: "team_owner",
      kind: "responses",
      reqModel: "model-test",
      originalPayload: { input: id, ownershipLikeContent: "preserved" },
      effectivePayload: { input: id, internalPatchContent: true },
      response: { status: 200, body: { output: id } }
    });
    return { id, startedAt };
  });
  return { storage, logs };
}

function parseTar(tar: Buffer): Array<{ name: string; body: Buffer }> {
  const entries: Array<{ name: string; body: Buffer }> = [];
  let offset = 0;
  let paxPath = "";
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = cString(header.subarray(0, 100));
    const size = Number.parseInt(cString(header.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === "x") {
      const match = body.toString("utf8").match(/\d+ path=(.*)\n$/s);
      paxPath = match?.[1] ?? "";
    } else {
      entries.push({ name: paxPath || name, body: Buffer.from(body) });
      paxPath = "";
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function cString(bytes: Buffer): string {
  const zero = bytes.indexOf(0);
  return bytes.subarray(0, zero === -1 ? bytes.length : zero).toString("utf8");
}
