import { MetricCard, PageHeading, StatusBadge } from "@frely/console-ui";
import { PlanBudgetSources } from "@frely/console-ui/plan-budget";
import type { UserBudgetPageData } from "./page.server";

export default function UserBudgetPage({ data }: { data: UserBudgetPageData }) {
  const { sources, exhausted, earliestReset } = data;
  const limits = sources.flatMap((source) => source.limits);
  return (
    <>
      <PageHeading eyebrow="Plans & Budgets / Budget" title="Budget" description="Current Plan limits are kept separate by source, metric, scope, and window."><StatusBadge tone={exhausted ? "bad" : sources.length ? "good" : "neutral"}>{exhausted ? "Limit exhausted" : sources.length ? "Within limits" : "No active plans"}</StatusBadge></PageHeading>
      <section className="summary-row">
        <MetricCard label="Active Sources" value={String(sources.length)} detail="Global, Team, and Personal" maskValue {...(sources.length ? { tone: "good" as const } : {})} />
        <MetricCard label="Visible Limits" value={String(limits.length)} detail="Shared and personal remain separate" maskValue />
        <MetricCard label="Exhausted" value={String(exhausted)} detail={exhausted ? "Another eligible source may still be available" : "No visible exhausted limits"} maskValue {...(exhausted ? { tone: "bad" as const } : {})} />
        <MetricCard label="Earliest Reset" value={earliestReset ? "Scheduled" : "None"} detail={earliestReset ?? "No active fixed window reset"} maskDetail={Boolean(earliestReset)} />
        <MetricCard label="All-time Cost" value={formatCurrency(data.calculatedCost)} detail="Separate from current Plan windows" maskValue />
      </section>
      <PlanBudgetSources sources={sources} calculatedAt={data.calculatedAt} emptyTitle="No current runtime-enabled Plan subscriptions are available." />
    </>
  );
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 6 : 2 }).format(value);
}
