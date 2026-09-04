import { adminPageServices } from "../../../../lib/server";
import { GovernanceBudgetsView } from "../../../../features/budgets";
import { parseGovernanceBudgetsUrlState } from "../../../../features/budgets/lib/budget-url-state";

interface GovernanceBudgetsPageProps {
  searchParams?: Promise<{
    policyPage?: string | string[];
    policyPageSize?: string | string[];
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
  const state = parseGovernanceBudgetsUrlState(await searchParams);
  const policies = await application.queries.pageGovernanceBudgetPolicies({ page: state.policyPage, pageSize: state.policyPageSize });
  const assignments = await application.queries.pageScopeGovernanceBudgetPolicyAssignments({ page: state.assignmentPage, pageSize: state.assignmentPageSize });
  return { currentUserScopeRef: `user:${admin.claims.sub}`, state, policies, assignments };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
