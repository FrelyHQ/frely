import Link from "@web/navigation";
import { MetricCard, PageHeading } from "@frely/console-ui";
import { Button } from "@frely/ui/components/button";
import { TeamUsageControls } from "../../../../../features/team-usage";
import type { TeamUsagePageData } from "./page.server";

export default function TeamUsagePage({ data }: { data: TeamUsagePageData }) {
  if (data.kind === "empty") return <><Heading teamId={data.teamId} /><div className="notice-box" role="status">No current Team Plan sources.</div><p className="muted">Calculated at {formatDateTime(data.calculatedAt)}.</p></>;
  if (data.kind === "unavailable") return <><Heading teamId={data.teamId} /><div className="notice-box notice-bad" role="alert">Plan source unavailable.</div><TeamUsageControls teamId={data.teamId} state={{ ...data.state, page: 1 }} candidates={data.candidates} selected={null} items={[]} page={1} pageSize={data.state.pageSize} total={0} totalPages={1} showMemberUsage={false} /><p className="muted">Choose a current Team Plan source to continue.</p></>;
  const { usage } = data;
  return (
    <>
      <Heading teamId={data.teamId} />
      <section className="summary-row">
        <MetricCard label="Plan Source" value={`${usage.subscription.planName} v${usage.subscription.planVersion}`} detail={usage.subscription.billingMode === "prepaid" ? "Prepaid Plan usage amount" : "PayGo Plan usage amount"} />
        <MetricCard label="Subscription Period" value={formatDate(usage.periodStart)} detail={`Through ${formatDateTime(usage.periodEnd)}`} />
        <MetricCard label="Billable Requests" value={usage.summary.requestCount.toLocaleString()} detail="Distinct billed requests" />
        <MetricCard label="Total Tokens" value={usage.summary.totalTokens.toLocaleString()} detail="Billed token facts" />
        <MetricCard label="Plan Usage" value={formatCurrency(usage.summary.billableAmount)} detail="Plan usage amount, not a Member balance debit" />
      </section>
      {data.historical ? <div className="notice-box" role="status">Historical/non-current consumers account for {usage.summary.historicalRequestCount.toLocaleString()} requests, {usage.summary.historicalTokens.toLocaleString()} tokens, and {formatCurrency(usage.summary.historicalBillableAmount)}. Their identities are not shown.</div> : null}
      <TeamUsageControls teamId={data.teamId} state={data.state} candidates={data.candidates} selected={usage.subscription} items={usage.items} page={usage.page} pageSize={usage.pageSize} total={usage.total} totalPages={usage.totalPages} />
      <p className="muted">Calculated at {formatDateTime(usage.calculatedAt)}. All values use this read snapshot.</p>
    </>
  );
}

function Heading({ teamId }: { teamId: string }) {
  return <PageHeading eyebrow="Team / Usage" title="Member Plan Usage" description="Review current-member and anonymous historical usage for one active Team Subscription."><Button variant="secondary" asChild><Link href={`/user/team/${encodeURIComponent(teamId)}`}>Back to Team</Link></Button></PageHeading>;
}

function formatCurrency(value: number): string { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 6 : 2 }).format(value); }
function formatDate(value: string): string { return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value)); }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
