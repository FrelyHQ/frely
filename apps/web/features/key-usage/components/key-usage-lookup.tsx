"use client";

import React, { useState } from "react";
import { MetricCard, ProgressBar, StatusBadge } from "@frely/console-ui";
import { Button } from "@frely/ui/components/button";
import { Input } from "@frely/ui/components/input";
import { useMutation } from "@tanstack/react-query";
import { lookupKeyUsage, type BudgetLimit, type BudgetOrigin, type BudgetSource } from "../api/key-usage-api";

export function KeyUsageLookup({ currentUser }: { currentUser: { id: string; email: string } | null }) {
  const [apiKey, setApiKey] = useState("");
  const mutation = useMutation({ mutationFn: lookupKeyUsage, retry: false, gcTime: 0 });
  const result = mutation.data;
  return <div className="key-usage-layout"><div className="key-usage-main">
    <form className="panel key-usage-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(apiKey); }}><div className="panel-heading"><div><h2>Lookup</h2><p className="muted">Enter an API key to review its usage and remaining allowance.</p></div><StatusBadge tone="info">Self service</StatusBadge></div><div className="form-grid compact-form-grid">{currentUser ? <div className="detail-list key-usage-account"><div><span>Signed-in account</span><strong>{currentUser.email}</strong></div></div> : null}<label>Secret Key<Input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." type="password" autoComplete="off" disabled={mutation.isPending} required /><span>The key is sent only as a Bearer header for this lookup.</span></label></div><div className="drawer-actions"><Button type="submit" disabled={mutation.isPending || !apiKey.trim()}>{mutation.isPending ? "Checking..." : "Check Usage"}</Button></div></form>
    {mutation.error ? <div className="notice-box notice-bad" role="alert">{mutation.error instanceof Error ? mutation.error.message : "Usage lookup failed"}</div> : null}
    {result ? <><div className="summary-row key-usage-summary"><MetricCard label="Usage sources" value={formatInteger(result.sources.length)} detail="Remaining usage is shown by source" /><MetricCard label="API key all-time usage" value={formatCurrency(result.usage.calculatedCost)} detail={`${formatInteger(result.usage.totalTokens)} tokens`} /><MetricCard label="API Key" value={result.apiKey.status} detail={middleTruncate(result.apiKey.prefix, 18)} detailTitle={result.apiKey.prefix} tone={result.apiKey.status === "enabled" ? "good" : "warn"} /></div><div className="key-usage-source-list">{result.sources.length ? result.sources.map((source, index) => <UsageSourceGroup key={`${source.source}:${source.origin.scopeType}:${source.origin.scopeLabel}:${source.origin.planName ?? "direct"}:${source.origin.planVersion ?? 0}:${index}`} source={source} limits={limitsForSource(result.sources, result.limits, index)} />) : <div className="panel empty-state"><h2>No active usage source</h2><p className="muted">This API key has no active Plan or direct API key limit.</p></div>}</div></> : null}
  </div></div>;
}

function UsageSourceGroup({ source, limits }: { source: BudgetSource; limits: BudgetLimit[] }) {
  const { origin } = source;
  return <section className="panel key-usage-source"><div className="panel-heading"><div><h2>{origin.scopeLabel}</h2><p className="muted">{origin.planName ? `${origin.planName} · v${origin.planVersion}` : "API key direct limit"}</p></div><StatusBadge tone={source.source === "key" ? "info" : "neutral"}>{source.source === "key" ? "API key direct limit" : "Plan"}</StatusBadge></div>
    <div className="key-usage-source-meta"><p><strong>Models:</strong> {origin.applicableModels.length ? origin.applicableModels.join(", ") : "No enabled models in this Plan"}</p>{origin.subscriptionEffectiveStart ? <p><strong>Subscription:</strong> <LocalTime value={origin.subscriptionEffectiveStart} />{origin.subscriptionEffectiveEnd ? <> – <LocalTime value={origin.subscriptionEffectiveEnd} /></> : <> – No fixed end</>}</p> : null}</div>
    {limits.length ? <div className="key-usage-limit-list">{limits.map((limit, index) => <UsageLimit key={`${limit.origin.limitScope}:${limit.metric}:${limit.windowType}:${limit.windowSeconds ?? "cumulative"}:${index}`} limit={limit} />)}</div> : <div className="notice-box"><strong>No configured limit</strong><p className="muted">This active source has no Budget Limit.</p></div>}
  </section>;
}

