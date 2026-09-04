import { apiTestProtocol } from "./api-test-protocols";
import type { ApiTestType } from "./api-test-protocols";

export function curlCommand(type: ApiTestType, baseUrl: string, apiKey: string, payload: string) {
  const protocol = apiTestProtocol(type);
  const formatted = formatPayload(payload);
  const headers = [
    ["Content-Type", "application/json"] as const,
    ["Authorization", `Bearer ${escapeDoubleQuotedShell(apiKey.trim() || "<api-key>")}`] as const,
    ...protocol.curlHeaders
  ];
  return [
    `curl ${singleQuotedShell(`${baseUrl.trim().replace(/\/+$/, "")}${protocol.requestPath}`)} \\`,
    ...headers.map(([name, value]) => `  -H "${name}: ${value}" \\`),
    `  -d ${singleQuotedShell(formatted)}`
  ].join("\n");
}

function formatPayload(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function singleQuotedShell(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeDoubleQuotedShell(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`");
}
