import type { ReactNode } from "react";
import { Card } from "@frely/ui/components/card";
import { BrowserTime, BrowserTimeRange } from "@frely/ui/components/browser-time";
import { MaterialTable } from "./material-table.js";
import { StatusBadge } from "./index.js";

export interface PlanBudgetLimitDisplay {
  key: string;
  limitScope: "subscription" | "user";
  metric: "tokens" | "amount";
  windowType: "fixed" | "cumulative";
  windowSeconds: number | null;
  limitValue: number;
  usedValue: number | null;
  remainingValue: number | null;
  percentUsed: number | null;
  exhausted: boolean | null;
  targetUserLabel?: string | null;
  nextResetAt: string | null;
}

export interface PlanBudgetSourceDisplay {
  key: string;
  subscriptionId?: string;
  planName: string;
  planVersion: number;
  billingMode: "prepaid" | "paygo";
  scopeLabel: string;
  scopeRef?: string;
  lifecycle?: string;
  effectiveState: "current" | "future" | "ended";
  source?: string;
  priority?: number;
  effectiveStart: string;
  effectiveEnd: string | null;
  usageMode: "current" | "at_end" | "not_started";
  usageReferenceAt: string | null;
  applicableModels: string[];
  limits: PlanBudgetLimitDisplay[];
  userLimitCount?: number;
  nextPeriodStart: string | null;
  actions?: ReactNode;
}

export function PlanBudgetSources({ sources, calculatedAt, emptyTitle = "No Plan budget sources." }: { sources: PlanBudgetSourceDisplay[]; calculatedAt: string; emptyTitle?: string }) {
  if (sources.length === 0) return <Card className="panel"><p className="muted">{emptyTitle}</p></Card>;
  return <div className="budget-source-list">
    {sources.map((source) => <PlanBudgetSourceCard key={source.key} source={source} calculatedAt={calculatedAt} />)}
  </div>;
}

export function PlanBudgetCompactSummary({ sources, calculatedAt, action }: { sources: PlanBudgetSourceDisplay[]; calculatedAt: string; action?: ReactNode }) {
  const limits = sources.flatMap((source) => source.limits);
  return <Card className="panel">
    <div className="panel-heading"><div><h2>Plan Budget</h2><p className="muted">{sources.length} current source{sources.length === 1 ? "" : "s"} · {limits.length} visible limit{limits.length === 1 ? "" : "s"} · {limits.filter((limit) => limit.exhausted).length} exhausted</p></div>{action}</div>
    <div className="detail-list">
      {sources.map((source) => <div key={source.key}><span data-clarity-mask="true">{source.scopeLabel}</span><strong data-clarity-mask="true">{source.planName} v{source.planVersion} · {source.limits.filter((limit) => limit.exhausted).length ? "Exhausted" : source.limits.length ? "Within limits" : "No limits"}</strong></div>)}
      <div><span>Calculated as of</span><strong data-clarity-mask="true"><BrowserTime value={calculatedAt} seconds /></strong></div>
    </div>
  </Card>;
}