function UsageLimit({ limit }: { limit: BudgetLimit }) {
  return <div className={`key-usage-limit${limit.exhausted ? " key-usage-limit-exhausted" : ""}`}><div className="key-usage-limit-heading"><h3>{limitScopeLabel(limit.origin.limitScope)} · {formatWindow(limit)}</h3><StatusBadge tone={limit.exhausted ? "bad" : "neutral"}>{limit.exhausted ? "Exhausted" : limit.metric}</StatusBadge></div><div className="key-usage-values"><div><span>Used</span><strong>{formatMetric(limit.usedValue, limit.metric)}</strong></div><div><span>Remaining</span><strong>{formatMetric(limit.remainingValue, limit.metric)}</strong></div><div><span>Limit</span><strong>{formatMetric(limit.limitValue, limit.metric)}</strong></div></div><div className="usage-cell"><ProgressBar value={limit.percentUsed} tone={limit.exhausted ? "bad" : limit.percentUsed > 70 ? "warn" : "good"} /><span>{limit.percentUsed}%</span></div><RecoveryDetails limit={limit} /></div>;
}

function RecoveryDetails({ limit }: { limit: BudgetLimit }) {
  if (limit.windowType === "cumulative") return <p className="key-usage-recovery">Does not reset during this Subscription</p>;
  if (limit.windowType === "fixed") return <p className="key-usage-recovery">Resets in full at {limit.nextResetAt ? <LocalTime value={limit.nextResetAt} /> : "the end of this Subscription"}</p>;
  if (!limit.recovery?.nextRecoveryAt) return <p className="key-usage-recovery">No usage waiting to recover</p>;
  return <div className="key-usage-recovery"><p>Starts recovering after <LocalTime value={limit.recovery.nextRecoveryAt} /> · +{formatMetric(limit.recovery.nextRecoveryValue ?? 0, limit.metric)}</p>{limit.recovery.fullRecoveryAt ? <p>Fully recovers after <LocalTime value={limit.recovery.fullRecoveryAt} /> if there is no new usage</p> : null}</div>;
}

function LocalTime({ value }: { value: string }) { return <time dateTime={value}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value))}</time>; }
function limitsForSource(sources: BudgetSource[], limits: BudgetLimit[], sourceIndex: number) { const start = sources.slice(0, sourceIndex).reduce((sum, source) => sum + source.limitCount, 0); return limits.slice(start, start + (sources[sourceIndex]?.limitCount ?? 0)); }
function limitScopeLabel(scope: BudgetOrigin["limitScope"]) { return scope === "subscription" ? "Team shared / Subscription" : scope === "user" ? "Personal / User" : "API key direct"; }
function formatMetric(value: number, metric: BudgetLimit["metric"]) { return metric === "amount" ? formatCurrency(value) : formatInteger(value); }
function formatCurrency(value: number) { const precise = value !== 0 && Math.abs(value) < 0.01; return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: precise ? 6 : 2 }).format(value); }
function formatInteger(value: number) { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value); }
function formatWindow(limit: BudgetLimit) { if (limit.windowType === "cumulative") return "Cumulative"; const mode = limit.windowType === "fixed" ? "fixed" : "rolling"; if (!limit.windowSeconds) return mode; if (limit.windowSeconds % 86_400 === 0) return `${limit.windowSeconds / 86_400}d ${mode}`; if (limit.windowSeconds % 3_600 === 0) return `${limit.windowSeconds / 3_600}h ${mode}`; return `${limit.windowSeconds}s ${mode}`; }
function middleTruncate(value: string, maxLength: number) { if (value.length <= maxLength) return value; const edgeLength = Math.max(4, Math.floor((maxLength - 3) / 2)); return `${value.slice(0, edgeLength)}...${value.slice(-edgeLength)}`; }
