"use client";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { Textarea } from "@frely/ui/components/textarea";
import { Tooltip } from "@frely/ui/components/tooltip";
import { useRouter } from "@admin/navigation";
import { useEffect } from "react";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { FormFieldFrame } from "../../_shared/form-fields";
import { grantAdminCard } from "../api/user-api";
import { adminCardTimePresentation, defaultAdminCardFormValues, toAdminCardInput, validateAdminCardExpiration, validateAdminCardReference, type AdminCardType } from "../form/owner-card-form-values";
import { RemoteAdminCardCandidateSelect } from "./remote-admin-card-candidate-select";

export function AdminCardForm({ recipient, senderUserId }: { recipient: { id: string; email: string; status: string }; senderUserId: string }) {
  const router = useRouter();
  const initialType: AdminCardType = "plan";
  const mutation = useMutation({ mutationFn: grantAdminCard, retry: false, onSuccess: () => router.refresh() });
  const form = useForm({
    defaultValues: { ...defaultAdminCardFormValues(initialType, new Date(0)), expiresAtLocal: "" },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(toAdminCardInput(recipient.id, value));
      form.reset(defaultAdminCardFormValues(value.cardType));
    }
  });
  useEffect(() => {
    if (!form.state.values.expiresAtLocal) form.setFieldValue("expiresAtLocal", defaultAdminCardFormValues(initialType).expiresAtLocal);
  }, [form, initialType]);
  const canIssue = recipient.status === "enabled" && senderUserId !== recipient.id;

  return <Card className="panel admin-note-panel">
    <div className="panel-heading"><div><h2>Marketing Card</h2><p className="muted">Send a promotional Plan or Credit Card. The default validity is 30 days and can be changed before sending.</p></div></div>
    <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      <form.Subscribe selector={(state) => ({ cardType: state.values.cardType, expiresAtLocal: state.values.expiresAtLocal })}>{({ cardType, expiresAtLocal }) => {
        const time = adminCardTimePresentation(expiresAtLocal);
        return <div className="form-grid single">
          <form.Field name="cardType">{(field) => <FormFieldFrame label="Card Type"><SearchSelect value={field.state.value} onValueChange={(nextValue) => { field.handleChange(nextValue as AdminCardType); form.setFieldValue("productId", ""); }} searchable={false} disabled={mutation.isPending} options={[{ value: "plan", label: "Plan Card" }, { value: "credit", label: "Credit Card" }]} /></FormFieldFrame>}</form.Field>
          <form.Field name="productId" validators={{ onSubmit: ({ value }) => value ? undefined : "Select a Card product." }}>{(field) => <FormFieldFrame label={cardType === "plan" ? "Plan" : "Credit Product"} description={cardType === "plan" ? "Only enabled prepaid Plans visible to this user are available." : "The Card freezes the current Credit Product amount."} errors={field.state.meta.errors}><RemoteAdminCardCandidateSelect kind={cardType === "plan" ? "plans" : "credit-products"} userId={recipient.id} value={field.state.value} onChange={field.handleChange} disabled={mutation.isPending} /></FormFieldFrame>}</form.Field>
          <form.Field name="expiresAtLocal" validators={{ onBlur: ({ value }) => validateAdminCardExpiration(value), onSubmit: ({ value }) => validateAdminCardExpiration(value) }}>{(field) => <FormFieldFrame label={<span className="inline-actions">Expiration Time<Tooltip content={time ? <span>Browser timezone: {time.timeZone} ({time.offset})<br />UTC: {time.utc}</span> : "Select a valid local time to see timezone details."}><Button type="button" variant="secondary" size="sm">Timezone / UTC</Button></Tooltip></span>} description="Interpreted in this browser's local timezone. Sending freezes the resulting UTC instant; later transfers do not extend it." errors={field.state.meta.errors}><Input type="datetime-local" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={mutation.isPending} /></FormFieldFrame>}</form.Field>
          <form.Field name="referenceCode" validators={{ onBlur: ({ value }) => validateAdminCardReference(value), onSubmit: ({ value }) => validateAdminCardReference(value) }}>{(field) => <FormFieldFrame label="Activity Reference" description="Required stable campaign or batch code for exact Owner lookup." errors={field.state.meta.errors}><Input maxLength={100} value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} placeholder="campaign-2026-summer" disabled={mutation.isPending} /></FormFieldFrame>}</form.Field>
          <form.Field name="note" validators={{ onSubmit: ({ value }) => value.length <= 500 ? undefined : "Message must be at most 500 characters." }}>{(field) => <FormFieldFrame label="Recipient Message" description="Optional; visible only to the Owner sender and this recipient." errors={field.state.meta.errors}><Textarea rows={3} maxLength={500} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} disabled={mutation.isPending} /></FormFieldFrame>}</form.Field>
        </div>;
      }}</form.Subscribe>
      <div className="notice-box notice-warn">This grant does not charge a balance or create purchase revenue. Sending is immediate and cannot be recalled.</div>
      {!canIssue ? <div className="notice-box notice-bad">The recipient must be enabled and different from the Owner sender.</div> : null}
      {mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error.message}</div> : null}
      {mutation.isSuccess ? <div className="notice-box notice-good" role="status">Card sent to {recipient.email}.</div> : null}
      <div className="drawer-actions"><Button type="submit" disabled={mutation.isPending || !canIssue}>{mutation.isPending ? "Sending..." : "Send Marketing Card"}</Button></div>
    </form>
  </Card>;
}
