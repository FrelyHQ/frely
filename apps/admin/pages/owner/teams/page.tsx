import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { DirectoryPanel } from "../_components/directory-panel";
import { MetricCard, PageHeading } from "../_components/ui";
import { CreateTeamDialog, TeamsTable } from "../../../features/teams";
import type { AdminPageData } from "./page.server";

export default function TeamsPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { teams } = loaded;
  return (
    <>
      <PageHeading
        eyebrow="Teams Management"
        title="Teams"
        description="Configure access policies, quotas, and team-specific API keys."
      >
        <CreateTeamDialog />
      </PageHeading>

      <section className="summary-row">
        {teams.metrics.map((metric) => (
          <MetricCard key={metric.label} label={metric.label} value={metric.value} detail={metric.detail} {...(metric.tone ? { tone: metric.tone } : {})} />
        ))}
      </section>

      <DirectoryPanel
        title="Team Directory"
        description="Tenant scopes, hierarchical usage limits, and derived access coverage."
        action="/owner/teams"
        query={teams.query}
        placeholder="Search teams by name, ID, status, or access"
        emptyLabel="No teams match this search."
        hasRows={teams.rows.length > 0}
        hiddenParams={{
          pageSize: teams.pageSize === 20 ? undefined : teams.pageSize,
          sort: teams.search.sort === "createdAt" ? undefined : teams.search.sort,
          direction: teams.search.direction === "asc" ? undefined : teams.search.direction,
        }}
      >
        <TeamsTable rows={teams.rows} search={teams.search} />
        <MaterialTablePagination
          page={teams.page}
          pageSize={teams.pageSize}
          total={teams.total}
          totalPages={teams.totalPages}
          rangeStart={teams.total > 0 ? (teams.page - 1) * teams.pageSize + 1 : 0}
          rangeEnd={Math.min(teams.page * teams.pageSize, teams.total)}
          previousHref={teams.page > 1 ? adminTeamsHref(teams.search, { page: teams.page - 1 }) : ""}
          nextHref={teams.page < teams.totalPages ? adminTeamsHref(teams.search, { page: teams.page + 1 }) : ""}
          noun="teams"
        />
      </DirectoryPanel>
    </>
  );
}

function adminTeamsHref(
  state: { query: string; page: number; pageSize: number; sort: string; direction: "asc" | "desc" },
  overrides: Partial<{ query: string; page: number; pageSize: number; sort: string; direction: "asc" | "desc" }> = {},
) {
  const next = { ...state, ...overrides };
  const params = new URLSearchParams();
  if (next.query) params.set("q", next.query);
  if (next.page > 1) params.set("page", String(next.page));
  if (next.pageSize !== 20) params.set("pageSize", String(next.pageSize));
  if (next.sort !== "createdAt") params.set("sort", next.sort);
  if (next.direction !== "asc") params.set("direction", next.direction);
  const query = params.toString();
  return `/owner/teams${query ? `?${query}` : ""}`;
}
