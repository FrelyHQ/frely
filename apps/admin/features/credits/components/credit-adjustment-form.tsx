"use client";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { Textarea } from "@frely/ui/components/textarea";
import { useRouter } from "@admin/navigation";
import { FormFieldFrame } from "../../_shared/form-fields";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { createCreditLedgerEvent } from "../api/credit-api";
import { defaultCreditAdjustmentFormValues, toCreditAdjustmentInput, validateCreditAdjustmentAmount } from "../form/credit-adjustment-form-values";

export function CreditAdjustmentForm({ scopeRef }: { scopeRef: string }) {
  const router = useRouter();
  const mutation = useMutation({ mutationFn: createCreditLedgerEvent, retry: false, onSuccess: () => router.refresh() });
  const form = useForm({
    defaultValues: defaultCreditAdjustmentFormValues(),
    onSubmit: async ({ value }) => {
      const converted = toCreditAdjustmentInput(scopeRef, value);
      if (!converted.ok) throw new Error(converted.message);
      await mutation.mutateAsync(converted.value);
      form.reset();
    },
  });

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      <div className="form-grid single">
        <form.Field name="eventType">
          {(field) => <FormFieldFrame label="Event Type" description="Grant must be positive. Adjustment and reversal can be positive or negative."><SearchSelect value={field.state.value} onValueChange={(nextValue) => field.handleChange(nextValue as typeof field.state.value)} searchable={false} options={[{ value: "grant", label: "Grant" }, { value: "adjustment", label: "Adjustment" }, { value: "reversal", label: "Reversal" }]} /></FormFieldFrame>}
        </form.Field>
        <form.Field name="amount" validators={{ onBlur: ({ value }) => validateCreditAdjustmentAmount(value), onSubmit: ({ value }) => validateCreditAdjustmentAmount(value) }}>
          {(field) => <FormFieldFrame label="Amount" description="USD amount. Negative non-usage events cannot overdraw the account." errors={field.state.meta.errors}><Input type="number" step="0.000001" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}
        </form.Field>
        <form.Field name="reason" validators={{ onSubmit: ({ value }) => value.trim() ? undefined : "Enter a reason." }}>
          {(field) => <FormFieldFrame label="Reason" description="Stored on the ledger event and audit metadata." errors={field.state.meta.errors}><Textarea rows={3} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}
        </form.Field>
        <form.Field name="relatedEventId">
          {(field) => <FormFieldFrame label="Related Event ID" description="Optional for reversal or adjustment traceability."><Input value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}
        </form.Field>
      </div>
      {mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error.message}</div> : null}
      <div className="drawer-actions">
        <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving..." : "Create Ledger Event"}</Button>
      </div>
    </form>
  );
}
