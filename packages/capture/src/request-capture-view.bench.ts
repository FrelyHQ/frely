import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { requestCaptureViewResponse } from "./request-capture-reader.js";
import { RequestCaptureV3Storage } from "./request-capture-v3.js";

const directory = mkdtempSync(join(tmpdir(), "friday-relay-capture-view-bench-"));
const storage = new RequestCaptureV3Storage({ archiveDirectory: directory });
const capturedAt = "2026-07-16T00:00:00.000Z";

try {
  for (const inputMiB of [1, 8, 32]) {
    const requestId = `req_capture_view_bench_${inputMiB}`;
    const inputBytes = inputMiB * 1024 * 1024;
    const content = randomBytes(Math.ceil(inputBytes * 0.75)).toString("base64").slice(0, inputBytes);
    storage.writeExchange({
      requestLogStartedAt: capturedAt,
      requestId,
      apiKeyId: "key_bench",
      userId: "user_bench",
      teamId: null,
      kind: "responses",
      reqModel: "model_bench",
      originalPayload: { model: "model_bench", input: [{ role: "user", content }] },
      effectivePayload: { model: "model_bench", input: [{ role: "user", content }] },
      response: { status: 200, body: { ok: true }, capturedAt }
    });

    const path = storage.pathForRequest(capturedAt, requestId);
    const started = performance.now();
    const exchange = await storage.readExchangeAsync(capturedAt, requestId);
    const durationMs = performance.now() - started;
    if (!exchange) throw new Error("benchmark Capture is missing");
    const view = requestCaptureViewResponse(exchange, "original");
    console.log(JSON.stringify({
      inputMiB,
      compressedBytes: statSync(path).size,
      viewJsonBytes: Buffer.byteLength(JSON.stringify(view), "utf8"),
      readDecompressVerifyProjectMs: Number(durationMs.toFixed(3))
    }));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
