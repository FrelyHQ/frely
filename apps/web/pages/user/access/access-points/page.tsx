import Link from "@web/navigation";
import { MetricCard, PageHeading, StatusBadge } from "@frely/console-ui";
import { AccessPointDescription } from "@frely/console-ui/access-point-description";
import { MaterialTable } from "@frely/console-ui/material-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { userAccessDirectoryHref } from "../../../../features/access/lib/user-access-url-state";
import type { UserAccessPointsPageData } from "./page.server";

export default function UserAccessPointsPage({ data }: { data: UserAccessPointsPageData }) {
  const { state, directory, metrics } = data;
  return (
    <>
      <PageHeading eyebrow="Access / Access Points" title="Access Points" description="Review user-visible AccessPoint summaries without Provider base URLs, credentials, upstream cost, or full access chains.">
        <StatusBadge tone="info">Summary only</StatusBadge>
      </PageHeading>
      <section className="summary-row">
        <MetricCard label="Visible AccessPoints" value={String(metrics.totalModels)} detail="Resolved for user scope" {...(metrics.totalModels > 0 ? { tone: "good" as const } : {})} />
        <MetricCard label="Provider Secrets" value="Hidden" detail="Never exposed in Web UI" tone="good" />
        <MetricCard label="Base URLs" value="Hidden" detail="Provider internals omitted" tone="good" />
        <MetricCard label="Access Chains" value="Hidden" detail="Summary visibility only" tone="good" />
      </section>
      <Card className="panel">
        <div className="panel-heading">
          <div><h2>Visible Summaries</h2><p className="muted">These rows intentionally contain only user-safe AccessPoint summary fields.</p></div>
          <form action="/user/access/access-points" className="row-actions" method="get">
            {state.pageSize !== 20 ? <input type="hidden" name="pageSize" value={state.pageSize} /> : null}
            <StatusBadge tone="info">{directory.total} results</StatusBadge>
            <label className="sr-only" htmlFor="user-access-point-query">Search AccessPoints</label>
            <input id="user-access-point-query" name="q" defaultValue={state.query} maxLength={100} placeholder="Search model, family, or Plan" />
            <Button type="submit" variant="secondary">Search</Button>
            {state.query ? <Button asChild type="button" variant="ghost"><Link href="/user/access/access-points">Clear</Link></Button> : null}
          </form>
        </div>
        <MaterialTable
          columns={["AccessPoint", "API Family", "ID"].map((header) => ({ header }))}
          rows={directory.items.map((accessPoint) => ({
            id: accessPoint.accessPointId,
            cells: [<><strong data-clarity-mask="true">{accessPoint.displayName}</strong><AccessPointDescription description={accessPoint.description} /></>, accessPoint.apiFamily, <code data-clarity-mask="true">{accessPoint.accessPointId}</code>],
          }))}
          emptyState={{ title: "No AccessPoints are currently visible to this user." }}
        />
        <MaterialTablePagination
          page={directory.page}
          pageSize={directory.pageSize}
          totalPages={directory.totalPages}
          total={directory.total}
          previousHref={directory.page > 1 ? userAccessDirectoryHref("access-points", { ...state, page: directory.page - 1 }) : ""}
          nextHref={directory.page < directory.totalPages ? userAccessDirectoryHref("access-points", { ...state, page: directory.page + 1 }) : ""}
          noun="access points"
        />
      </Card>
    </>
  );
}
