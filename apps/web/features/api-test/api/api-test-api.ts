import type { ApiTestResult, UserApiTestCommand, UserApiTestExecution } from "../types";
import { formatJson } from "../form/api-test-values";
export async function executeUserApiTest({ payload, signal }: UserApiTestCommand): Promise<UserApiTestExecution> {
  const response = await fetch("/api/user/api-test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload }), signal });
  const body = await response.json().catch(() => ({})) as unknown;
  return { result: response.ok ? body as ApiTestResult : null, rawResponse: formatJson(body), errorMessage: response.ok ? null : messageFromApiError(body) };
}
function messageFromApiError(body: unknown) { if (body && typeof body === "object" && "error" in body) { const error = (body as { error?: { message?: unknown } }).error; if (typeof error?.message === "string") return error.message; } return "API test failed"; }