export function PlanBudgetSourceCard({ source, calculatedAt }: { source: PlanBudgetSourceDisplay; calculatedAt: string }) {
  return <Card className="panel">
    <div className="panel-heading">
      <div>
        <h2 data-clarity-mask="true">{source.planName} v{source.planVersion}</h2>
        <p className="muted"><span data-clarity-mask="true">{source.scopeLabel}</span> · {source.billingMode === "paygo" ? "PayGo" : "Prepaid"}</p>
      </div>
      <div className="row-actions">
        <StatusBadge tone={source.effectiveState === "current" ? "good" : source.effectiveState === "future" ? "info" : "neutral"}>{source.effectiveState}</StatusBadge>
        {source.lifecycle ? <StatusBadge tone={source.lifecycle === "active" ? "good" : "neutral"}>{source.lifecycle}</StatusBadge> : null}
        {source.actions}
      </div>
    </div>
    <div className="detail-list">
      {source.subscriptionId ? <div><span>Subscription</span><code data-clarity-mask="true">{source.subscriptionId}</code></div> : null}
      {source.scopeRef ? <div><span>Scope</span><code data-clarity-mask="true">{source.scopeRef}</code></div> : null}
      {source.source ? <div><span>Source</span><code>{source.source}</code></div> : null}
      {source.priority !== undefined ? <div><span>Priority</span><strong>{source.priority}</strong></div> : null}
      <div><span>Effective window</span><strong data-clarity-mask="true"><BrowserTimeRange start={source.effectiveStart} end={source.effectiveEnd} /></strong></div>
      <div><span>Models</span><strong data-clarity-mask="true">{source.applicableModels.join(", ") || "No exposed models"}</strong></div>
      <div><span>Calculated as of</span><strong data-clarity-mask="true"><BrowserTime value={calculatedAt} seconds /></strong></div>
      {source.effectiveState === "future" ? <div><span>Starts at</span><strong data-clarity-mask="true"><BrowserTime value={source.effectiveStart} seconds /></strong></div> : null}
      {source.effectiveState === "current" && source.effectiveEnd ? <div><span>Current period ends</span><strong data-clarity-mask="true"><BrowserTime value={source.effectiveEnd} seconds /></strong></div> : null}
      {source.effectiveState !== "future" ? <div><span>{source.nextPeriodStart ? "Next period starts" : "Next period"}</span><strong data-clarity-mask={source.nextPeriodStart ? "true" : undefined}>{source.nextPeriodStart ? <BrowserTime value={source.nextPeriodStart} seconds /> : "No scheduled next period"}</strong></div> : null}
      {source.userLimitCount !== undefined ? <div><span>User limit definitions</span><strong>{source.userLimitCount}</strong></div> : null}
    </div>
    <MaterialTable
      columns={["Limit", "Window", "Used", "Remaining", "Reset", "Status"].map((header) => ({ header }))}
      rows={source.limits.map((limit) => ({
        id: limit.key,
        cells: [
          <><strong>{limit.limitScope === "subscription" ? "Shared" : "Personal"}</strong>{limit.targetUserLabel ? <span className="muted" data-clarity-mask="true"> · {limit.targetUserLabel}</span> : null}<div data-clarity-mask="true">{formatMetric(limit.limitValue, limit.metric)}</div></>,
          <span data-clarity-mask="true">{limit.windowType === "fixed" ? formatDuration(limit.windowSeconds) : "Current subscription"}</span>,
          <span data-clarity-mask="true">{limit.usedValue === null ? usageUnavailable(source) : formatMetric(limit.usedValue, limit.metric)}</span>,
          <span data-clarity-mask="true">{source.usageMode === "at_end" ? "Historical — not available" : limit.remainingValue === null ? "—" : formatMetric(limit.remainingValue, limit.metric)}</span>,
          <span data-clarity-mask="true">{resetText(source, limit)}</span>,
          <StatusBadge tone={limit.exhausted ? "bad" : limit.exhausted === false && source.usageMode === "current" ? "good" : "neutral"}>{source.usageMode === "at_end" ? "Usage at end" : limit.exhausted ? "Exhausted" : limit.exhausted === false ? "Within limit" : "Not started"}</StatusBadge>
        ]
      }))}
      emptyState={{ title: "No visible limits for this source." }}
    />
    {source.limits.some((limit) => limit.windowType === "fixed") ? <p className="muted">A fixed reset clears the whole limit window at the shown boundary. It does not guarantee that a future request will fit every applicable limit.</p> : null}
  </Card>;
}

function usageUnavailable(source: PlanBudgetSourceDisplay) {
  return source.usageMode === "not_started" ? (source.effectiveState === "future" ? "Not started" : "Never started") : "—";
}

function resetText(source: PlanBudgetSourceDisplay, limit: PlanBudgetLimitDisplay) {
  if (source.usageMode === "at_end") return "Historical — no reset promised";
  if (source.usageMode === "not_started") return source.effectiveState === "future" ? "Not started" : "Never started";
  if (limit.windowType === "cumulative") return "No reset in this subscription";
  return limit.nextResetAt ? <span>Next <BrowserTime value={limit.nextResetAt} seconds /></span> : "No scheduled reset";
}

function formatMetric(value: number, metric: "tokens" | "amount") {
  if (metric === "tokens") return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)} tokens`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 6 : 2 }).format(value);
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "Fixed";
  if (seconds % 86_400 === 0) return `Fixed ${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `Fixed ${seconds / 3_600}h`;
  return `Fixed ${seconds}s`;
}
