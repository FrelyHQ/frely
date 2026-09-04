import { BudgetPoliciesView } from "../../../../features/budgets";
import type { AdminPageData } from "./page.server";

export default function BudgetPoliciesPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { state, policies, assignments } = loaded;
  return <BudgetPoliciesView
    state={{
      ...state,
      policyPage: policies.page,
      assignmentPage: assignments.page,
    }}
    policies={policies}
    directAssignments={{
      ...assignments,
      items: assignments.items.map((assignment) => ({
        id: assignment.id,
        scopeRef: assignment.scopeRef,
        budgetPolicyId: assignment.budgetPolicyId,
        status: assignment.status,
        createdAt: assignment.createdAt,
        updatedAt: assignment.updatedAt,
        budgetPolicy: assignment.policy,
        apiKey: assignment.apiKeyId ? {
          id: assignment.apiKeyId,
          name: assignment.apiKeyName ?? assignment.apiKeyId,
          keyPrefix: assignment.apiKeyPrefix ?? assignment.apiKeyId,
          userId: assignment.userId ?? "",
          status: assignment.status,
        } : null,
      })),
    }}
  />;
}
