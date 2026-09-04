"use client";

import { useRef, useState, type ReactNode } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@frely/ui/components/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@frely/ui/components/dialog";
import { Input } from "@frely/ui/components/input";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { SearchSelect } from "./search-select.js";
import { MaterialTable } from "./material-table.js";
import { consoleErrorMessage } from "./api-error.js";
import { resolveConsoleMessage, type ConsoleMessageResolver } from "./messages.js";

export interface CreditTopupListing {
  id: string;
  productName: string;
  creditedAmountUnits: number;
  priceAmountUnits: number;
  paymentAsset: string;
  channelId: string;
  channelName: string;
  settlementMode: string;
  recipientIdentifierDisplay: string;
  paymentInstruction: string | null;
  instructionAttachments: Array<{ id: string }>;
}

export interface CreditTopupHistoryRow {
  id: string;
  status: string;
  creditedAmountUnits: number;
  expectedPaymentAmountUnits: number;
  paymentAsset: string;
  paymentNetwork: string;
  transactionReferenceTail: string | null;
  expiresAt: string;
  attachmentCount: number;
  createdAt: string;
}

export type CreditTopupIntent =
  | {
      kind: "create";
      listingId: string;
      useImmediately: boolean;
      transactionReference: string;
      receipt: File | null;
      idempotencyKey: string;
    }
  | { kind: "cancel"; topupId: string };

export interface CreditTopupActionPort {
  mutateTopup(input: CreditTopupIntent): Promise<void>;
  createStripeCheckout(input: {
    listingId: string;
    useImmediately: boolean;
    idempotencyKey: string;
  }): Promise<string>;
  openCheckout(checkoutUrl: string): void;
  onChanged(): void;
}

export interface CreditTopupFormValues {
  listingId: string;
  transactionReference: string;
  receipt: File | null;
}

