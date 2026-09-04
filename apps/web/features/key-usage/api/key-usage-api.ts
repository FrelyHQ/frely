export interface BudgetOrigin { scopeType: "global" | "team" | "user" | "key"; scopeLabel: string; planName: string | null; planVersion: number | null; limitScope: "subscription" | "user" | "key"; applicableModels: string[]; subscriptionEffectiveStart: string | null; subscriptionEffectiveEnd: string | null }
export interface BudgetRecovery { nextRecoveryAt: string | null; nextRecoveryValue: number | null; fullRecoveryAt: string | null }
export interface BudgetLimit { source: "plan" | "key"; metric: "tokens" | "amount"; limitValue: number; usedValue: number; remainingValue: number; percentUsed: number; windowType: "rolling" | "fixed" | "cumulative"; windowSeconds: number | null; periodStart: string; periodEnd: string; nextResetAt?: string | null; exhausted: boolean; recovery?: BudgetRecovery; origin: BudgetOrigin }
export interface BudgetSource { source: "plan" | "key"; limitCount: number; origin: BudgetOrigin }
export interface BudgetResult { usage: { totalTokens: number; calculatedCost: number }; limits: BudgetLimit[]; sources: BudgetSource[]; apiKey: { prefix: string; status: string; expiresAt: string | null } }

export async function lookupKeyUsage(apiKey: string): Promise<BudgetResult> {
  const response = await fetch("/api/key/budget", { headers: { authorization: `Bearer ${apiKey.trim()}` } });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) throw new Error(response.status === 401 ? "API key is invalid or unavailable" : apiErrorMessage(body));
  return body as BudgetResult;
}
function apiErrorMessage(body: unknown) { if (body && typeof body === "object" && "error" in body) { const error = (body as { error?: { message?: unknown } }).error; if (typeof error?.message === "string") return error.message; } return "Usage lookup failed"; }
