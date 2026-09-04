"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "@web/navigation";
import { Button } from "@frely/ui/components/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@frely/ui/components/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@frely/ui/components/dialog";
import { useMutation } from "@tanstack/react-query";
import { cardExpirationPurchaseNotice } from "../../../lib/card-purchase-ui";
import { cancelPlanPurchaseOrder, fetchPlanPurchaseOrder, purchasePlan } from "../api/plan-store-api";
import type { PlanPaymentListing, PlanProduct, PlanPurchaseOrderStatus } from "../types";

interface PurchaseIntent {
  plan: PlanProduct;
  useImmediately: boolean;
  idempotencyKey: string;
  paymentChoice: "credit_balance" | string;
}

export function PlanStore({
  plans,
  creditBalanceUnits,
  returnOrderId,
  returnCancelled
}: {
  plans: PlanProduct[];
  creditBalanceUnits: number;
  returnOrderId?: string | null;
  returnCancelled?: boolean;
}) {
  const router = useRouter();
  const [purchaseIntent, setPurchaseIntent] = useState<PurchaseIntent | null>(null);
  const [notice, setNotice] = useState<{ tone: "good" | "bad" | "info"; text: string } | null>(null);
  const [returnStatus, setReturnStatus] = useState<PlanPurchaseOrderStatus | null>(null);
  const mutation = useMutation({
    mutationFn: purchasePlan,
    retry: false,
    onSuccess: (result, input) => {
      if (result.kind === "stripe_checkout") {
        window.localStorage.setItem("friday-relay:plan-purchase-order", result.orderId);
        window.location.assign(result.checkoutUrl);
        return;
      }
      setPurchaseIntent(null);
      setNotice({ tone: "good", text: input.useImmediately ? `${input.planName} purchased and activated.` : `${input.planName} Card added to My Cards.` });
      router.refresh();
    }
  });
  const savingPlanId = mutation.isPending ? mutation.variables.planId : null;
  const selectedListing = useMemo(() => purchaseIntent?.plan.paymentListings.find((listing) => listing.id === purchaseIntent.paymentChoice) ?? null, [purchaseIntent]);
  const balanceSufficient = purchaseIntent ? creditBalanceUnits >= Math.round(purchaseIntent.plan.purchaseAmount * 1_000_000) : false;

  useEffect(() => {
    if (!returnOrderId) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let cancellationAttempted = false;
    const controller = new AbortController();
    const poll = async () => {
      try {
        if (returnCancelled && !cancellationAttempted) {
          cancellationAttempted = true;
          try {
            const order = await cancelPlanPurchaseOrder(returnOrderId);
            if (cancelled) return;
            setReturnStatus(order);
            if (order.status === "cancelled") {
              window.localStorage.removeItem("friday-relay:plan-purchase-order");
              setNotice({ tone: "bad", text: terminalStatusMessage(order.status) });
              return;
            }
          } catch {
            // A completion webhook may have won the race; the local status query below is authoritative.
          }
        }
        const order = await fetchPlanPurchaseOrder(returnOrderId, controller.signal);
        if (cancelled) return;
        setReturnStatus(order);
        if (order.status === "fulfilled") {
          window.localStorage.removeItem("friday-relay:plan-purchase-order");
          setNotice({ tone: "good", text: order.useImmediately ? "Stripe payment completed and the Plan is active." : "Stripe payment completed and the Plan Card is available." });
          router.refresh();
          return;
        }
        if (order.status !== "pending_payment") {
          setNotice({ tone: "bad", text: terminalStatusMessage(order.status) });
          return;
        }
        attempts += 1;
        if (attempts < 10) timeout = setTimeout(poll, 1_500);
      } catch (error) {
        if (!cancelled) setNotice({ tone: "bad", text: error instanceof Error ? error.message : "Could not load Plan purchase status." });
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [returnCancelled, returnOrderId, router]);

  if (plans.length === 0) return <Card><CardHeader><CardTitle>No prepaid Plans available</CardTitle><CardDescription>Enabled Plan products will appear here.</CardDescription></CardHeader></Card>;

  return (
    <>
      {returnOrderId && (!returnStatus || returnStatus.status === "pending_payment") ? <div className="notice-box" role="status">Payment received or still in progress. Waiting for Stripe verification…</div> : null}
      {mutation.error ? <div className="notice-box notice-bad" role="alert" data-clarity-mask="true">{mutation.error instanceof Error ? mutation.error.message : "Plan purchase failed"}</div> : null}
      {notice ? <div className={`notice-box${notice.tone === "bad" ? " notice-bad" : ""}`} role={notice.tone === "bad" ? "alert" : "status"} data-clarity-mask="true">{notice.text}</div> : null}
      <section className="card-grid" aria-label="Plan products">
        {plans.map((plan) => (
          <Card key={plan.id}>
            <CardHeader>
              <CardTitle>{plan.name}</CardTitle>
              <CardDescription>{plan.description ?? `Plan version ${plan.version}`}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="detail-list">
                <div><span>Balance price</span><strong data-clarity-mask="true">{formatCurrency(plan.purchaseAmount, "USD")}</strong></div>
                <div><span>Stripe prices</span><strong data-clarity-mask="true">{plan.paymentListings.length > 0 ? plan.paymentListings.map((listing) => formatUnits(listing.priceAmountUnits, listing.paymentAsset)).join(" / ") : "Not configured"}</strong></div>
                <div><span>Duration</span><strong>{formatDuration(plan.durationSeconds)}</strong></div>
                <div><span>AccessPoints</span><strong>{plan.accessPointCount}</strong></div>
              </div>
            </CardContent>
            <CardFooter className="card-actions">
              <Button disabled={savingPlanId !== null} onClick={() => beginPurchase(plan, true)}>{savingPlanId === plan.id ? "Purchasing…" : "Buy and use"}</Button>
              <Button variant="secondary" disabled={savingPlanId !== null} onClick={() => beginPurchase(plan, false)}>Buy</Button>
            </CardFooter>
          </Card>
        ))}
      </section>
      <Dialog observabilityKey="plan-card-purchase" open={purchaseIntent !== null} onOpenChange={(open) => { if (!open && savingPlanId === null) setPurchaseIntent(null); }}>
        <DialogContent>
          <DialogHeader sticky>
            <DialogTitle>{purchaseIntent?.useImmediately ? "Buy and use Plan Card" : "Buy Plan Card"}</DialogTitle>
            <DialogDescription>{cardExpirationPurchaseNotice}。</DialogDescription>
          </DialogHeader>
          {purchaseIntent ? (
            <>
              <div className="detail-list">
                <div><span>Plan</span><strong data-clarity-mask="true">{purchaseIntent.plan.name}</strong></div>
                <div><span>Fulfillment</span><strong>{purchaseIntent.useImmediately ? "Activate after verified payment" : "Add an available Card"}</strong></div>
              </div>
              <fieldset>
                <legend>Payment method</legend>
                <label>
                  <input
                    type="radio"
                    name="plan-payment"
                    value="credit_balance"
                    checked={purchaseIntent.paymentChoice === "credit_balance"}
                    onChange={() => setPurchaseIntent((current) => current ? { ...current, paymentChoice: "credit_balance" } : current)}
                  />
                  {" "}Credit balance — <span data-clarity-mask="true">{formatUnits(creditBalanceUnits, "USD")} available; {formatCurrency(purchaseIntent.plan.purchaseAmount, "USD")} due</span>
                  {!balanceSufficient ? " (insufficient)" : ""}
                </label>
                {purchaseIntent.plan.paymentListings.map((listing) => (
                  <label key={listing.id}>
                    <input
                      type="radio"
                      name="plan-payment"
                      value={listing.id}
                      checked={purchaseIntent.paymentChoice === listing.id}
                      onChange={() => setPurchaseIntent((current) => current ? { ...current, paymentChoice: listing.id } : current)}
                    />
                    {" "}{listing.channelDisplayName} — <span data-clarity-mask="true">{formatUnits(listing.priceAmountUnits, listing.paymentAsset)}</span>
                  </label>
                ))}
              </fieldset>
            </>
          ) : null}
          <DialogFooter sticky feedback={mutation.error ? <div className="notice-box notice-bad" role="alert" data-clarity-mask="true">{mutation.error instanceof Error ? mutation.error.message : "Plan purchase failed"}</div> : null}>
            <DialogClose asChild><Button variant="secondary" disabled={savingPlanId !== null}>Cancel</Button></DialogClose>
            <Button disabled={!purchaseIntent || savingPlanId !== null || (purchaseIntent.paymentChoice === "credit_balance" && !balanceSufficient)} onClick={confirmPurchase}>
              {savingPlanId ? "Purchasing…" : selectedListing ? "Continue to Stripe" : "Confirm purchase"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  function beginPurchase(plan: PlanProduct, useImmediately: boolean) {
    mutation.reset();
    setNotice(null);
    setPurchaseIntent({ plan, useImmediately, idempotencyKey: crypto.randomUUID(), paymentChoice: "credit_balance" });
  }

  function confirmPurchase() {
    if (!purchaseIntent) return;
    const listing = purchaseIntent.plan.paymentListings.find((item) => item.id === purchaseIntent.paymentChoice);
    mutation.mutate({
      planId: purchaseIntent.plan.id,
      planName: purchaseIntent.plan.name,
      useImmediately: purchaseIntent.useImmediately,
      idempotencyKey: purchaseIntent.idempotencyKey,
      payment: listing ? { kind: "payment_listing", listingId: listing.id } : { kind: "credit_balance" }
    });
  }
}

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function formatUnits(units: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(units / 1_000_000);
  } catch {
    return `${currency} ${(units / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
}

function formatDuration(seconds: number) {
  const days = seconds / 86_400;
  return Number.isInteger(days) ? `${days} day${days === 1 ? "" : "s"}` : `${seconds} seconds`;
}

function terminalStatusMessage(status: PlanPurchaseOrderStatus["status"]) {
  if (status === "payment_failed") return "Stripe reported that the payment failed.";
  if (status === "cancelled") return "The Stripe Checkout was cancelled.";
  if (status === "expired") return "The Stripe Checkout expired before payment completed.";
  if (status === "reversed") return "This Plan purchase was reversed by the Platform Owner.";
  return "The Plan purchase did not complete.";
}
