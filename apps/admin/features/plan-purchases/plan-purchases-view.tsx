"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "@admin/navigation";
import { useMutation } from "@tanstack/react-query";
import { MaterialTable } from "@frely/console-ui/material-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { Button } from "@frely/ui/components/button";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { Card, CardContent, CardHeader, CardTitle } from "@frely/ui/components/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@frely/ui/components/dialog";
import { Input } from "@frely/ui/components/input";
import { PageHeading, StatusBadge } from "../../pages/owner/_components/ui";
import { SearchSelect } from "../../pages/owner/_components/search-select";
import type { OwnerPlanPurchaseOrder } from "../../lib/plan-purchase";
import { createPlanPaymentListing, disablePlanPaymentListing, fetchPlanPurchaseOrderDetail, reversePlanPurchaseOrder } from "./api";

interface ListingRow {
  id: string;
  planId: string;
  paymentChannelId: string;
  priceAmountUnits: number;
  status: "enabled" | "disabled";
  createdAt: string;
  paymentAsset: string;
  paymentNetwork: string;
  settlementMode: string;
  channelDisplayName: string;
  planName: string;
  planVersion: number;
}

interface PageResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface FilterState {
  status: string;
  buyerUserId: string;
  planId: string;
  currency: string;
  listingPageSize: number;
  orderPageSize: number;
}

