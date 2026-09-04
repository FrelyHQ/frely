import { errorFromBody } from "../api/api-test-api";
import type { ApiTestError, ApiTestResult } from "../types";

export { curlCommand } from "./curl-command";

export function responseErrorFields(result: ApiTestResult): ApiTestError { return result.error ?? errorFromBody(result.body, result.status); }
export function responseErrorExplanation(result: ApiTestResult) {
  const fields = responseErrorFields(result); const code = fields.code;
  if (code === "insufficient_credit_balance") return "Credit balance is insufficient. The selected PayGo funding account does not have enough balance for the estimated request cost.";
  if (code === "plan_subscription_unavailable") return "Team/User plan budget is unavailable or exhausted. The active plan exists, but no candidate subscription has remaining budget for this request.";
  if (code === "plan_subscription_required") return "No active plan subscription is available for this API key's team/user/global scope.";
  if (code === "plan_entitlement_required") return "The active plan does not include this AccessPoint, so this model is not entitled for the selected API key.";
  if (code === "budget_token_limit_exceeded") return "A direct token budget assigned to this API key would be exceeded by this request.";
  if (code === "budget_amount_limit_exceeded") return "A direct amount budget assigned to this API key would be exceeded by this request.";
  if (code === "governance_budget_token_limit_exceeded") return "A governance token hard stop on global/team/user scope would be exceeded by this request.";
  if (code === "governance_budget_amount_limit_exceeded") return "A governance amount hard stop on global/team/user scope would be exceeded by this request.";
  if (code === "provider_fetch_failed") return `Provider network request failed. ${fields.message || "Check provider connectivity, proxy configuration, or upstream availability."}`;
  if (code === "provider_error") return `Provider returned an error. ${fields.message || "Check the upstream response and provider status."}`;
  if (fields.category === "provider") return `Provider/upstream failure. ${fields.message || "Check provider status and credentials."}`;
  return fields.message || `Request failed with HTTP ${result.status}.`;
}
