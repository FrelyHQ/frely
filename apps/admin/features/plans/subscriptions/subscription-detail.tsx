"use client";

import { useState } from "react";
import Link from "@admin/navigation";
import { useRouter } from "@admin/navigation";
import { useMutation } from "@tanstack/react-query";
import type { PlanBudgetSourceView, PlanSubscription } from "@frely/ui-application/contracts";
import { MaterialTable } from "@frely/console-ui/material-table";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { BrowserTime, BrowserTimeRange } from "@frely/ui/components/browser-time";
import { AdminDialog, ConsoleDialogFooter, PageHeading, StatusBadge } from "../../../pages/owner/_components/ui";
import { cancelPlanSubscription } from "../api/plan-api";
import { RemoteCandidateSelect } from "./remote-candidate-select";

export function SubscriptionDetail({ subscription, usage, calculatedAt, targetUserId }: { subscription: PlanSubscription; usage: PlanBudgetSourceView; calculatedAt: string; targetUserId: string | null }) {
  const router = useRouter();
  const [selectedUserId, setSelectedUserId] = useState(targetUserId ?? "");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const mutation = useMutation({ mutationFn: cancelPlanSubscription, retry: false });
  const canCancel = subscription.subscriptionLifecycle === "active" && (subscription.effectiveEnd === null || subscription.effectiveEnd > calculatedAt);
  return <>
    <PageHeading eyebrow="Plans & Budgets / Subscriptions" title={`${usage.planName} v${usage.planVersion}`} description={subscription.id}>
      <Button asChild variant="secondary"><Link href="/owner/plans/subscriptions">Back to Subscriptions</Link></Button>
      {canCancel ? <Button type="button" variant="warning" onClick={() => setCancelOpen(true)}>Cancel</Button> : null}
    </PageHeading>
    {notice ? <div className="notice-box" role="status">{notice}</div> : null}
    <Card><div className="detail-list">
      <div><span>Subscription</span><code>{subscription.id}</code></div><div><span>Plan</span><code>{subscription.planId}</code></div>
      <div><span>Scope</span><code>{subscription.scopeRef}</code></div><div><span>Priority</span><strong>{subscription.priority}</strong></div>
      <div><span>Source</span><code>{subscription.source}</code></div><div><span>Lifecycle</span><StatusBadge tone={subscription.subscriptionLifecycle === "active" ? "good" : "neutral"}>{subscription.subscriptionLifecycle}</StatusBadge></div>
      <div><span>Effective state</span><strong>{usage.effectiveState}</strong></div><div><span>Effective window</span><BrowserTimeRange start={subscription.effectiveStart} end={subscription.effectiveEnd} /></div>
      <div><span>Purchased by</span><code>{subscription.purchasedByUserId ?? "—"}</code></div><div><span>Funding account</span><code>{subscription.fundingAccountId ?? "—"}</code></div>
      <div><span>Created</span><BrowserTime value={subscription.createdAt} seconds /></div><div><span>Updated</span><BrowserTime value={subscription.updatedAt} seconds /></div>
      <div><span>Calculated</span><BrowserTime value={calculatedAt} seconds /></div><div><span>Models</span><span>{usage.applicableModels.join(", ") || "None"}</span></div>
      <div><span>Next period</span>{usage.nextPeriodStart ? <BrowserTime value={usage.nextPeriodStart} seconds /> : <span>—</span>}</div><div><span>Billing</span><strong>{usage.billingMode}</strong></div>
    </div></Card>
    <Card><h2>Budget usage</h2><p className="muted">Shared limits are always shown. Choose an eligible user to include personal limits.</p>
      <div className="request-log-filter-bar"><RemoteCandidateSelect kind="users" label="Target user" subscriptionId={subscription.id} value={selectedUserId} onChange={(value) => setSelectedUserId(value)} /><div className="request-log-filter-actions"><Button type="button" variant="secondary" onClick={() => router.push(`/owner/plans/subscriptions/${encodeURIComponent(subscription.id)}${selectedUserId ? `?targetUserId=${encodeURIComponent(selectedUserId)}` : ""}`)}>Apply</Button>{targetUserId ? <Button type="button" variant="ghost" onClick={() => router.push(`/owner/plans/subscriptions/${encodeURIComponent(subscription.id)}`)}>Clear</Button> : null}</div></div>
      <MaterialTable
        columns={["Scope", "Metric", "Window", "Used", "Limit", "Remaining", "Next reset"].map((header) => ({ header }))}
        rows={usage.limits.map((limit, index) => ({
          id: `${limit.limitScope}-${limit.metric}-${index}`,
          cells: [
            <>{limit.limitScope}{limit.targetUser ? ` · ${limit.targetUser.label}` : ""}</>,
            limit.metric,
            <>{limit.windowType}{limit.windowSeconds ? ` · ${limit.windowSeconds}s` : ""}</>,
            limit.usedValue ?? "—",
            limit.limitValue,
            limit.remainingValue ?? "—",
            limit.nextResetAt ? <BrowserTime value={limit.nextResetAt} seconds /> : "—"
          ]
        }))}
        emptyState={{ title: "No budget limits." }}
      />
    </Card>
    <Card><h2>Related</h2><div className="row-actions"><Button asChild variant="secondary"><Link href="/owner/plans-and-budgets/plans">Plans</Link></Button><Button asChild variant="secondary"><Link href="/owner/request-logs">Request logs</Link></Button></div></Card>
    {cancelOpen ? <AdminDialog observabilityKey="subscription-detail-cancel" titleId="cancel-subscription-detail-dialog-title" eyebrow="Plan Subscription" title="Cancel subscription" description="Stop this subscription immediately while preserving its history." onClose={() => !mutation.isPending && setCancelOpen(false)} closeDisabled={mutation.isPending}><code>{subscription.id}</code><ConsoleDialogFooter><Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => setCancelOpen(false)}>Keep</Button><Button type="button" variant="warning" disabled={mutation.isPending} onClick={() => void cancel()}>Cancel subscription</Button></ConsoleDialogFooter></AdminDialog> : null}
  </>;
  async function cancel() { try { await mutation.mutateAsync(subscription.id); setCancelOpen(false); setNotice("Subscription canceled."); router.refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : "Cancel failed"); } }
}
