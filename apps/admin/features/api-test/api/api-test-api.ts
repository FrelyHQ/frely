import { readConsoleApiResponse } from "@frely/console-ui/api-error";
import type { ApiTestCurlRequest, ApiTestError, ApiTestRequest, ApiTestResult } from "../types";

export async function fetchApiTestInputs(signal?: AbortSignal) {
  return {};
}

export async function executeApiTest(input: ApiTestRequest): Promise<ApiTestResult> {
  const startedAt = Date.now();
  const response = await fetch("/api/owner/api-test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json() as unknown;
  if (!response.ok) return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, requestId: response.headers.get("x-request-id"), error: errorFromBody(body, response.status), body };
  return body as ApiTestResult;
}

export async function fetchSavedApiTestCurl(input: ApiTestCurlRequest): Promise<string> {
  const response = await fetch("/api/owner/api-test/curl", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(input)
  });
  const result = await readConsoleApiResponse<{ command?: string }>(response, "Copy curl command failed");
  if (!result.command) throw new Error("Copy curl command returned no command");
  return result.command;
}

export function errorFromBody(body: unknown, status: number): ApiTestError {
  const fallbackCategory = status >= 500 ? "provider" : "request";
  if (!body || typeof body !== "object") return { code: undefined, message: undefined, category: fallbackCategory };
  const record = body as Record<string, unknown>;
  const value = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? record.error as Record<string, unknown> : record;
  const code = typeof value.code === "string" ? value.code : undefined;
  const message = typeof value.message === "string" ? value.message : undefined;
  const category = typeof value.category === "string" ? value.category : errorCategory(code, status);
  return { code, message, category };
}

function errorCategory(code: string | undefined, status: number) {
  if (code === "insufficient_credit_balance") return "credit_balance";
  if (code === "plan_subscription_unavailable") return "plan_budget";
  if (code === "plan_subscription_required") return "plan_required";
  if (code === "plan_entitlement_required") return "plan_entitlement";
  if (code?.includes("budget")) return "budget";
  if (code?.includes("rate_limit")) return "rate_limit";
  if (code?.startsWith("provider_") || status >= 500) return "provider";
  if (code?.includes("access_point")) return "access_point";
  return "request";
}
