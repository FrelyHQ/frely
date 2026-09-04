"use client";
import { useForm } from "@tanstack/react-form";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { AdminDialog, ConsoleDialogFooter } from "../../../pages/owner/_components/ui";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { FormFieldFrame, FormSubmitError } from "../../_shared/form-fields";
import { defaultPolicyFormValues, validateLimitValue, validateWindowSeconds, type PolicyFormValues } from "../form/budget-form-values";

export function PolicyDialog({ titleId, eyebrow, title, description, pending, error, onClose, onSubmit }: { titleId: string; eyebrow: string; title: string; description: string; pending: boolean; error: string | undefined; onClose: () => void; onSubmit: (value: PolicyFormValues) => Promise<void>; }) {
  const form = useForm({ defaultValues: defaultPolicyFormValues(), onSubmit: async ({ value }) => onSubmit(value) });
  return <AdminDialog observabilityKey="budget-policy-editor" titleId={titleId} eyebrow={eyebrow} title={title} description={description} onClose={onClose} closeDisabled={pending}>
    <form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
      <div className="form-grid single">
        <form.Field name="metric">{(field) => <FormFieldFrame label="Metric"><SearchSelect value={field.state.value} disabled={pending} onBlur={field.handleBlur} onValueChange={field.handleChange} searchable={false} options={[{ value: "amount", label: "Amount" }, { value: "tokens", label: "Tokens" }]} /></FormFieldFrame>}</form.Field>
        <form.Field name="limitValue" validators={{ onBlur: ({ value }) => validateLimitValue(value), onSubmit: ({ value }) => validateLimitValue(value) }}>{(field) => <FormFieldFrame label="Limit Value" errors={field.state.meta.errors}><Input inputMode="decimal" value={field.state.value} placeholder="50" disabled={pending} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</form.Field>
        <form.Field name="windowType">{(field) => <FormFieldFrame label="Window Type"><SearchSelect value={field.state.value} disabled={pending} onBlur={field.handleBlur} onValueChange={field.handleChange} searchable={false} options={[{ value: "rolling", label: "Rolling" }, { value: "cumulative", label: "Cumulative" }]} /></FormFieldFrame>}</form.Field>
        <form.Subscribe selector={(state) => state.values.windowType}>{(windowType) => windowType === "rolling" ? <form.Field name="windowSeconds" validators={{ onBlur: ({ value }) => validateWindowSeconds(value, windowType), onSubmit: ({ value }) => validateWindowSeconds(value, windowType) }}>{(field) => <FormFieldFrame label="Window Seconds" errors={field.state.meta.errors}><Input inputMode="numeric" value={field.state.value} placeholder="14400" disabled={pending} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</form.Field> : null}</form.Subscribe>
        <form.Field name="status">{(field) => <FormFieldFrame label="Status"><SearchSelect value={field.state.value} disabled={pending} onBlur={field.handleBlur} onValueChange={field.handleChange} searchable={false} options={[{ value: "enabled", label: "Enabled" }, { value: "disabled", label: "Disabled" }]} /></FormFieldFrame>}</form.Field>
      </div><ConsoleDialogFooter feedback={error ? <FormSubmitError message={error} /> : null}><Button type="button" variant="secondary" onClick={onClose} disabled={pending}>Discard</Button><Button type="submit" disabled={pending}>{pending ? "Creating..." : "Create"}</Button></ConsoleDialogFooter>
    </form>
  </AdminDialog>;
}
