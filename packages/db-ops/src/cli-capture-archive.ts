import { runRequestCaptureArchiveOfflineCli } from "@frely/capture";

try {
  await runRequestCaptureArchiveOfflineCli(process.argv.slice(2));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "request_capture_archive_failed";
  console.error(`requestCaptureArchive.failureCode=${code}`);
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
}
