import { adminPageServices } from "../../../../lib/server";
import { BudgetPoliciesView } from "../../../../features/budgets";
import { parseBudgetPoliciesUrlState } from "../../../../features/budgets/lib/budget-url-state";

interface BudgetPoliciesPageProps {
  searchParams?: Promise<{
    policyQ?: string | string[];
    policyPage?: string | string[];
    policyPageSize?: string | string[];
    assignmentQ?: string | string[];
    assignmentPage?: string | string[];
    assignmentPageSize?: string | string[];
  }>;
}

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const { application } = admin;
  const state = parseBudgetPoliciesUrlState(await searchParams);
  const policyInput = {
    query: state.policyQuery,
    page: state.policyPage,
    pageSize: state.policyPageSize,
  };
  const assignmentInput = {
    query: state.assignmentQuery,
    page: state.assignmentPage,
    pageSize: state.assignmentPageSize,
  };
  const policies = await application.queries.pageBudgetPolicies(policyInput);
  const assignments = await application.queries.pageScopeBudgetPolicyAssignments(assignmentInput);
  return { state, policies, assignments };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
