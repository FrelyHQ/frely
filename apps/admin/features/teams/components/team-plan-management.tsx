"use client";

import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@admin/navigation";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { AdminDialog, ConsoleDialogFooter, StatusBadge } from "../../../pages/owner/_components/ui";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { FormFieldFrame, FormSubmitError } from "../../_shared/form-fields";
import { addTeamPlan } from "../api/team-api";
import { buildTeamPlanPreview, createTeamPlanFormValues, defaultTeamPlanPriority, isNoLimitPayGoTemplate, toAddTeamPlanInput, type PaymentMode } from "../form/team-plan-form-values";

export interface TeamPlanTemplateOption { id: string; name: string; version: number; billingMode: "prepaid" | "paygo"; purchaseAmount: number; durationSeconds: number; accessPointCount: number }
export interface TeamPlanCreditAccountOption { id: string; scopeRef: string; status: string; balance: number }

export function AddTeamPlanControl({ teamId, templates, creditAccounts }: { teamId: string; templates: TeamPlanTemplateOption[]; creditAccounts: TeamPlanCreditAccountOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: addTeamPlan, retry: false, onSuccess: () => { setOpen(false); router.refresh(); } });
  const form = useForm({ defaultValues: createTeamPlanFormValues(templates, creditAccounts), onSubmit: async ({ value }) => { setConversionError(null); const converted = toAddTeamPlanInput(teamId, value, templates); if (!converted.ok) { setConversionError(converted.message); return; } await mutation.mutateAsync(converted.value); } });
  const openDialog = () => { mutation.reset(); setConversionError(null); form.reset(createTeamPlanFormValues(templates, creditAccounts)); setOpen(true); };

  return <>
    <Button type="button" onClick={openDialog} disabled={templates.length === 0}>Add Plan</Button>
    {open ? <AdminDialog observabilityKey="team-plan-add" titleId="team-plan-dialog-title" eyebrow="Team Plans" title="Add Plan" description={`Subscribe a plan for team:${teamId}`} onClose={() => setOpen(false)} closeDisabled={mutation.isPending}>
      <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
        <form.Subscribe selector={(state) => state.values}>{(values) => {
          const selectedTemplate = templates.find((template) => template.id === values.planTemplateId) ?? null;
          const selectedPaymentAccount = creditAccounts.find((account) => account.id === values.paymentAccountId) ?? null;
          const preview = buildTeamPlanPreview(selectedTemplate, values.units, values.paymentMode);
          return <div className="form-grid single">
            <form.Field name="planTemplateId">{(field) => <FormFieldFrame label="Plan Template" description="Only enabled templates are available here."><SearchSelect value={field.state.value} onValueChange={(id) => { field.handleChange(id); const template = templates.find((candidate) => candidate.id === id); if (template) form.setFieldValue("priority", String(defaultTeamPlanPriority(template))); }} disabled={mutation.isPending} options={templates.map((template) => ({ value: template.id, label: `${template.name} v${template.version}`, description: billingModeLabel(template) }))} /></FormFieldFrame>}</form.Field>
            <div className="form-grid"><form.Field name="units">{(field) => <FormFieldFrame label="Units" description="Creates consecutive subscription periods."><Input inputMode="numeric" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} disabled={mutation.isPending} /></FormFieldFrame>}</form.Field><form.Field name="priority">{(field) => <FormFieldFrame label="Priority" description="Prepaid defaults to 10; PayGo defaults to 100."><Input inputMode="numeric" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} disabled={mutation.isPending} /></FormFieldFrame>}</form.Field></div>
            <form.Field name="effectiveStart">{(field) => <FormFieldFrame label="Effective Start" description="Defaults to now. Clear it to let the API apply the backend default."><Input type="datetime-local" value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} disabled={mutation.isPending} /></FormFieldFrame>}</form.Field>
            <form.Field name="paymentMode">{(field) => <FormFieldFrame label="Payment Mode" description={field.state.value === "admin_grant" ? "Creates source=admin_grant subscriptions." : "Creates source=balance_purchase subscriptions and plan_purchase ledger events."}><SearchSelect value={field.state.value} onValueChange={(nextValue) => field.handleChange(nextValue as PaymentMode)} disabled={mutation.isPending} searchable={false} options={[{ value: "admin_grant", label: "Owner grant / no balance charge" }, { value: "charge_account", label: "Charge account / balance purchase" }]} /></FormFieldFrame>}</form.Field>
            {values.paymentMode === "charge_account" ? <form.Field name="paymentAccountId">{(field) => <FormFieldFrame label="Credit Account" description={selectedPaymentAccount ? `${formatCurrency(selectedPaymentAccount.balance)} available / ${selectedPaymentAccount.status}` : "The API will reject inactive accounts or insufficient balance."}><SearchSelect value={field.state.value} onValueChange={field.handleChange} disabled={mutation.isPending} placeholder="Select account" options={[{ value: "", label: "Select account" }, ...creditAccounts.map((account) => ({ value: account.id, label: account.scopeRef, description: `${formatCurrency(account.balance)} / ${account.status} / ${account.id}` }))]} /></FormFieldFrame>}</form.Field> : null}
            <div className="template-rule-section"><div className="template-rule-heading"><div><strong>Preview</strong><p className="muted">This entry is fixed to team:{teamId}; it will not cancel existing subscriptions.</p></div><StatusBadge tone={preview.valid ? "info" : "warn"}>{preview.units} unit{preview.units === 1 ? "" : "s"}</StatusBadge></div><div className="subscribe-summary-grid"><div><span>Billing mode</span><strong>{selectedTemplate ? billingModeLabel(selectedTemplate) : "Select a template"}</strong></div><div><span>Duration / unit</span><strong>{selectedTemplate ? formatPlanDuration(selectedTemplate) : "Select a template"}</strong></div><div><span>Price / unit</span><strong>{selectedTemplate ? formatCurrency(selectedTemplate.purchaseAmount) : "$0.00"}</strong></div><div><span>Total due</span><strong>{formatCurrency(preview.totalDue)}</strong></div><div><span>Included AccessPoints</span><strong>{selectedTemplate?.accessPointCount ?? 0}</strong></div><div><span>Usage charge</span><strong>{selectedTemplate?.billingMode === "paygo" ? "Requesting user's active credit balance" : "Not required"}</strong></div></div></div>
          </div>;
        }}</form.Subscribe>
        <ConsoleDialogFooter feedback={conversionError || mutation.error?.message ? <FormSubmitError message={conversionError ?? mutation.error?.message} /> : null}><Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={mutation.isPending}>Cancel</Button><Button type="submit" disabled={mutation.isPending || templates.length === 0}>{mutation.isPending ? "Adding..." : "Add Plan"}</Button></ConsoleDialogFooter>
      </form>
    </AdminDialog> : null}
  </>;
}

function billingModeLabel(template: Pick<TeamPlanTemplateOption, "billingMode">) { return template.billingMode === "paygo" ? "PayGo" : "Prepaid"; }
function formatPlanDuration(template: Pick<TeamPlanTemplateOption, "billingMode" | "durationSeconds">) { return isNoLimitPayGoTemplate(template) ? "No duration limit" : formatDuration(template.durationSeconds); }
function formatDuration(seconds: number) { if (seconds % 31536000 === 0) return `${seconds / 31536000} years`; if (seconds % 86400 === 0) return `${seconds / 86400} days`; if (seconds % 3600 === 0) return `${seconds / 3600} hours`; return `${seconds}s`; }
function formatCurrency(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value); }
