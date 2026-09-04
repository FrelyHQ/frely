import { Button } from "@frely/ui/components/button";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import Link from "@admin/navigation";
import { DirectoryPanel } from "../_components/directory-panel";
import { MetricCard, PageHeading } from "../_components/ui";
import { ApiKeysTable } from "../../../features/api-keys";
import type { AdminPageData } from "./page.server";

export default function KeysPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { keys } = loaded;
  return (
    <>
      <PageHeading
        eyebrow="Key Overview"
        title="Keys"
        description="Review API key ownership, scope, status, usage pressure, and last activity."
      >
        <Button variant="secondary" asChild>
          <Link href="/owner/users">Users</Link>
        </Button>
      </PageHeading>

      <section className="summary-row">
        {keys.metrics.map((metric) => (
          <MetricCard key={metric.label} label={metric.label} value={metric.value} detail={metric.detail} {...(metric.tone ? { tone: metric.tone } : {})} />
        ))}
      </section>

      <DirectoryPanel
        title="Key Directory"
        description="Search by key name, prefix, ID, status, owner, or team."
        action="/owner/keys"
        query={keys.query}
        placeholder="Search keys by prefix, owner, team, or status"
        emptyLabel="No keys match this search."
        hasRows={keys.rows.length > 0}
        hiddenParams={{ pageSize: keys.pageSize === 20 ? undefined : keys.pageSize }}
      >
        <ApiKeysTable rows={keys.rows} />
        <MaterialTablePagination page={keys.page} pageSize={keys.pageSize} total={keys.total} totalPages={keys.totalPages} rangeStart={keys.total ? (keys.page - 1) * keys.pageSize + 1 : 0} rangeEnd={Math.min(keys.page * keys.pageSize, keys.total)} previousHref={keys.page > 1 ? ownerKeysHref(keys.query, keys.page - 1, keys.pageSize) : ""} nextHref={keys.page < keys.totalPages ? ownerKeysHref(keys.query, keys.page + 1, keys.pageSize) : ""} noun="keys" />
      </DirectoryPanel>
    </>
  );
}

function ownerKeysHref(query: string, page = 1, pageSize = 20) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 20) params.set("pageSize", String(pageSize));
  const search = params.toString();
  return `/owner/keys${search ? `?${search}` : ""}`;
}

function pageNumber(value: string | string[] | undefined) {
  const raw = singleValue(value);
  return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}


function singleValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
