import { writeFile } from "node:fs/promises";
import { FilesystemArchiveRemote } from "./archive-remote.js";
import type { RequestCaptureArchiveCatalogFilter, RequestCaptureArchiveQueryScope } from "./request-capture-archive-catalog.js";
import {
  copyRequestCaptureArchiveBundle,
  queryRequestCaptureMonthlyArchivesWithFallback,
  readRequestCaptureArchiveRecordByRequestId,
  readRequestCaptureArchiveManifest,
  verifyRequestCaptureMonthlyArchive,
} from "./request-capture-monthly-archive.js";

export async function runRequestCaptureArchiveOfflineCli(
  argv: readonly string[],
  options: { defaultRoot?: string } = {},
): Promise<void> {
  const parsed = new OfflineCliArguments(argv);
  const action = parsed.positional(0);
  const month = parsed.requiredOption("--month");
  if (action === "copy") {
    const source = new FilesystemArchiveRemote(parsed.requiredOption("--source-root"), {
      createRoot: false,
      enforcePrivateObjects: true,
    });
    const target = new FilesystemArchiveRemote(parsed.requiredOption("--target-root"), {
      createRoot: false,
      enforcePrivateObjects: true,
    });
    const verified = await copyRequestCaptureArchiveBundle({
      source,
      target,
      month,
      stagingDirectory: parsed.requiredOption("--staging-directory"),
    });
    console.log(JSON.stringify({ archiveMonth: month, copied: true, verifiedRecords: verified.verifiedRecords }));
    return;
  }

  const root = parsed.option("--root") ?? options.defaultRoot;
  if (!root) throw cliError("request_capture_archive_root_required", "Offline Capture archive access requires --root");
  const remote = new FilesystemArchiveRemote(root, { createRoot: false, enforcePrivateObjects: true });
  if (action === "verify") {
    const manifest = await readRequestCaptureArchiveManifest(remote, month);
    const verified = await verifyRequestCaptureMonthlyArchive({ remote, manifest });
    console.log(JSON.stringify({
      archiveMonth: month,
      recordCount: verified.verifiedRecords,
      frameCount: verified.verifiedFrames,
      verified: true,
    }));
    return;
  }

  const scope = offlineCaptureScope(parsed);
  const filter = offlineCaptureFilter(parsed);
  const rows = await queryRequestCaptureMonthlyArchivesWithFallback(remote, {
    months: parsed.options("--month"),
    filter,
    scope,
  });
  if (action === "query") {
    console.log(JSON.stringify({ rows }));
    return;
  }
  if (action === "read") {
    const requestId = parsed.requiredOption("--request-id");
    const matched = rows.find((row) => row.requestId === requestId);
    if (!matched) throw cliError("request_capture_not_found", "Request Capture was not found in the selected archive months");
    const raw = await readRequestCaptureArchiveRecordByRequestId({
      remote,
      month: matched.archiveMonth,
      requestId,
    });
    if (!raw) throw cliError("request_capture_not_found", "Request Capture was not found in the selected archive months");
    const output = parsed.requiredOption("--output");
    await writeFile(output, raw, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ requestId, output, bytes: raw.length }));
    return;
  }
  throw cliError(
    "request_capture_archive_command_invalid",
    "Offline Capture archive action must be verify, query, read, or copy",
  );
}

function offlineCaptureScope(parsed: OfflineCliArguments): RequestCaptureArchiveQueryScope {
  if (!parsed.flag("--offline-authorized")) {
    throw cliError(
      "request_capture_archive_offline_authorization_required",
      "Offline Capture archive access requires --offline-authorized and an explicit --scope",
    );
  }
  const value = parsed.requiredOption("--scope");
  if (value === "platform_owner") return { kind: "platform_owner" };
  if (value.startsWith("user:")) return { kind: "user", userId: requiredScopeValue(value, "user:") };
  if (value.startsWith("request:")) return { kind: "request", requestId: requiredScopeValue(value, "request:") };
  throw cliError(
    "request_capture_archive_scope_invalid",
    "Offline Capture scope must be platform_owner, user:<id>, or request:<id>",
  );
}

function offlineCaptureFilter(parsed: OfflineCliArguments): RequestCaptureArchiveCatalogFilter {
  const status = parsed.option("--status");
  if (status !== undefined && status !== "completed" && status !== "failed") {
    throw cliError("request_capture_archive_query_status_invalid", "--status must be completed or failed");
  }
  const result: RequestCaptureArchiveCatalogFilter = {};
  const assign = (name: string, key: keyof RequestCaptureArchiveCatalogFilter): void => {
    const value = parsed.option(name);
    if (value !== undefined) Object.assign(result, { [key]: value });
  };
  if (status) result.status = status;
  assign("--request-id", "requestId");
  assign("--user-id", "userId");
  assign("--team-id", "teamId");
  assign("--api-key-id", "apiKeyId");
  assign("--request-path", "requestPath");
  assign("--request-model", "requestModel");
  assign("--started-at-gte", "startedAtGte");
  assign("--started-at-lt", "startedAtLt");
  assign("--ended-at-gte", "endedAtGte");
  assign("--ended-at-lt", "endedAtLt");
  return result;
}

class OfflineCliArguments {
  constructor(private readonly argv: readonly string[]) {}

  positional(index: number): string | undefined {
    return this.argv.filter((value, valueIndex) => valueIndex === 0 || !this.argv[valueIndex - 1]?.startsWith("--"))[index];
  }

  flag(name: string): boolean {
    return this.argv.includes(name);
  }

  option(name: string): string | undefined {
    const index = this.argv.indexOf(name);
    if (index === -1) return undefined;
    const value = this.argv[index + 1];
    if (!value || value.startsWith("--")) throw cliError("cli_option_value_required", `${name} requires a value`);
    return value;
  }

  options(name: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < this.argv.length; index += 1) {
      if (this.argv[index] !== name) continue;
      const value = this.argv[index + 1];
      if (!value || value.startsWith("--")) throw cliError("cli_option_value_required", `${name} requires a value`);
      values.push(value);
    }
    return values;
  }

  requiredOption(name: string): string {
    const value = this.option(name);
    if (!value) throw cliError("cli_option_value_required", `${name} requires a value`);
    return value;
  }
}

function requiredScopeValue(value: string, prefix: string): string {
  const result = value.slice(prefix.length);
  if (!result) throw cliError("request_capture_archive_scope_invalid", "Offline Capture scope value is required");
  return result;
}

function cliError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