export function CreditTopupExperience({
  listings,
  topups,
  nextHref = "",
  interactionMode,
  actionPort,
  instructionAttachmentHref,
  messageResolver,
  historyPagination,
}: {
  listings: CreditTopupListing[];
  topups: CreditTopupHistoryRow[];
  nextHref?: string;
  interactionMode: "active" | "preview";
  actionPort?: CreditTopupActionPort;
  instructionAttachmentHref?: (channelId: string, attachmentId: string) => string;
  messageResolver?: ConsoleMessageResolver;
  historyPagination?: ReactNode;
}) {
  const active = interactionMode === "active" && Boolean(actionPort);
  const stripeListings = listings.filter((item) => item.settlementMode === "stripe_checkout");
  const manualListings = listings.filter((item) => item.settlementMode !== "stripe_checkout");
  const idempotencyKeys = useRef<Record<"use" | "keep", string>>({
    use: crypto.randomUUID(),
    keep: crypto.randomUUID(),
  });
  const stripeIdempotencyKeys = useRef<Record<string, string>>({});
  const [purchaseIntent, setPurchaseIntent] = useState<"use" | "keep" | null>(null);
  const form = useForm({
    defaultValues: creditTopupDefaults(manualListings[0]?.id),
  });
  const values = useStore(form.store, (state) => state.values);
  const mutation = useMutation({
    mutationFn: async (input: CreditTopupIntent) => {
      if (!actionPort) throw new Error("Preview only");
      await actionPort.mutateTopup(input);
    },
    retry: false,
    onSuccess: (_data, variables) => {
      if (variables.kind === "create") {
        form.reset();
        setPurchaseIntent(null);
        idempotencyKeys.current = { use: crypto.randomUUID(), keep: crypto.randomUUID() };
      }
      actionPort?.onChanged();
    },
  });
  const stripeMutation = useMutation({
    mutationFn: async (input: { listingId: string; useImmediately: boolean; idempotencyKey: string }) => {
      if (!actionPort) throw new Error("Preview only");
      return actionPort.createStripeCheckout(input);
    },
    retry: false,
    onSuccess: (checkoutUrl) => actionPort?.openCheckout(checkoutUrl),
  });
  const selected = manualListings.find((item) => item.id === values.listingId);
  const saving = mutation.isPending;

  return <div className="stacked-panel">
    {!active ? <div className="notice-box" role="status">{resolveConsoleMessage(messageResolver, "credit.preview_only", "Preview only. Top-up actions are disabled.")}</div> : null}
    {stripeListings.length ? <div className="card-grid">
      {stripeListings.map((listing) => <Card key={listing.id}>
        <CardHeader><CardTitle>{listing.productName}</CardTitle><CardDescription>Credit Card delivered after verified Stripe payment.</CardDescription></CardHeader>
        <CardContent><div className="detail-list"><div><span>Credit</span><strong data-clarity-mask="true">{formatCredit(listing.creditedAmountUnits)}</strong></div><div><span>Payment</span><strong data-clarity-mask="true">{formatUnits(listing.priceAmountUnits)} {listing.paymentAsset}</strong></div><div><span>Valid</span><strong>2 years after issue</strong></div></div></CardContent>
        <CardFooter><Button type="button" disabled={!active || stripeMutation.isPending} onClick={() => {
          const idempotencyKey = stripeIdempotencyKeys.current[listing.id] ??= crypto.randomUUID();
          stripeMutation.mutate({ listingId: listing.id, useImmediately: false, idempotencyKey });
        }}>{stripeMutation.isPending && stripeMutation.variables?.listingId === listing.id ? "Opening Stripe…" : active ? "Buy with Stripe" : "Preview only"}</Button></CardFooter>
      </Card>)}
    </div> : null}
    {stripeMutation.error ? <div className="notice-box notice-bad" role="alert">{errorMessage(stripeMutation.error, resolveConsoleMessage(messageResolver, "credit.checkout_failed", "Create Stripe Checkout failed"))}</div> : null}
    {manualListings.length ? <form className="form-grid" onSubmit={(event) => event.preventDefault()}>
      <form.Field name="listingId">{(field) => <label>Manual payment product<SearchSelect value={field.state.value} onBlur={field.handleBlur} onValueChange={field.handleChange} options={manualListings.map((item) => ({ value: item.id, label: item.productName, description: `${formatUnits(item.priceAmountUnits)} ${item.paymentAsset}` }))} /></label>}</form.Field>
      {selected ? <div className="detail-list">
        <div><span>Credit</span><strong data-clarity-mask="true">{formatCredit(selected.creditedAmountUnits)}</strong></div>
        <div><span>Final payment</span><strong data-clarity-mask="true">{formatUnits(selected.priceAmountUnits)} {selected.paymentAsset}</strong></div>
        <div><span>Channel</span><strong>{selected.channelName}</strong></div>
        <div><span>Recipient</span><strong data-clarity-mask="true">{selected.recipientIdentifierDisplay}</strong></div>
        {selected.paymentInstruction ? <div><span>Instructions</span><strong data-clarity-mask="true">{selected.paymentInstruction}</strong></div> : null}
        {selected.instructionAttachments.map((attachment) => <div key={attachment.id}><span>Payment QR</span>{active && instructionAttachmentHref ? <a href={instructionAttachmentHref(selected.channelId, attachment.id)} target="_blank" rel="noreferrer">View private instruction</a> : <strong>Preview only</strong>}</div>)}
      </div> : <div className="notice-box">No enabled top-up products are configured.</div>}
      <form.Field name="transactionReference">{(field) => <label>Transaction Reference (optional when uploading evidence)<Input value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} disabled={!active} /></label>}</form.Field>
      <form.Field name="receipt">{(field) => <label>Payment Evidence (optional when submitting a reference)<Input type="file" accept="image/jpeg,image/png,image/webp" disabled={!active} onChange={(event) => field.handleChange(event.target.files?.[0] ?? null)} /></label>}</form.Field>
      {mutation.error ? <div className="notice-box notice-bad">{errorMessage(mutation.error, resolveConsoleMessage(messageResolver, "credit.topup_failed", "Topup failed"))}</div> : null}
      <form.Subscribe selector={(state) => state.values}>{(current) => <div className="drawer-actions"><Button type="button" disabled={!active || saving || !selected || !hasPaymentEvidence(current)} onClick={() => setPurchaseIntent("use")}>Buy and use</Button><Button type="button" variant="secondary" disabled={!active || saving || !selected || !hasPaymentEvidence(current)} onClick={() => setPurchaseIntent("keep")}>Buy</Button></div>}</form.Subscribe>
    </form> : null}
    <Dialog observabilityKey="credit-topup-purchase" open={purchaseIntent !== null} onOpenChange={(open) => { if (!open && !saving) setPurchaseIntent(null); }}>
      <DialogContent>
        <DialogHeader sticky>
          <DialogTitle>{purchaseIntent === "use" ? "Buy and use Credit Card" : "Buy Credit Card"}</DialogTitle>
          <DialogDescription>{purchaseIntent === "use" ? "The purchased Credit Card will be redeemed to this user immediately." : "The purchased Credit Card will remain available for later use."} Credit Cards expire two years after issue.</DialogDescription>
        </DialogHeader>
        {selected ? <div className="detail-list"><div><span>Credit</span><strong data-clarity-mask="true">{formatCredit(selected.creditedAmountUnits)}</strong></div><div><span>Payment</span><strong data-clarity-mask="true">{formatUnits(selected.priceAmountUnits)} {selected.paymentAsset}</strong></div></div> : null}
        <DialogFooter sticky feedback={mutation.error ? <div className="notice-box notice-bad" role="alert">{errorMessage(mutation.error, resolveConsoleMessage(messageResolver, "credit.topup_failed", "Topup failed"))}</div> : null}>
          <DialogClose asChild><Button variant="secondary" disabled={saving}>Cancel</Button></DialogClose>
          <Button disabled={!active || saving || purchaseIntent === null} onClick={() => {
            if (!purchaseIntent || !selected) return;
            const key = purchaseIntent;
            mutation.mutate(toCreateTopupInput(values, key === "use", idempotencyKeys.current[key]));
          }}>{saving ? "Submitting…" : "Confirm purchase"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <MaterialTable
      columns={["Status", "Credit", "Payment", "Reference", "Expires", "Evidence"].map((header) => ({ header }))}
      rows={topups.map((topup) => ({
        id: topup.id,
        cells: [
          <><strong>{topup.status}</strong><code data-clarity-mask="true">{topup.id}</code>{topup.status === "pending_payment" ? <Button size="sm" variant="secondary" disabled={!active || saving} onClick={() => mutation.mutate({ kind: "cancel", topupId: topup.id })}>{active ? "Cancel" : "Preview only"}</Button> : null}</>,
          <span data-clarity-mask="true">{formatCredit(topup.creditedAmountUnits)}</span>,
          <span data-clarity-mask="true">{formatUnits(topup.expectedPaymentAmountUnits)} {topup.paymentAsset}</span>,
          <span data-clarity-mask="true">{topup.transactionReferenceTail ?? "—"}</span>,
          <span data-clarity-mask="true"><BrowserTime value={topup.expiresAt} /></span>,
          <span data-clarity-mask="true">{topup.attachmentCount}</span>,
        ],
      }))}
      emptyState={{ title: "No topup requests yet." }}
    />
    {historyPagination}
    {nextHref ? <div className="row-actions"><Button variant="secondary" asChild><a href={nextHref}>Older topup requests</a></Button></div> : null}
  </div>;
}

export function creditTopupDefaults(listingId = ""): CreditTopupFormValues {
  return { listingId, transactionReference: "", receipt: null };
}

export function hasPaymentEvidence(values: CreditTopupFormValues): boolean {
  return Boolean(values.transactionReference.trim() || values.receipt);
}

export function toCreateTopupInput(
  values: CreditTopupFormValues,
  useImmediately: boolean,
  idempotencyKey: string,
): CreditTopupIntent {
  return {
    kind: "create",
    listingId: values.listingId,
    useImmediately,
    transactionReference: values.transactionReference.trim(),
    receipt: values.receipt,
    idempotencyKey,
  };
}

function formatCredit(units: number): string {
  return `$${formatUnits(units)}`;
}

function formatUnits(units: number): string {
  return (units / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}

function errorMessage(error: unknown, fallback: string): string {
  return consoleErrorMessage(error, fallback);
}
