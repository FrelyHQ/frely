export type Tone = "good" | "warn" | "bad" | "neutral" | "info";

export interface BudgetPolicy {
  id: string; metric: string; limitValue: number; windowType: string; windowSeconds: number | null; status: string; createdAt: string; updatedAt: string;
}
export type BudgetPolicyCandidate = Pick<BudgetPolicy, "id" | "metric" | "limitValue" | "windowType" | "windowSeconds" | "status">;
export interface DisplayPolicy { id: string; name: string; metric: string; window: string; hardStopCap: string; status: string; statusTone: Tone; }
export interface ApiKeySummary { id: string; name: string; keyPrefix: string; userId: string; status: string; }
export interface DirectAssignment { id: string; scopeRef: string; budgetPolicyId: string; status: string; createdAt: string; updatedAt: string; budgetPolicy: BudgetPolicy; apiKey: ApiKeySummary | null; }
export interface DirectoryPage<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number; }
export interface GovernanceBudgetPolicy extends BudgetPolicy {}
export interface GovernanceBudgetAssignment { id: string; scopeRef: string; governanceBudgetPolicyId: string; status: string; createdAt: string; updatedAt: string; governanceBudgetPolicy: GovernanceBudgetPolicy; }
