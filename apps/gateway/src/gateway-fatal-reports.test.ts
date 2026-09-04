import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { configureGatewayFatalReports } from "./gateway-fatal-reports.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Gateway fatal diagnostic reports", () => {
  test("enables only fatal reports in a private directory without environment or network data", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-fatal-reports-"));
    directories.push(root);
    const report = {
      directory: "",
      filename: "sentinel.json",
      reportOnFatalError: false,
      reportOnSignal: true,
      reportOnUncaughtException: true,
      excludeEnv: false,
      excludeNetwork: false
    };

    const directory = await configureGatewayFatalReports(join(root, "friday-relay.db"), report);

    expect(directory).toBe(join(root, "gateway-diagnostics"));
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(report).toEqual({
      directory,
      filename: "",
      reportOnFatalError: true,
      reportOnSignal: false,
      reportOnUncaughtException: false,
      excludeEnv: true,
      excludeNetwork: true
    });
  });
});
