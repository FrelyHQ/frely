"use client";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { useRouter } from "@admin/navigation";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { FormFieldFrame, FormSubmitError } from "../../_shared/form-fields";
import { createCreditProduct, createCreditProductListing, createPaymentChannel, enablePaymentChannel, uploadPaymentChannelInstruction } from "../api/credit-api";
import { defaultCreditListingFormValues, defaultCreditProductFormValues, defaultPaymentChannelFormValues, validatePositiveUnits, validateRequired } from "../form/credit-form-values";
import type { CreditConfigurationSummary, PaymentChannel } from "../types";
import { RemoteCreditCandidateSelect } from "./remote-credit-candidate-select";

export function CreditConfiguration({ summary, draftChannels }: { summary: CreditConfigurationSummary; draftChannels: PaymentChannel[] }) {
  const router = useRouter();
  const refresh = () => router.refresh();
  const productMutation = useMutation({ mutationFn: createCreditProduct, retry: false, onSuccess: refresh });
  const channelMutation = useMutation({ mutationFn: createPaymentChannel, retry: false, onSuccess: refresh });
  const listingMutation = useMutation({ mutationFn: createCreditProductListing, retry: false, onSuccess: refresh });
  const enableMutation = useMutation({ mutationFn: enablePaymentChannel, retry: false, onSuccess: refresh });
  const uploadMutation = useMutation({ mutationFn: uploadPaymentChannelInstruction, retry: false, onSuccess: refresh });
  const productForm = useForm({ defaultValues: defaultCreditProductFormValues(), onSubmit: async ({ value }) => { await productMutation.mutateAsync({ value, displayOrder: summary.productCount }); productForm.reset(); } });
  const channelForm = useForm({ defaultValues: defaultPaymentChannelFormValues(), onSubmit: async ({ value }) => { await channelMutation.mutateAsync(value); channelForm.reset(); } });
  const listingForm = useForm({ defaultValues: defaultCreditListingFormValues(), onSubmit: async ({ value }) => { await listingMutation.mutateAsync(value); listingForm.reset(); } });
  const busy = productMutation.isPending || channelMutation.isPending || listingMutation.isPending || enableMutation.isPending || uploadMutation.isPending;
  const error = [productMutation.error, channelMutation.error, listingMutation.error, enableMutation.error, uploadMutation.error].find((item) => item instanceof Error);
  return <div className="stacked-panel">
    <h3>Credit Products</h3>
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void productForm.handleSubmit(); }}>
      <productForm.Field name="code" validators={{ onBlur: ({ value }) => validateRequired(value, "Code"), onSubmit: ({ value }) => validateRequired(value, "Code") }}>{(field) => <FormFieldFrame label="Code" errors={field.state.meta.errors}><Input value={field.state.value} disabled={busy} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</productForm.Field>
      <productForm.Field name="displayName" validators={{ onBlur: ({ value }) => validateRequired(value, "Name"), onSubmit: ({ value }) => validateRequired(value, "Name") }}>{(field) => <FormFieldFrame label="Name" errors={field.state.meta.errors}><Input value={field.state.value} disabled={busy} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</productForm.Field>
      <productForm.Field name="description">{(field) => <FormFieldFrame label="Description"><Input value={field.state.value} disabled={busy} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</productForm.Field>
      <productForm.Field name="adminNote">{(field) => <FormFieldFrame label="Admin note"><Input value={field.state.value} disabled={busy} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</productForm.Field>
      <productForm.Field name="creditedAmountUnits" validators={{ onBlur: ({ value }) => validatePositiveUnits(value, "Credit units"), onSubmit: ({ value }) => validatePositiveUnits(value, "Credit units") }}>{(field) => <FormFieldFrame label="Credit units (6 decimals)" errors={field.state.meta.errors}><Input inputMode="numeric" value={field.state.value} disabled={busy} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</productForm.Field>
      <label>Action<Button type="submit" disabled={busy}>{productMutation.isPending ? "Creating..." : "Create Product"}</Button></label>
    </form>
    <h3>Payment Channels</h3>
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void channelForm.handleSubmit(); }}>
      <channelForm.Field name="settlementMode">{(field) => <FormFieldFrame label="Settlement mode"><SearchSelect value={field.state.value ?? "manual_review"} disabled={busy} onValueChange={(value) => field.handleChange(value as "manual_review" | "stripe_checkout")} options={[{ value: "manual_review", label: "Manual review" }, { value: "stripe_checkout", label: "Stripe Checkout" }]} /></FormFieldFrame>}</channelForm.Field>
      {([['code','Code'],['displayName','Name'],['paymentNetwork','Network'],['recipientIdentifier','Recipient'],['recipientIdentifierDisplay','Masked display']] as const).filter(([name]) => channelForm.state.values.settlementMode !== "stripe_checkout" || name === "code" || name === "displayName").map(([name, label]) => <channelForm.Field key={name} name={name} validators={{ onBlur: ({ value }) => validateRequired(value, label), onSubmit: ({ value }) => validateRequired(value, label) }}>{(field) => <FormFieldFrame label={label} errors={field.state.meta.errors}><Input value={field.state.value} disabled={busy} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</channelForm.Field>)}
      <channelForm.Field name="paymentAsset" validators={{ onBlur: ({ value }) => validateRequired(value, "Asset"), onSubmit: ({ value }) => validateRequired(value, "Asset") }}>{(field) => <FormFieldFrame label="Asset" description={channelForm.state.values.settlementMode === "stripe_checkout" ? "Plan Listings may use supported Stripe presentment currencies; Credit Listings remain USD-only." : undefined} errors={field.state.meta.errors}><Input value={field.state.value} disabled={busy} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value.toUpperCase())} /></FormFieldFrame>}</channelForm.Field>
      {channelForm.state.values.settlementMode !== "stripe_checkout" ? <channelForm.Field name="paymentInstruction">{(field) => <FormFieldFrame label="Payment instruction"><Input value={field.state.value} disabled={busy} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</channelForm.Field> : <p className="muted">Stripe credentials are supplied through the server environment.</p>}
      <label>Action<Button type="submit" disabled={busy}>{channelMutation.isPending ? "Creating..." : "Create Draft Channel"}</Button></label>
    </form>
    <div className="table-actions">{draftChannels.map((item) => <div key={item.id}><Input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadMutation.mutate({ channelId: item.id, file }); }} /><Button type="button" size="sm" disabled={busy} onClick={() => enableMutation.mutate(item.id)}>Enable {item.displayName}</Button></div>)}</div>
    <h3>Product Listings</h3>
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void listingForm.handleSubmit(); }}>
      <listingForm.Field name="productId" validators={{ onSubmit: ({ value }) => validateRequired(value, "Product") }}>{(field) => <FormFieldFrame label="Product" errors={field.state.meta.errors}><RemoteCreditCandidateSelect kind="product" value={field.state.value} disabled={busy} onChange={field.handleChange} /></FormFieldFrame>}</listingForm.Field>
      <listingForm.Field name="paymentChannelId" validators={{ onSubmit: ({ value }) => validateRequired(value, "Channel") }}>{(field) => <FormFieldFrame label="Channel" errors={field.state.meta.errors}><RemoteCreditCandidateSelect kind="channel" value={field.state.value} disabled={busy} onChange={field.handleChange} /></FormFieldFrame>}</listingForm.Field>
      <listingForm.Field name="priceAmountUnits" validators={{ onBlur: ({ value }) => validatePositiveUnits(value, "Final price units"), onSubmit: ({ value }) => validatePositiveUnits(value, "Final price units") }}>{(field) => <FormFieldFrame label="Final price units" errors={field.state.meta.errors}><Input inputMode="numeric" value={field.state.value} disabled={busy} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></FormFieldFrame>}</listingForm.Field>
      <label>Action<Button type="submit" disabled={busy}>{listingMutation.isPending ? "Creating..." : "Create Listing"}</Button></label>
    </form>
    <FormSubmitError message={error instanceof Error ? error.message : undefined} />
    <p className="muted">Configured: {summary.productCount} products, {summary.paymentChannelCount} channels, {summary.enabledListingCount} enabled listings.</p>
  </div>;
}
