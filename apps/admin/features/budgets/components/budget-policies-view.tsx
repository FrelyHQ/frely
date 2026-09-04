"use client";

import { useMemo, useState } from "react";
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
import { assignDirectBudgetPolicy, createBudgetPolicy } from "../api/budget-api";
import { defaultDirectAssignmentFormValues, validateRequired } from "../form/budget-form-values";
import { budgetPoliciesHref, type BudgetPoliciesUrlState } from "../lib/budget-url-state";
import { toDisplayPolicy } from "../lib/budget-presenters";
import { budgetPolicyColumns, directAssignmentColumns } from "../table/budget-columns";
import type { BudgetPolicy, DirectAssignment, DirectoryPage } from "../types";
import { PolicyDialog } from "./policy-dialog";
import { RemoteBudgetCandidateSelect } from "./remote-budget-candidate-select";

export function BudgetPoliciesView({
  state,
  policies,
  directAssignments,
}: {
  state: BudgetPoliciesUrlState;
  policies: DirectoryPage<BudgetPolicy>;
  directAssignments: DirectoryPage<DirectAssignment>;
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const createMutation = useMutation({
    mutationFn: createBudgetPolicy,
    retry: false,
    onSuccess: (saved) => {
      setDialogOpen(false);
      setNotice(`Created budget policy ${saved.id}.`);
      router.refresh();
    },
  });
  const assignMutation = useMutation({
    mutationFn: assignDirectBudgetPolicy,
    retry: false,
    onSuccess: (_, value) => {
      setNotice(`Assigned direct limit to key:${value.keyId}.`);
      router.refresh();
    },
  });
  const displayRows = useMemo(() => policies.items.map(toDisplayPolicy), [policies.items]);
  const form = useForm({
    defaultValues: defaultDirectAssignmentFormValues(),
    onSubmit: async ({ value }) => assignMutation.mutateAsync(value),
  });
  return <>
    <PageHeading eyebrow="Budget Policies" title="Budget Policies" description="Manage hard-stop budget rules. Plans and direct key limits attach these rules.">
      <Button type="button" onClick={() => { createMutation.reset(); setDialogOpen(true); }} disabled={createMutation.isPending}>Create Policy</Button>
    </PageHeading>
    {notice && !dialogOpen ? <div className="notice-box notice-good" role="status">{notice}</div> : null}
    <Card className="panel">
      <div className="panel-heading">
        <div><h2>Budget Rules</h2><p className="muted">Rules are editable configuration. Changes affect attached plans and direct key limits.</p></div>
        <form className="directory-tools" action="/owner/plans-and-budgets/budget-policies">
          <input type="hidden" name="assignmentQ" value={state.assignmentQuery} />
          {state.assignmentPage > 1 ? <input type="hidden" name="assignmentPage" value={state.assignmentPage} /> : null}
          {state.assignmentPageSize !== 20 ? <input type="hidden" name="assignmentPageSize" value={state.assignmentPageSize} /> : null}
          {state.policyPageSize !== 20 ? <input type="hidden" name="policyPageSize" value={state.policyPageSize} /> : null}
          <label className="search-field"><span className="search-icon">S</span><Input name="policyQ" defaultValue={state.policyQuery} placeholder="Search policies" /></label>
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        <StatusBadge tone="warn">Hard stop only</StatusBadge>
      </div>
      <DataTable serverManaged data={displayRows} columns={budgetPolicyColumns} getRowId={(row) => row.id} emptyState={{ title: "No budget policies", description: "Create rolling or cumulative rules before building a plan template." }} />
      <MaterialTablePagination
        page={policies.page}
        pageSize={policies.pageSize}
        total={policies.total}
        totalPages={policies.totalPages}
        pageParam="policyPage"
        pageSizeParam="policyPageSize"
        rangeStart={policies.total ? (policies.page - 1) * policies.pageSize + 1 : 0}
        rangeEnd={Math.min(policies.page * policies.pageSize, policies.total)}
        previousHref={policies.page > 1 ? budgetPoliciesHref({ ...state, policyPage: policies.page - 1 }) : ""}
        nextHref={policies.page < policies.totalPages ? budgetPoliciesHref({ ...state, policyPage: policies.page + 1 }) : ""}
        noun="budget policies"
      />
    </Card>
    <Card className="panel">
      <div className="panel-heading">
        <div><h2>Direct Scope Limits</h2><p className="muted">Attach existing rules directly to API keys. These limits run in addition to user, team, or global plans.</p></div>
        <form className="directory-tools" action="/owner/plans-and-budgets/budget-policies">
          <input type="hidden" name="policyQ" value={state.policyQuery} />
          {state.policyPage > 1 ? <input type="hidden" name="policyPage" value={state.policyPage} /> : null}
          {state.policyPageSize !== 20 ? <input type="hidden" name="policyPageSize" value={state.policyPageSize} /> : null}
          {state.assignmentPageSize !== 20 ? <input type="hidden" name="assignmentPageSize" value={state.assignmentPageSize} /> : null}
          <label className="search-field"><span className="search-icon">S</span><Input name="assignmentQ" defaultValue={state.assignmentQuery} placeholder="Search direct limits" /></label>
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        <StatusBadge tone="info">Key scope</StatusBadge>
      </div>
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
        <form.Field name="keyId" validators={{ onSubmit: ({ value }) => validateRequired(value, "API key") }}>{(field) => <FormFieldFrame label="API Key" errors={field.state.meta.errors}><RemoteBudgetCandidateSelect kind="api-key" value={field.state.value} onChange={field.handleChange} disabled={assignMutation.isPending} /></FormFieldFrame>}</form.Field>
        <form.Field name="budgetPolicyId" validators={{ onSubmit: ({ value }) => validateRequired(value, "Budget policy") }}>{(field) => <FormFieldFrame label="Budget Policy" errors={field.state.meta.errors}><RemoteBudgetCandidateSelect kind="policy" value={field.state.value} onChange={field.handleChange} disabled={assignMutation.isPending} /></FormFieldFrame>}</form.Field>
        <label>Action<Button type="submit" disabled={assignMutation.isPending}>{assignMutation.isPending ? "Assigning..." : "Assign Limit"}</Button></label>
      </form>
      <FormSubmitError message={assignMutation.error instanceof Error ? assignMutation.error.message : undefined} />
      <DataTable serverManaged data={directAssignments.items} columns={directAssignmentColumns()} getRowId={(row) => row.id} emptyState={{ title: "No direct key limits", description: "Assign an existing policy to an API key to add an independent key-level cap." }} />
      <MaterialTablePagination
        page={directAssignments.page}
        pageSize={directAssignments.pageSize}
        total={directAssignments.total}
        totalPages={directAssignments.totalPages}
        pageParam="assignmentPage"
        pageSizeParam="assignmentPageSize"
        rangeStart={directAssignments.total ? (directAssignments.page - 1) * directAssignments.pageSize + 1 : 0}
        rangeEnd={Math.min(directAssignments.page * directAssignments.pageSize, directAssignments.total)}
        previousHref={directAssignments.page > 1 ? budgetPoliciesHref({ ...state, assignmentPage: directAssignments.page - 1 }) : ""}
        nextHref={directAssignments.page < directAssignments.totalPages ? budgetPoliciesHref({ ...state, assignmentPage: directAssignments.page + 1 }) : ""}
        noun="direct budget assignments"
      />
    </Card>
    {dialogOpen ? <PolicyDialog titleId="budget-policy-dialog-title" eyebrow="Budget Policies" title="Create Budget Policy" description="New budget policy" pending={createMutation.isPending} error={createMutation.error instanceof Error ? createMutation.error.message : undefined} onClose={() => setDialogOpen(false)} onSubmit={(value) => createMutation.mutateAsync(value).then(() => undefined)} /> : null}
  </>;
}
