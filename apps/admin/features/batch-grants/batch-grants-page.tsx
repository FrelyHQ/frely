"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { MaterialTable } from "@frely/console-ui/material-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { Textarea } from "@frely/ui/components/textarea";
import { PageHeading, StatusBadge } from "../../pages/owner/_components/ui";
import { SearchSelect } from "../../pages/owner/_components/search-select";
import { RemoteCandidateSelect } from "../plans/subscriptions/remote-candidate-select";
import { createGrantBatch, type GrantActionType, type GrantBatchDetail } from "./api";

export function BatchGrantsPage({ detail }: { detail?: GrantBatchDetail }) {
  const [actionType, setActionType] = useState<GrantActionType>("subscription");
  const [planId, setPlanId] = useState("");
  const [planBillingMode, setPlanBillingMode] = useState<"prepaid" | "paygo" | undefined>();
  const [creditProductId, setCreditProductId] = useState("");
  const [candidateUserId, setCandidateUserId] = useState("");
  const [targetUserIds, setTargetUserIds] = useState<string[]>([]);
  const [pastedIds, setPastedIds] = useState("");
  const [referenceCode, setReferenceCode] = useState("");
  const [note, setNote] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [fallbackToPlanCard, setFallbackToPlanCard] = useState(true);
  const mutation = useMutation({ mutationFn: createGrantBatch, retry: false });
  const isCard = actionType !== "subscription";
  const canSubmit = targetUserIds.length > 0 && Boolean(referenceCode.trim()) && (actionType === "credit_card" ? Boolean(creditProductId) : Boolean(planId) && !(planBillingMode === "paygo" && (actionType === "plan_card" || fallbackToPlanCard)));

  return <>
    <PageHeading eyebrow="Operations" title="Batch Grants" description="Create immediate user subscriptions or issue Plan and Credit Cards in a tracked batch." />
    <Card className="panel">
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="form-grid">
          <label>Action<SearchSelect value={actionType} searchable={false} options={[{ value: "subscription", label: "Batch subscription" }, { value: "plan_card", label: "Issue Plan Cards" }, { value: "credit_card", label: "Issue Credit Cards" }]} onValueChange={(value) => { setActionType(value as GrantActionType); setPlanId(""); setPlanBillingMode(undefined); setCreditProductId(""); }} /></label>
          {actionType === "credit_card" ? <RemoteCandidateSelect kind="grant-credit-products" label="Credit Product" value={creditProductId} onChange={(value) => setCreditProductId(value)} /> : <RemoteCandidateSelect kind="plans" label="Plan" value={planId} onChange={(value, candidate) => { setPlanId(value); setPlanBillingMode(candidate?.billingMode); if (candidate?.billingMode === "paygo") setFallbackToPlanCard(false); }} />}
          <label>Activity reference<Input maxLength={100} value={referenceCode} onChange={(event) => setReferenceCode(event.target.value)} placeholder="campaign-2026-summer" /></label>
          {isCard ? <label>Expiration time<Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label> : null}
          {actionType === "subscription" ? <label className="inline-actions"><input type="checkbox" checked={fallbackToPlanCard} onChange={(event) => setFallbackToPlanCard(event.target.checked)} /> Issue a Plan Card when the user already has this Plan subscription</label> : null}
          <label className="form-grid-span-2">Recipient message (optional)<Textarea maxLength={500} rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        </div>
        {planBillingMode === "paygo" && (actionType === "plan_card" || fallbackToPlanCard) ? <div className="notice-box notice-bad">Plan Cards require a prepaid Plan. Select a prepaid Plan or turn off the existing-subscription fallback.</div> : null}
        <div className="notice-box">Select enabled users one at a time, or paste up to 500 existing user IDs separated by commas, spaces, or new lines. Duplicates are removed before submission.</div>
        <div className="form-grid">
          <RemoteCandidateSelect kind="grant-users" label="Add user" value={candidateUserId} onChange={(value) => setCandidateUserId(value)} />
          <div className="drawer-actions"><Button type="button" variant="secondary" disabled={!candidateUserId} onClick={() => { setTargetUserIds((current) => [...new Set([...current, candidateUserId])]); setCandidateUserId(""); }}>Add selected user</Button></div>
          <label className="form-grid-span-2">Paste user IDs<Textarea rows={3} value={pastedIds} onChange={(event) => setPastedIds(event.target.value)} placeholder="user_…&#10;user_…" /></label>
        </div>
        <div className="drawer-actions"><Button type="button" variant="secondary" onClick={() => { const ids = pastedIds.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean); setTargetUserIds((current) => [...new Set([...current, ...ids])]); setPastedIds(""); }} disabled={!pastedIds.trim()}>Add pasted users</Button><span>{targetUserIds.length} selected</span></div>
        {targetUserIds.length ? <div className="notice-box">{targetUserIds.map((id) => <Button key={id} type="button" size="sm" variant="ghost" onClick={() => setTargetUserIds((current) => current.filter((value) => value !== id))}>{id} ×</Button>)}</div> : null}
        {mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Create batch grant failed"}</div> : null}
        <div className="drawer-actions"><Button type="submit" disabled={!canSubmit || mutation.isPending}>{mutation.isPending ? "Creating…" : "Create batch"}</Button></div>
      </form>
    </Card>
    {detail ? <GrantBatchResult detail={detail} /> : null}
  </>;

  async function submit() {
    const result = await mutation.mutateAsync({ actionType, targetUserIds, ...(planId ? { planId } : {}), ...(creditProductId ? { creditProductId } : {}), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}), referenceCode: referenceCode.trim(), ...(note ? { note } : {}), fallbackToPlanCard });
    window.location.assign(`/owner/operations/grants?batchId=${encodeURIComponent(result.batch.id)}`);
  }
}

function GrantBatchResult({ detail }: { detail: GrantBatchDetail }) {
  const skipped = detail.items.filter((item) => item.outcome === "skipped");
  return <Card className="panel">
    <div className="panel-heading"><div><h2>Batch results</h2><p className="muted">{detail.batch.id} · {detail.total} recipients · page {detail.page} of {detail.totalPages}</p></div></div>
    {skipped.length ? <div className="notice-box notice-warn">Skipped users on this page: {skipped.map((item) => item.targetEmail).join(", ")}</div> : null}
    <MaterialTable columns={["User", "Outcome", "Reason", "Created resource"].map((header) => ({ header }))} rows={detail.items.map((item) => ({ id: item.id, cells: [<><strong>{item.targetEmail}</strong><code>{item.targetUserId}</code></>, <StatusBadge tone={item.outcome === "success" ? "good" : item.outcome === "skipped" ? "neutral" : "bad"}>{item.outcome}</StatusBadge>, item.reasonCode ?? "—", item.cardId ?? item.subscriptionId ?? "—"] }))} emptyState={{ title: "No result items", description: "This batch has no recipients." }} table={{ minWidth: "normal" }} />
    <MaterialTablePagination
      page={detail.page}
      pageSize={detail.pageSize}
      total={detail.total}
      totalPages={detail.totalPages}
      previousHref={detail.page > 1 ? batchHref(detail.batch.id, detail.page - 1, detail.pageSize) : ""}
      nextHref={detail.page < detail.totalPages ? batchHref(detail.batch.id, detail.page + 1, detail.pageSize) : ""}
      noun="batch recipients"
    />
  </Card>;
}

function batchHref(batchId: string, page: number, pageSize: number) {
  const params = new URLSearchParams({ batchId });
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 20) params.set("pageSize", String(pageSize));
  return `/owner/operations/grants?${params}`;
}
