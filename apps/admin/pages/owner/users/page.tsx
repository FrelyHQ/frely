import { Button } from "@frely/ui/components/button";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import Link from "@admin/navigation";
import { CreateUserDialog, UsersTable } from "../../../features/users";
import { DirectoryPanel } from "../_components/directory-panel";
import { MetricCard, PageHeading } from "../_components/ui";
import type { AdminPageData } from "./page.server";

export default function UsersPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { users, teams } = loaded;
  return (
    <>
      <PageHeading
        eyebrow="User Overview"
        title="Users"
        description="Review account ownership, team membership, API key coverage, and recent activity."
      >
        <CreateUserDialog teams={teams} />
        <Button variant="secondary" asChild>
          <Link href="/owner/teams">Teams</Link>
        </Button>
      </PageHeading>

      <section className="summary-row">
        {users.metrics.map((metric) => (
          <MetricCard key={metric.label} label={metric.label} value={metric.value} detail={metric.detail} {...(metric.tone ? { tone: metric.tone } : {})} />
        ))}
      </section>

      <DirectoryPanel
        title="User Directory"
        description="Search by user name, email, ID, role, status, or team."
        action="/owner/users"
        query={users.query}
        placeholder="Search users by email, ID, role, or team"
        emptyLabel="No users match this search."
        hasRows={users.rows.length > 0}
        hiddenParams={{ pageSize: users.pageSize === 20 ? undefined : users.pageSize }}
      >
        <UsersTable rows={users.rows} />
        <MaterialTablePagination page={users.page} pageSize={users.pageSize} total={users.total} totalPages={users.totalPages} rangeStart={users.total ? (users.page - 1) * users.pageSize + 1 : 0} rangeEnd={Math.min(users.page * users.pageSize, users.total)} previousHref={users.page > 1 ? ownerUsersHref(users.query, users.page - 1, users.pageSize) : ""} nextHref={users.page < users.totalPages ? ownerUsersHref(users.query, users.page + 1, users.pageSize) : ""} noun="users" />
      </DirectoryPanel>
    </>
  );
}

function ownerUsersHref(query: string, page = 1, pageSize = 20) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 20) params.set("pageSize", String(pageSize));
  const search = params.toString();
  return `/owner/users${search ? `?${search}` : ""}`;
}

function singleValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}


function pageNumber(value: string | string[] | undefined) {
  const raw = singleValue(value);
  return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}
