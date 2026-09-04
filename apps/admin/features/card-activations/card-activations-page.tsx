"use client";

import { useState } from "react";
import { useRouter } from "@admin/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MaterialTable } from "@frely/console-ui/material-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { PageHeading, StatusBadge } from "../../pages/owner/_components/ui";
import { SearchSelect } from "../../pages/owner/_components/search-select";
import { RemoteCandidateSelect } from "../plans/subscriptions/remote-candidate-select";
import {
  createCardActivationBatch,
  listCardActivationBatchDetail,
  revokeCardActivationBatch,
  revokeCardActivationCode,
  type CardActivationBatchDetail,
  type CardActivationBatchList,
  type CardActivationType,
} from "./api";

export function CardActivationsPage({ initial }: { initial: CardActivationBatchList }) {
  const router = useRouter();
  const [cardType, setCardType] = useState<CardActivationType>("plan");
  const [planId, setPlanId] = useState("");
  const [creditProductId, setCreditProductId] = useState("");
  const [creditAmountUnits, setCreditAmountUnits] = useState("");
  const [referenceCode, setReferenceCode] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [redeemExpiresAt, setRedeemExpiresAt] = useState(defaultExpiry());
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const detail = useQuery<CardActivationBatchDetail>({
    queryKey: ["card-activation-batch", selectedBatchId, detailPage],
    queryFn: () => listCardActivationBatchDetail(selectedBatchId!, detailPage),
    enabled: Boolean(selectedBatchId),
    retry: false,
  });
  const create = useMutation({ mutationFn: createCardActivationBatch, retry: false, onSuccess: () => router.refresh() });
  const revokeBatch = useMutation({ mutationFn: revokeCardActivationBatch, retry: false, onSuccess: () => router.refresh() });
  const revokeCode = useMutation({ mutationFn: revokeCardActivationCode, retry: false, onSuccess: () => { void detail.refetch(); } });
  const canSubmit = Boolean(referenceCode.trim()) && (cardType === "plan" ? Boolean(planId) : Boolean(creditProductId) && Number(creditAmountUnits) > 0);

  return <>
    <PageHeading eyebrow="Operations" title="Card Activations" description="Issue external bearer codes for pre-sold Plan and Credit Cards. Full codes are available only through the controlled CSV export." />
    <Card className="panel"><div className="panel-heading"><div><h2>Activation stats</h2><p className="muted">Counts are derived from code state; no sales or payment facts are inferred.</p></div></div><div className="metric-grid"><div><strong>{initial.stats.total}</strong><span>Total</span></div><div><strong>{initial.stats.available}</strong><span>Available</span></div><div><strong>{initial.stats.redeemed}</strong><span>Redeemed</span></div><div><strong>{initial.stats.revoked + initial.stats.expired}</strong><span>Unavailable</span></div><div><strong>{(initial.stats.redemptionRate * 100).toFixed(1)}%</strong><span>Redemption rate</span></div></div></Card>
    <Card className="panel"><form onSubmit={(event) => { event.preventDefault(); create.mutate({ referenceCode, cardType, planId: cardType === "plan" ? planId : null, creditProductId: cardType === "credit" ? creditProductId : null, creditAmountUnits: cardType === "credit" ? Number(creditAmountUnits) : null, quantity: Number(quantity), redeemExpiresAt: new Date(redeemExpiresAt).toISOString() }); }}><div className="form-grid">
      <label>Card type<SearchSelect value={cardType} searchable={false} options={[{ value: "plan", label: "Plan" }, { value: "credit", label: "Credit" }]} onValueChange={(value) => { setCardType(value as CardActivationType); setPlanId(""); setCreditProductId(""); }} /></label>
      {cardType === "plan" ? <RemoteCandidateSelect kind="plans" label="Plan" value={planId} onChange={(value) => setPlanId(value)} /> : <RemoteCandidateSelect kind="grant-credit-products" label="Credit Product" value={creditProductId} onChange={(value) => setCreditProductId(value)} />}
      {cardType === "credit" ? <label>Frozen Credit amount<Input type="number" min="1" value={creditAmountUnits} onChange={(event) => setCreditAmountUnits(event.target.value)} /></label> : null}
      <label>Batch reference<Input maxLength={64} value={referenceCode} onChange={(event) => setReferenceCode(event.target.value)} placeholder="partner-campaign-2026" /></label>
      <label>Quantity<Input type="number" min="1" max="10000" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
      <label>Redeem deadline<Input type="datetime-local" value={redeemExpiresAt} onChange={(event) => setRedeemExpiresAt(event.target.value)} /></label>
    </div>{create.error ? <div className="notice-box notice-bad" role="alert">{errorMessage(create.error)}</div> : null}<div className="drawer-actions"><Button type="submit" disabled={!canSubmit || create.isPending}>{create.isPending ? "Creating…" : "Create activation batch"}</Button></div></form></Card>
    <Card className="panel"><div className="panel-heading"><div><h2>Activation batches</h2><p className="muted">Codes show only their suffix and derived state in the console.</p></div></div>{revokeBatch.error || revokeCode.error ? <div className="notice-box notice-bad" role="alert">{errorMessage(revokeBatch.error ?? revokeCode.error)}</div> : null}<MaterialTable
      columns={["Reference", "Type", "Codes", "Deadline", "Actions"].map((header) => ({ header }))}
      rows={initial.items.map((batch) => ({
        id: batch.id,
        cells: [
          <div><Button type="button" variant="ghost" onClick={() => { setSelectedBatchId(batch.id); setDetailPage(1); }}>{batch.referenceCode}</Button><div className="muted">{batch.id}</div></div>,
          <StatusBadge tone="info">{batch.cardType}</StatusBadge>,
          `${batch.stats.available} available · ${batch.stats.redeemed} redeemed · ${batch.stats.revoked + batch.stats.expired} unavailable`,
          <BrowserTime value={batch.redeemExpiresAt} />,
          <div className="row-actions"><a href={`/api/owner/card-activation-batches/${encodeURIComponent(batch.id)}/export`} onClick={(event) => { if (!window.confirm("This download contains bearer secrets. Store it securely and do not share it publicly. Continue?")) event.preventDefault(); }}>Export CSV</a>{!batch.revokedAt ? <Button size="sm" variant="warning" onClick={() => { if (window.confirm("Revoke all unredeemed codes in this batch? Redeemed Cards will remain active.")) revokeBatch.mutate(batch.id); }} disabled={revokeBatch.isPending}>Revoke batch</Button> : <StatusBadge tone="bad">Revoked</StatusBadge>}</div>,
        ],
      }))}
      emptyState={{ title: "No Card Activation batches." }}
      table={{ minWidth: "wide" }}
    /><MaterialTablePagination page={initial.page} pageSize={initial.pageSize} total={initial.total} totalPages={initial.totalPages} noun="batches" previousHref={initial.page > 1 ? `?page=${initial.page - 1}` : ""} nextHref={initial.page < initial.totalPages ? `?page=${initial.page + 1}` : ""} /></Card>
    {detail.data ? <Card className="panel"><div className="panel-heading"><div><h2>Code status · {detail.data.batch.referenceCode}</h2><p className="muted">Only suffixes are rendered. Use the export flow for complete codes.</p></div></div><MaterialTable
      columns={["Ordinal", "Suffix", "Status", "Action"].map((header) => ({ header }))}
      rows={detail.data.codes.map((code) => ({
        id: code.id,
        cells: [code.ordinal, <code>…{code.codeSuffix}</code>, <StatusBadge tone={code.status === "available" ? "good" : code.status === "redeemed" ? "neutral" : "bad"}>{code.status}</StatusBadge>, code.status === "available" ? <Button size="sm" variant="warning" onClick={() => { if (window.confirm("Revoke this unredeemed code? This cannot be undone.")) revokeCode.mutate(code.id); }} disabled={revokeCode.isPending}>Revoke code</Button> : "—"],
      }))}
      emptyState={{ title: "No activation codes in this batch." }}
      table={{ minWidth: "normal" }}
    /><MaterialTablePagination page={detail.data.page} pageSize={detail.data.pageSize} total={detail.data.totalCodes} totalPages={detail.data.totalPages} noun="codes" onPrevious={() => setDetailPage(detail.data.page - 1)} onNext={() => setDetailPage(detail.data.page + 1)} /></Card> : null}
  </>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Card Activation operation failed";
}

function defaultExpiry(): string {
  const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
