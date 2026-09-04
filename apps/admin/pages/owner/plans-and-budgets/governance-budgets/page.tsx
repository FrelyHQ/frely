import { GovernanceBudgetsView } from "../../../../features/budgets";
import type { AdminPageData } from "./page.server";

export default function GovernanceBudgetsPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { currentUserScopeRef, state, policies, assignments } = loaded;
  return (
    <GovernanceBudgetsView
      state={{ ...state, policyPage: policies.page, assignmentPage: assignments.page }}
      policies={policies}
      assignments={assignments}
      currentUserScopeRef={currentUserScopeRef}
    />
  );
}
