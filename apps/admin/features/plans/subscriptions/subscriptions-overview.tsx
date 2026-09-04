"use client";

import { useState } from "react";
import Link from "@admin/navigation";
import { useRouter } from "@admin/navigation";
import { useMutation } from "@tanstack/react-query";
import type { PlanBudgetSourceView, PlanSubscription } from "@frely/ui-application/contracts";
import { MaterialTable } from "@frely/console-ui/material-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { BrowserTime, BrowserTimeRange } from "@frely/ui/components/browser-time";
import { AdminDialog, ConsoleDialogFooter, PageHeading, StatusBadge } from "../../../pages/owner/_components/ui";
import { SearchSelect } from "../../../pages/owner/_components/search-select";
import { cancelPlanSubscription, createPlanSubscription } from "../api/plan-api";
import type { SubscriptionSearchState } from "./query";
import { subscriptionsHref } from "./url";
import { RemoteCandidateSelect } from "./remote-candidate-select";
import type { SubscriptionCandidate } from "./api";

export function SubscriptionsOverview({ subscriptions, usage, state, pagination, calculatedAt, sources }: {
  subscriptions: PlanSubscription[];
  usage: PlanBudgetSourceView[];
  state: SubscriptionSearchState;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  calculatedAt: string;
  sources: string[];
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [canceling, setCanceling] = useState<PlanSubscription | null>(null);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({ planTemplateId: "", scopeRef: "", units: "1", paymentMode: "admin_grant", paymentAccountId: "", priority: "10", effectiveStart: "" });
  const [planCandidate, setPlanCandidate] = useState<SubscriptionCandidate | null>(null);
  const createMutation = useMutation({ mutationFn: createPlanSubscription, retry: false });
  const cancelMutation = useMutation({ mutationFn: cancelPlanSubscription, retry: false });
  const usageById = new Map(usage.map((item) => [item.subscriptionId, item]));
  const pending = createMutation.isPending || cancelMutation.isPending;
  return <>
    <PageHeading eyebrow="Plans & Budgets" title="Subscriptions" description="Browse Plan Subscriptions and open one to inspect shared or personal budget usage.">
      <Button type="button" onClick={() => setCreateOpen(true)}>Subscribe Plan</Button>
    </PageHeading>
    {notice ? <div className="notice-box" role="status">{notice}</div> : null}
    <div className="notice-box">Calculated as of <BrowserTime value={calculatedAt} seconds />. Results use the selected page size.</div>
    <Card>
      <form className="request-log-filter-bar" action="/owner/plans/subscriptions">
        {state.pageSize !== 20 ? <input type="hidden" name="pageSize" value={state.pageSize} /> : null}
        <div className="request-log-filter-primary" aria-label="Subscription filters">
          <label className="request-log-filter-field" data-size="model">Subscription ID<Input name="subscriptionId" defaultValue={state.subscriptionId} placeholder="Exact Subscription ID" /></label>
          <label className="request-log-filter-field" data-size="model">Plan ID<Input name="planId" defaultValue={state.planId} placeholder="Exact Plan ID" /></label>
          <label className="request-log-filter-field" data-size="status">Scope type<SearchSelect name="scopeType" defaultValue={state.scopeType} searchable={false} options={[{ value: "", label: "All" }, { value: "global", label: "Global" }, { value: "team", label: "Team" }, { value: "user", label: "User" }]} /></label>
          <label className="request-log-filter-field" data-size="owner">Scope<Input name="scopeRef" defaultValue={state.scopeRef} placeholder="Exact scope ref" /></label>
          <label className="request-log-filter-field" data-size="status">Status<SearchSelect name="status" defaultValue={state.status} searchable={false} options={[{ value: "active", label: "Active" }, { value: "canceled", label: "Canceled" }, { value: "all", label: "All" }]} /></label>
          <label className="request-log-filter-field" data-size="provider">Source<SearchSelect name="source" defaultValue={state.source} options={[{ value: "", label: "All" }, ...sources.map((source) => ({ value: source, label: source }))]} /></label>
          <label className="request-log-filter-field" data-size="duration">Effective<SearchSelect name="effectiveState" defaultValue={state.effectiveState} searchable={false} options={[{ value: "", label: "Any time" }, { value: "current", label: "Current" }, { value: "future", label: "Future" }, { value: "ended", label: "Ended" }]} /></label>
        </div>
        <div className="request-log-filter-actions"><Button type="submit" variant="secondary">Apply</Button><Button asChild variant="ghost"><Link href="/owner/plans/subscriptions">Reset</Link></Button></div>
      </form>
      <MaterialTable
        columns={["Scope / ID", "Plan", "Priority", "Source", "Effective window", "Models", "Shared budget", "Recovery", "Status", "Actions"].map((header) => ({ header }))}
        rows={subscriptions.map((subscription) => {
          const budget = usageById.get(subscription.id);
          return {
            id: subscription.id,
            cells: [
              <><strong>{subscription.scopeRef}</strong><code>{subscription.id}</code></>,
              budget ? `${budget.planName} v${budget.planVersion}` : subscription.planId,
              subscription.priority,
              <code>{subscription.source}</code>,
              <BrowserTimeRange start={subscription.effectiveStart} end={subscription.effectiveEnd} />,
              budget?.applicableModels.join(", ") || <span className="muted">None</span>,
              sharedBudgetSummary(budget),
              recoverySummary(budget),
              <><StatusBadge tone={subscription.subscriptionLifecycle === "active" ? "good" : "neutral"}>{subscription.subscriptionLifecycle}</StatusBadge>{budget ? ` · ${budget.effectiveState}` : null}</>,
              <div className="row-actions"><Button asChild variant="secondary"><Link href={`/owner/plans/subscriptions/${encodeURIComponent(subscription.id)}`}>View details</Link></Button>{canCancel(subscription, calculatedAt) ? <Button type="button" variant="warning" onClick={() => setCanceling(subscription)}>Cancel</Button> : null}</div>
            ]
          };
        })}
        emptyState={{ title: "No Subscriptions", description: "No records match the current filters." }}
        table={{ minWidth: "wide" }}
      />
      <MaterialTablePagination page={pagination.page} pageSize={state.pageSize} totalPages={pagination.totalPages} total={pagination.total} rangeStart={pagination.total ? (pagination.page - 1) * pagination.pageSize + 1 : 0} rangeEnd={Math.min(pagination.page * pagination.pageSize, pagination.total)} previousHref={pagination.page > 1 ? subscriptionsHref(state, { page: pagination.page - 1 }) : ""} nextHref={pagination.page < pagination.totalPages ? subscriptionsHref(state, { page: pagination.page + 1 }) : ""} noun="subscriptions" />
    </Card>
    {createOpen ? <AdminDialog observabilityKey="subscription-list-create" titleId="subscribe-plan-dialog-title" eyebrow="Plan Subscription" title="Subscribe Plan" description="Candidate lists load on demand in pages of 20." onClose={() => !pending && setCreateOpen(false)} closeDisabled={pending}>
      <form onSubmit={(event) => { event.preventDefault(); void create(); }}><div className="form-grid">
        <RemoteCandidateSelect kind="plans" label="Plan" value={draft.planTemplateId} onChange={(value, candidate) => { setDraft((current) => ({ ...current, planTemplateId: value })); setPlanCandidate(candidate); }} />
        <RemoteCandidateSelect kind="scopes" label="Subscriber scope" value={draft.scopeRef} onChange={(value) => setDraft((current) => ({ ...current, scopeRef: value }))} />
        <label>Units<Input type="number" min="1" value={draft.units} onChange={(e) => setDraft((v) => ({ ...v, units: e.target.value }))} /></label>
        <label>Priority<Input type="number" value={draft.priority} onChange={(e) => setDraft((v) => ({ ...v, priority: e.target.value }))} /></label>
        <label>Effective start<Input type="datetime-local" value={draft.effectiveStart} onChange={(e) => setDraft((v) => ({ ...v, effectiveStart: e.target.value }))} /></label>
        <label>Payment<SearchSelect value={draft.paymentMode} searchable={false} options={[{ value: "admin_grant", label: "Admin grant" }, { value: "charge_account", label: "Charge account" }]} onValueChange={(paymentMode) => setDraft((v) => ({ ...v, paymentMode, paymentAccountId: "" }))} /></label>
        {draft.paymentMode === "charge_account" ? <RemoteCandidateSelect kind="accounts" label="Payment account" value={draft.paymentAccountId} onChange={(value) => setDraft((current) => ({ ...current, paymentAccountId: value }))} /> : null}
      </div>{planCandidate ? <div className="notice-box">{planCandidate.billingMode} · ${planCandidate.purchaseAmount ?? 0} per unit · {planCandidate.durationSeconds ?? 0}s</div> : null}
      <ConsoleDialogFooter><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)} disabled={pending}>Cancel</Button><Button type="submit" disabled={pending}>Subscribe</Button></ConsoleDialogFooter></form>
    </AdminDialog> : null}
    {canceling ? <AdminDialog observabilityKey="subscription-list-cancel" titleId="cancel-subscription-dialog-title" eyebrow="Plan Subscription" title="Cancel subscription" description="Stop this subscription immediately while preserving its history." onClose={() => !pending && setCanceling(null)} closeDisabled={pending}><code>{canceling.id}</code><ConsoleDialogFooter><Button type="button" variant="ghost" onClick={() => setCanceling(null)} disabled={pending}>Keep</Button><Button type="button" variant="warning" disabled={pending} onClick={() => void cancel()}>Cancel subscription</Button></ConsoleDialogFooter></AdminDialog> : null}
  </>;

  async function create() {
    try {
      if (!draft.planTemplateId || !draft.scopeRef) throw new Error("Plan and subscriber scope are required.");
      const units = Number(draft.units), priority = Number(draft.priority);
      if (!Number.isInteger(units) || units < 1 || !Number.isFinite(priority)) throw new Error("Units and priority are invalid.");
      if (draft.paymentMode === "charge_account" && !draft.paymentAccountId) throw new Error("Payment account is required.");
      await createMutation.mutateAsync({ planTemplateId: draft.planTemplateId, scopeRef: draft.scopeRef, units, priority, paymentMode: draft.paymentMode, paymentAccountId: draft.paymentMode === "charge_account" ? draft.paymentAccountId : null, ...(draft.effectiveStart ? { effectiveStart: new Date(draft.effectiveStart).toISOString() } : {}) });
      setCreateOpen(false); setNotice("Subscription created."); router.refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Subscribe failed"); }
  }
  async function cancel() {
    if (!canceling) return;
    try { await cancelMutation.mutateAsync(canceling.id); setCanceling(null); setNotice("Subscription canceled."); router.refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Cancel failed"); }
  }
}

function canCancel(subscription: PlanSubscription, at: string) { return subscription.subscriptionLifecycle === "active" && (subscription.effectiveEnd === null || subscription.effectiveEnd > at); }
function sharedBudgetSummary(usage?: PlanBudgetSourceView) {
  const limits = usage?.limits.filter(({ limitScope }) => limitScope === "subscription") ?? [];
  if (!limits.length) return <span className="muted">No shared limits</span>;
  return <div className="model-pair">{limits.map((limit, index) => <span key={index}>{limit.metric}: {limit.usedValue ?? 0} / {limit.limitValue}</span>)}</div>;
}
function recoverySummary(usage?: PlanBudgetSourceView) {
  if (!usage) return "—";
  const reset = usage.limits.flatMap(({ nextResetAt }) => nextResetAt ? [nextResetAt] : []).sort()[0];
  if (reset) return <span>Reset <BrowserTime value={reset} seconds /></span>;
  if (usage.nextPeriodStart) return <span>Next period <BrowserTime value={usage.nextPeriodStart} seconds /></span>;
  return <span className="muted">None scheduled</span>;
}
