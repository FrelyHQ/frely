import Link from "@web/navigation";
import { MetricCard, PageHeading, StatusBadge } from "@frely/console-ui";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import type { UserPageData } from "./page.server";

const availableTeamHrefPlaceholder = "/user/team";

const taskGroups = [
  {
    id: "start",
    title: "Start using the API",
    description: "Choose a model, create an API key, then verify your integration.",
    links: [
      { label: "View available models", href: "/user/access/available-models" },
      { label: "Manage API keys", href: "/user/keys" },
      { label: "Open API test", href: "/user/tools/api-test" },
    ],
  },
  {
    id: "billing",
    title: "Usage & billing",
    description: "Understand recent activity, available credit, and your current plan limits.",
    links: [
      { label: "Review request history", href: "/user/request-history" },
      { label: "Review credits", href: "/user/credits" },
      { label: "Compare plans", href: "/user/plans-and-budgets/plans" },
    ],
  },
  {
    id: "team",
    title: "Team workspace",
    description: "Open your enabled Team memberships and the resources shared with you.",
    links: [
      { label: "Open Team workspace", href: availableTeamHrefPlaceholder },
      { label: "Review access order", href: "/user/access/order" },
      { label: "View cards", href: "/user/cards" },
    ],
  },
];

export default function UserPage({ data }: { data: UserPageData }) {
  const { view, availableTeams, availableTeamCount } = data;
  return (
    <>
      <PageHeading eyebrow="User Console" title="Dashboard" description="Review your user-visible account, team context, API keys, access surface, usage, and budget.">
        <StatusBadge tone={view.user.status === "Active" ? "good" : "warn"}>{view.user.status}</StatusBadge>
        <Button asChild><Link href="/user/keys">{view.activeApiKeys > 0 ? "Manage API keys" : "Create your first API key"}</Link></Button>
      </PageHeading>
      <section className="summary-row">
        <MetricCard label="API Keys" value={String(view.apiKeyTotal)} detail={`${view.activeApiKeys} active`} maskValue {...(view.activeApiKeys > 0 ? { tone: "good" as const } : {})} />
        <MetricCard label="Credit Balance" value={view.credit.balance} detail={view.credit.transferOutEnabled ? "Transfer enabled" : "Available balance"} maskValue />
        <MetricCard label="Peak Usage" value={`${view.maxApiKeyUsage}%`} detail="Highest key this month" maskValue {...(view.maxApiKeyUsage > 90 ? { tone: "bad" as const } : view.maxApiKeyUsage > 70 ? { tone: "warn" as const } : {})} />
        <MetricCard label="Teams" value={String(availableTeamCount)} detail={availableTeamCount === 1 ? availableTeams[0]!.name : "Enabled memberships"} maskValue maskDetail={availableTeamCount === 1} />
      </section>
      <section className="dashboard-task-grid" aria-label="Common tasks">
        {taskGroups.map((group) => (
          <Card className="panel dashboard-task-card" id={group.id} key={group.id}>
            <div><h2>{group.title}</h2><p className="muted">{group.description}</p></div>
            <div className="dashboard-task-links">
              {group.links
                .filter((link) => group.id !== "team" || link.href !== availableTeamHrefPlaceholder || availableTeamCount > 0)
                .map((link) => {
                  const href = link.href === availableTeamHrefPlaceholder && availableTeamCount === 1 ? `/user/team/${availableTeams[0]!.id}` : link.href;
                  return <Link className="text-link" href={href} key={link.label}>{link.label}<span aria-hidden="true">→</span></Link>;
                })}
            </div>
          </Card>
        ))}
      </section>
    </>
  );
}
