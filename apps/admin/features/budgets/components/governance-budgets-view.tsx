"use client";
import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { DataTable } from "@frely/console-ui/data-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { useRouter } from "@admin/navigation";
import { PageHeading, StatusBadge } from "../../../pages/owner/_components/ui";
import { FormFieldFrame, FormSubmitError } from "../../_shared/form-fields";
import { assignGovernanceBudgetPolicy, createGovernanceBudgetPolicy } from "../api/budget-api";
import { defaultGovernanceAssignmentFormValues, validateRequired } from "../form/budget-form-values";
import { governanceBudgetsHref, type GovernanceBudgetsUrlState } from "../lib/budget-url-state";
import { governanceAssignmentColumns, governancePolicyColumns } from "../table/budget-columns";
import type { DirectoryPage, GovernanceBudgetAssignment, GovernanceBudgetPolicy } from "../types";
import { PolicyDialog } from "./policy-dialog";
import { RemoteBudgetCandidateSelect } from "./remote-budget-candidate-select";

export function GovernanceBudgetsView({ state, policies, assignments, currentUserScopeRef }: { state: GovernanceBudgetsUrlState; policies: DirectoryPage<GovernanceBudgetPolicy>; assignments: DirectoryPage<GovernanceBudgetAssignment>; currentUserScopeRef: string; }) {
  const router = useRouter(); const [dialogOpen, setDialogOpen] = useState(false); const [notice, setNotice] = useState<string>();
  const createMutation = useMutation({ mutationFn: createGovernanceBudgetPolicy, retry: false, onSuccess: (saved) => { setDialogOpen(false); setNotice(`Created governance budget ${saved.id}.`); router.refresh(); } });
  const assignMutation = useMutation({ mutationFn: assignGovernanceBudgetPolicy, retry: false, onSuccess: (saved) => { setNotice(`Assigned hard stop to ${saved.scopeRef}.`); router.refresh(); } });
  const form = useForm({ defaultValues: defaultGovernanceAssignmentFormValues(currentUserScopeRef), onSubmit: async ({ value }) => assignMutation.mutateAsync(value) });
  return <><PageHeading eyebrow="Governance Budgets" title="Governance Budgets" description="Organization and global hard stops. These limits reject requests before plan selection and never fall back to another plan."><Button type="button" onClick={() => { createMutation.reset(); setDialogOpen(true); }} disabled={createMutation.isPending}>Create Hard Stop</Button></PageHeading>
    {notice && !dialogOpen ? <div className="notice-box notice-good" role="status">{notice}</div> : null}
    <Card className="panel"><div className="panel-heading"><div><h2>Hard Stop Rules</h2><p className="muted">Rules are independent from plan budget policies and direct key limits.</p></div><StatusBadge tone="bad">No fallback</StatusBadge></div><DataTable serverManaged data={policies.items} columns={governancePolicyColumns} getRowId={(row) => row.id} emptyState={{ title: "No governance budgets", description: "Create a rule before assigning hard stops." }} /><MaterialTablePagination page={policies.page} pageSize={policies.pageSize} total={policies.total} totalPages={policies.totalPages} pageParam="policyPage" pageSizeParam="policyPageSize" rangeStart={policies.total ? (policies.page - 1) * policies.pageSize + 1 : 0} rangeEnd={Math.min(policies.page * policies.pageSize, policies.total)} previousHref={policies.page > 1 ? governanceBudgetsHref({ ...state, policyPage: policies.page - 1 }) : ""} nextHref={policies.page < policies.totalPages ? governanceBudgetsHref({ ...state, policyPage: policies.page + 1 }) : ""} noun="governance budgets" /></Card>
    <Card className="panel"><div className="panel-heading"><div><h2>Scope Assignments</h2><p className="muted">Supported scopes are global:, team:id, and user:id.</p></div><StatusBadge tone="info">Governance</StatusBadge></div>
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
        <form.Field name="scopeRef" validators={{ onBlur: ({ value }) => validateRequired(value, "Scope"), onSubmit: ({ value }) => validateRequired(value, "Scope") }}>{(field) => <FormFieldFrame label="Scope" errors={field.state.meta.errors}><Input value={field.state.value} placeholder={currentUserScopeRef} disabled={assignMutation.isPending} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</form.Field>
        <form.Field name="governanceBudgetPolicyId" validators={{ onSubmit: ({ value }) => validateRequired(value, "Governance budget") }}>{(field) => <FormFieldFrame label="Governance Budget" errors={field.state.meta.errors}><RemoteBudgetCandidateSelect kind="governance-policy" value={field.state.value} onChange={field.handleChange} disabled={assignMutation.isPending} /></FormFieldFrame>}</form.Field>
        <label>Action<Button type="submit" disabled={assignMutation.isPending}>{assignMutation.isPending ? "Assigning..." : "Assign Hard Stop"}</Button></label>
      </form><FormSubmitError message={assignMutation.error instanceof Error ? assignMutation.error.message : undefined} /><DataTable serverManaged data={assignments.items} columns={governanceAssignmentColumns} getRowId={(row) => row.id} emptyState={{ title: "No hard stops assigned", description: "Assign a governance budget to start enforcing it." }} /><MaterialTablePagination page={assignments.page} pageSize={assignments.pageSize} total={assignments.total} totalPages={assignments.totalPages} pageParam="assignmentPage" pageSizeParam="assignmentPageSize" rangeStart={assignments.total ? (assignments.page - 1) * assignments.pageSize + 1 : 0} rangeEnd={Math.min(assignments.page * assignments.pageSize, assignments.total)} previousHref={assignments.page > 1 ? governanceBudgetsHref({ ...state, assignmentPage: assignments.page - 1 }) : ""} nextHref={assignments.page < assignments.totalPages ? governanceBudgetsHref({ ...state, assignmentPage: assignments.page + 1 }) : ""} noun="governance assignments" />
    </Card>{dialogOpen ? <PolicyDialog titleId="governance-budget-dialog-title" eyebrow="Governance" title="Create Hard Stop" description="New governance budget" pending={createMutation.isPending} error={createMutation.error instanceof Error ? createMutation.error.message : undefined} onClose={() => setDialogOpen(false)} onSubmit={(value) => createMutation.mutateAsync(value).then(() => undefined)} /> : null}</>;
}
