export interface PolicyFormValues { metric: string; limitValue: string; windowType: string; windowSeconds: string; status: string; }
export interface DirectAssignmentFormValues { keyId: string; budgetPolicyId: string; }
export interface GovernanceAssignmentFormValues { scopeRef: string; governanceBudgetPolicyId: string; }
export const defaultPolicyFormValues = (): PolicyFormValues => ({ metric: "amount", limitValue: "", windowType: "rolling", windowSeconds: "14400", status: "enabled" });
export function defaultDirectAssignmentFormValues(keyId = "", budgetPolicyId = ""): DirectAssignmentFormValues { return { keyId, budgetPolicyId }; }
export function defaultGovernanceAssignmentFormValues(scopeRef: string, governanceBudgetPolicyId = ""): GovernanceAssignmentFormValues { return { scopeRef, governanceBudgetPolicyId }; }
export function validateLimitValue(value: string) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? undefined : "Limit value must be a non-negative number."; }
export function validateWindowSeconds(value: string, windowType: string) { if (windowType !== "rolling") return undefined; const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? undefined : "Rolling windows require positive window seconds."; }
export function validateRequired(value: string, label: string) { return value.trim() ? undefined : `${label} is required.`; }
export function toPolicyInput(value: PolicyFormValues) { return { metric: value.metric, limitValue: Number(value.limitValue), windowType: value.windowType, windowSeconds: value.windowType === "rolling" ? Number(value.windowSeconds) : null, status: value.status }; }
export function toDirectAssignmentInput(value: DirectAssignmentFormValues) { return { scopeRef: `key:${value.keyId}`, budgetPolicyId: value.budgetPolicyId }; }
