import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

interface FatalReportSettings {
  directory: string;
  filename: string;
  reportOnFatalError: boolean;
  reportOnSignal: boolean;
  reportOnUncaughtException: boolean;
  excludeEnv: boolean;
  excludeNetwork: boolean;
}

export async function configureGatewayFatalReports(
  databasePath: string,
  report: FatalReportSettings = process.report as unknown as FatalReportSettings
): Promise<string> {
  const directory = join(dirname(databasePath), "gateway-diagnostics");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  report.directory = directory;
  report.filename = "";
  report.excludeEnv = true;
  report.excludeNetwork = true;
  report.reportOnSignal = false;
  report.reportOnUncaughtException = false;
  report.reportOnFatalError = true;
  return directory;
}
