import Link from "@admin/navigation";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { MetricCard, PageHeading, ProgressBar, StatusBadge } from "./_components/ui";
import type { AdminPageData } from "./page.server";

export default function AdminDashboardPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { dashboard } = loaded;
  return (
    <>
      <PageHeading
        eyebrow="Owner Console"
        title="Platform Dashboard"
        description="Monitor tenant health, provider latency, AccessPoint changes, and budget pressure across the relay."
      >
        <Button variant="secondary" asChild>
          <Link href="/owner/access-points">New Access Point</Link>
        </Button>
        <Button asChild>
          <Link href="/owner/teams">Create Team</Link>
        </Button>
      </PageHeading>

      <section className="metric-grid" aria-label="Gateway metrics">
        {dashboard.metrics.map((metric) => (
          <MetricCard key={metric.label} label={metric.label} value={metric.value} detail={metric.detail} {...(metric.href ? { href: metric.href } : {})} {...(metric.tone ? { tone: metric.tone } : {})} />
        ))}
      </section>

      <section className="dashboard-grid">
        <Card className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <h2>24h Request Volume</h2>
              <p className="muted">Successful and failed request trend</p>
            </div>
            <StatusBadge tone={dashboard.requestVolumeTone}>{dashboard.requestVolumeStatus}</StatusBadge>
          </div>
          <div className="bar-chart" aria-label="Request volume chart">
            {dashboard.requestVolume.map((height, index) => (
              <span style={{ height: `${height}%` }} key={index} />
            ))}
          </div>
          <div className="axis-labels">
            {dashboard.requestVolumeLabels.map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>
        </Card>

        <Card className="panel latency-panel">
          <div className="panel-heading">
            <h2>Provider Latency</h2>
            <span className="muted">Average</span>
          </div>
          {dashboard.providerLatency.map((provider) => (
            <div className="latency-row" key={provider.name}>
              <div>
                <strong>{provider.name}</strong>
                <ProgressBar value={provider.value} tone={provider.tone} />
              </div>
              <span>{provider.latency}</span>
            </div>
          ))}
        </Card>
      </section>
    </>
  );
}
