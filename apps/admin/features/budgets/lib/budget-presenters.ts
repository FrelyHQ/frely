import type { BudgetPolicy, DisplayPolicy, GovernanceBudgetPolicy, Tone } from "../types";

export function toDisplayPolicy(policy: BudgetPolicy): DisplayPolicy {
  return { id: policy.id, name: policy.id, metric: titleCase(policy.metric), window: policy.windowType === "rolling" ? formatDuration(policy.windowSeconds ?? 0) : "Plan cumulative", hardStopCap: policyLimitLabel(policy), status: policy.status === "enabled" ? "Enabled" : "Disabled", statusTone: enabledTone(policy.status) };
}
export function policyLabel(policy: Pick<BudgetPolicy, "id" | "metric" | "limitValue" | "windowType" | "windowSeconds" | "status">) { const value = toDisplayPolicy({ ...policy, createdAt: "", updatedAt: "" }); return `${value.metric} - ${value.hardStopCap} - ${value.window}`; }
export function governancePolicyLabel(policy: GovernanceBudgetPolicy) { return `${titleCase(policy.metric)} - ${policyLimitLabel(policy)} - ${governancePolicyWindowLabel(policy)}`; }
export function policyLimitLabel(policy: BudgetPolicy) { return policy.metric === "amount" ? formatCurrency(policy.limitValue) : `${policy.limitValue.toLocaleString("en-US")} tokens`; }
export function governancePolicyWindowLabel(policy: GovernanceBudgetPolicy) { return policy.windowType === "rolling" ? formatDuration(policy.windowSeconds ?? 0) : "Cumulative from assignment"; }
export function enabledTone(status: string): Tone { return status === "enabled" ? "good" : "neutral"; }
export function titleCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase(); }
export function formatCurrency(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value); }
export function formatDuration(seconds: number) { if (seconds % 86400 === 0) return `${seconds / 86400} days rolling`; if (seconds % 3600 === 0) return `${seconds / 3600} hours rolling`; return `${seconds}s rolling`; }