export function PlanPurchasesView({
  listings,
  orders,
  filters
}: {
  listings: PageResult<ListingRow>;
  orders: PageResult<OwnerPlanPurchaseOrder>;
  filters: FilterState;
}) {
  const router = useRouter();
  const [planId, setPlanId] = useState("");
  const [paymentChannelId, setPaymentChannelId] = useState("");
  const [price, setPrice] = useState("");
  const [notice, setNotice] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof fetchPlanPurchaseOrderDetail>> | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const createMutation = useMutation({ mutationFn: createPlanPaymentListing, retry: false });
  const disableMutation = useMutation({ mutationFn: disablePlanPaymentListing, retry: false });
  const reverseMutation = useMutation({ mutationFn: reversePlanPurchaseOrder, retry: false });

  return (
    <>
      <PageHeading eyebrow="Plans & Budgets / Commerce" title="Plan payments" description="Configure immutable Stripe Plan prices and inspect unified balance/Stripe purchase orders.">
        <StatusBadge tone="info">Stripe + balance</StatusBadge>
      </PageHeading>
      {notice ? <div className={`notice-box${notice.tone === "bad" ? " notice-bad" : ""}`} role={notice.tone === "bad" ? "alert" : "status"}>{notice.text}</div> : null}
      <Card>
        <CardHeader><CardTitle>Create Stripe Plan listing</CardTitle></CardHeader>
        <CardContent>
          <form className="directory-tools" onSubmit={submitListing}>
            <Input aria-label="Plan ID" placeholder="Plan ID" value={planId} onChange={(event) => setPlanId(event.target.value)} />
            <Input aria-label="Payment Channel ID" placeholder="Stripe Payment Channel ID" value={paymentChannelId} onChange={(event) => setPaymentChannelId(event.target.value)} />
            <Input aria-label="Price in channel currency" placeholder="Price in major units, e.g. 88 or 88.50" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
            <Button type="submit" disabled={createMutation.isPending}>Create listing</Button>
          </form>
          <p>Currency comes from the Payment Channel. Creating a replacement price disables the prior enabled Listing; historical orders keep their frozen price.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Plan payment listings</CardTitle></CardHeader>
        <CardContent>
          <MaterialTable
            columns={["Plan", "Channel", "Price", "Status", "Created", "Action"].map((header) => ({ header }))}
            rows={listings.items.map((listing) => ({
              id: listing.id,
              cells: [
                <>{listing.planName} v{listing.planVersion}<br /><small>{listing.planId}</small></>,
                <>{listing.channelDisplayName}<br /><small>{listing.paymentChannelId}</small></>,
                formatUnits(listing.priceAmountUnits, listing.paymentAsset),
                <StatusBadge tone={listing.status === "enabled" ? "good" : "neutral"}>{listing.status}</StatusBadge>,
                <BrowserTime value={listing.createdAt} />,
                <Button size="sm" variant="secondary" disabled={listing.status !== "enabled" || disableMutation.isPending} onClick={() => disableListing(listing.id)}>Disable</Button>
              ]
            }))}
            emptyState={{ title: "No Plan payment listings" }}
            table={{ minWidth: "wide" }}
          />
          <MaterialTablePagination page={listings.page} pageSize={listings.pageSize} total={listings.total} totalPages={listings.totalPages} pageParam="listingPage" pageSizeParam="listingPageSize" noun="listings" previousHref={listings.page > 1 ? commerceHref(filters, listings.page - 1, orders.page) : ""} nextHref={listings.page < listings.totalPages ? commerceHref(filters, listings.page + 1, orders.page) : ""} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Plan purchase orders</CardTitle></CardHeader>
        <CardContent>
          <form className="directory-tools" action="/owner/plans-and-budgets/plan-purchases">
            {filters.listingPageSize !== 20 ? <input type="hidden" name="listingPageSize" value={filters.listingPageSize} /> : null}
            {filters.orderPageSize !== 20 ? <input type="hidden" name="orderPageSize" value={filters.orderPageSize} /> : null}
            <Input name="buyerUserId" aria-label="Buyer user ID" placeholder="Buyer user ID" defaultValue={filters.buyerUserId} />
            <Input name="planId" aria-label="Order Plan ID" placeholder="Plan ID" defaultValue={filters.planId} />
            <Input name="currency" aria-label="Currency" placeholder="Currency" defaultValue={filters.currency} />
            <SearchSelect name="status" ariaLabel="Order status" defaultValue={filters.status} searchable={false} options={[
              { value: "", label: "All statuses" },
              ...["pending_payment", "fulfilled", "payment_failed", "cancelled", "expired", "reversed"].map((status) => ({ value: status, label: status }))
            ]} />
            <Button type="submit" variant="secondary">Filter</Button>
          </form>
          <MaterialTable
            columns={["Order", "Buyer / Plan", "Payment", "Status", "Fulfillment", "Actions"].map((header) => ({ header }))}
            rows={orders.items.map((order) => ({
              id: order.orderId,
              cells: [
                <>{order.orderId}<br /><small><BrowserTime value={order.createdAt} /></small></>,
                <>{order.buyerUserId}<br /><small>{order.planId}</small></>,
                <>{formatUnits(order.expectedPaymentAmountUnits, order.paymentAsset)}<br /><small>{order.paymentKind}</small></>,
                <StatusBadge tone={order.status === "fulfilled" ? "good" : order.status === "pending_payment" ? "info" : "neutral"}>{order.status}</StatusBadge>,
                order.subscriptionId ?? order.cardId ?? "Pending",
                <div className="row-actions">
                  <Button size="sm" variant="secondary" onClick={() => showDetail(order.orderId)}>Details</Button>
                  <Button size="sm" variant="destructive" disabled={order.status !== "fulfilled" || order.paymentKind !== "payment_listing" || order.paymentNetwork !== "stripe" || reverseMutation.isPending} onClick={() => reverseOrder(order.orderId)}>Reverse</Button>
                </div>
              ]
            }))}
            emptyState={{ title: "No Plan purchase orders" }}
            table={{ minWidth: "wide" }}
          />
          <MaterialTablePagination page={orders.page} pageSize={orders.pageSize} total={orders.total} totalPages={orders.totalPages} pageParam="orderPage" pageSizeParam="orderPageSize" noun="orders" previousHref={orders.page > 1 ? commerceHref(filters, listings.page, orders.page - 1) : ""} nextHref={orders.page < orders.totalPages ? commerceHref(filters, listings.page, orders.page + 1) : ""} />
        </CardContent>
      </Card>

      <Dialog observabilityKey="plan-purchase-detail" open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Plan purchase detail</DialogTitle><DialogDescription>External identifiers are shown only as non-secret tails.</DialogDescription></DialogHeader>
          {detail ? <div className="detail-list">
            <div><span>Order</span><strong>{detail.order.orderId}</strong></div>
            <div><span>Buyer</span><strong>{detail.buyer?.email ?? detail.order.buyerUserId}</strong></div>
            <div><span>Plan</span><strong>{detail.plan ? `${detail.plan.name} v${detail.plan.version}` : detail.order.planId}</strong></div>
            <div><span>Payment</span><strong>{formatUnits(detail.order.expectedPaymentAmountUnits, detail.order.paymentAsset)}</strong></div>
            <div><span>Canonical seller amount</span><strong>{formatUnits(detail.order.canonicalPurchaseAmountUnits, "USD")}</strong></div>
            <div><span>Stripe tails</span><strong>{detail.order.checkoutSessionTail ?? "—"} / {detail.order.paymentIntentTail ?? "—"}</strong></div>
            <div><span>Card / Subscription</span><strong>{detail.order.cardId ?? "—"} / {detail.order.subscriptionId ?? "—"}</strong></div>
            <div><span>Status</span><strong>{detail.order.status}</strong></div>
          </div> : <p>Loading…</p>}
          <DialogFooter><Button variant="secondary" onClick={() => setDetailOpen(false)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  async function submitListing(event: FormEvent) {
    event.preventDefault();
    const major = Number(price);
    if (!planId.trim() || !paymentChannelId.trim() || !Number.isFinite(major) || major <= 0) {
      setNotice({ tone: "bad", text: "Plan ID, Payment Channel ID, and a positive price are required." });
      return;
    }
    try {
      const created = await createMutation.mutateAsync({ planId: planId.trim(), paymentChannelId: paymentChannelId.trim(), priceAmountUnits: Math.round(major * 1_000_000) });
      setNotice({ tone: "good", text: `Created Listing ${created.id}.` });
      setPrice("");
      router.refresh();
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "Create Listing failed." });
    }
  }

  async function disableListing(listingId: string) {
    try {
      await disableMutation.mutateAsync(listingId);
      setNotice({ tone: "good", text: `Disabled Listing ${listingId}.` });
      router.refresh();
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "Disable Listing failed." });
    }
  }

  async function reverseOrder(orderId: string) {
    if (!window.confirm("Confirm the full refund or dispute outcome in Stripe first. Reverse entitlement locally without reversing Seller revenue?")) return;
    const reason = window.prompt("Reason for the irreversible local Reverse:");
    if (!reason?.trim()) return;
    try {
      const result = await reverseMutation.mutateAsync({ orderId, reason: reason.trim() });
      setNotice({ tone: "good", text: result.replayed ? `Order ${orderId} was already reversed.` : `Reversed order ${orderId}.` });
      router.refresh();
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "Reverse failed." });
    }
  }

  async function showDetail(orderId: string) {
    setDetail(null);
    setDetailOpen(true);
    try {
      setDetail(await fetchPlanPurchaseOrderDetail(orderId));
    } catch (error) {
      setDetailOpen(false);
      setNotice({ tone: "bad", text: error instanceof Error ? error.message : "Load detail failed." });
    }
  }
}

function commerceHref(filters: FilterState, listingPage: number, orderPage: number) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.buyerUserId) params.set("buyerUserId", filters.buyerUserId);
  if (filters.planId) params.set("planId", filters.planId);
  if (filters.currency) params.set("currency", filters.currency);
  if (listingPage > 1) params.set("listingPage", String(listingPage));
  if (filters.listingPageSize !== 20) params.set("listingPageSize", String(filters.listingPageSize));
  if (orderPage > 1) params.set("orderPage", String(orderPage));
  if (filters.orderPageSize !== 20) params.set("orderPageSize", String(filters.orderPageSize));
  return `/owner/plans-and-budgets/plan-purchases${params.size ? `?${params}` : ""}`;
}

function formatUnits(units: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(units / 1_000_000);
  } catch {
    return `${currency} ${units / 1_000_000}`;
  }
}
