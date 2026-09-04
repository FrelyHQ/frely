import Link from "@web/navigation";
import { MetricCard, PageHeading, StatusBadge } from "@frely/console-ui";
import { MaterialTable } from "@frely/console-ui/material-table";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { Button } from "@frely/ui/components/button";
import { userTeamDirectoryHref, type UserTeamDirectoryView } from "../../../lib/user-team-view";

export function TeamDirectory({ directory }: { directory: UserTeamDirectoryView }) {
  return (
    <>
      <PageHeading
        eyebrow="User Console"
        title="My Teams"
        description="Choose from the enabled Teams in your current memberships."
      />

      <section className="summary-row">
        <MetricCard label="Teams" value={String(directory.total)} detail="Enabled memberships" maskValue />
        <MetricCard label="Owner Teams" value={String(directory.ownerTeams)} detail="Derived from Team ownership" maskValue />
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Team Directory</h2>
            <p className="muted">Only Teams available to your current user are listed.</p>
          </div>
          <form action="/user/team" className="row-actions" method="get">
            {directory.pageSize !== 20 ? <input type="hidden" name="pageSize" value={directory.pageSize} /> : null}
            <StatusBadge tone="neutral">{directory.total} results</StatusBadge>
            <label className="sr-only" htmlFor="team-directory-query">Search Teams</label>
            <input id="team-directory-query" name="q" defaultValue={directory.query} maxLength={100} placeholder="Search name, ID, role, or status" />
            <Button type="submit" variant="secondary">Search</Button>
            {directory.query ? <Button asChild type="button" variant="ghost"><Link href="/user/team">Clear</Link></Button> : null}
          </form>
        </div>

        <MaterialTable
          columns={["Team", "Your Role", "Status", "Members", "Usage", "Plan"].map((header) => ({ header }))}
          rows={directory.rows.map((team) => ({
            id: team.id,
            cells: [
              <Link className="identity-link" href={`/user/team/${encodeURIComponent(team.id)}`} data-clarity-mask="true"><strong>{team.name}</strong><code>{team.id}</code></Link>,
              team.role,
              <StatusBadge tone="good">{team.status}</StatusBadge>,
              <span data-clarity-mask="true">{team.members}</span>,
              <span data-clarity-mask="true">{team.usage}</span>,
              <span data-clarity-mask="true">{team.plan}</span>
            ]
          }))}
          emptyState={{
            title: directory.total === 0 && !directory.query ? "You do not currently belong to an enabled Team." : "No Teams match this search.",
            ...(directory.query ? { description: `No results for “${directory.query}”.`, action: <Button asChild size="sm" variant="secondary"><Link href="/user/team">Clear search</Link></Button> } : {})
          }}
          table={{ minWidth: 760, stickyHeader: true }}
        />
        <MaterialTablePagination
          page={directory.page}
          pageSize={directory.pageSize}
          totalPages={directory.totalPages}
          total={directory.total}
          previousHref={directory.page > 1 ? userTeamDirectoryHref({ query: directory.query, page: directory.page - 1, pageSize: directory.pageSize }) : ""}
          nextHref={directory.page < directory.totalPages ? userTeamDirectoryHref({ query: directory.query, page: directory.page + 1, pageSize: directory.pageSize }) : ""}
          noun="teams"
        />
      </section>
    </>
  );
}
