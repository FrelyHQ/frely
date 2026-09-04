import { Card } from "@frely/ui/components/card";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import type { TablePageSize } from "@frely/console-ui/pagination";
import {
  AccessPointDialog,
  AccessPointsTable,
} from "../../../features/access-points";
import { PageHeading, StatusBadge } from "../_components/ui";
import type { AdminPageData } from "./page.server";

export default function AccessPointsPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { directory, data } = loaded;
  return (
    <>
      <PageHeading
        eyebrow="Access"
        title="Access Points"
        description="Expose scoped model access points backed by an upstream provider model or another AccessPoint."
      >
        <AccessPointDialog data={data} />
      </PageHeading>
      <Card className="panel">
        <div className="panel-heading">
          <div>
            <h2>Access Points</h2>
            <p className="muted">
              Each row exposes one model name and forwards to a configured
              target model.
            </p>
          </div>
          <StatusBadge tone="info">
            {directory.total} access points
          </StatusBadge>
        </div>
        <AccessPointsTable data={data} />
        <MaterialTablePagination page={directory.page} pageSize={directory.pageSize} total={directory.total} totalPages={directory.totalPages} rangeStart={directory.total ? (directory.page - 1) * directory.pageSize + 1 : 0} rangeEnd={Math.min(directory.page * directory.pageSize, directory.total)} previousHref={directory.page > 1 ? href(directory.page - 1, directory.pageSize) : ""} nextHref={directory.page < directory.totalPages ? href(directory.page + 1, directory.pageSize) : ""} noun="access points" />
      </Card>
    </>
  );
}

function href(page: number, pageSize: TablePageSize) {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 20) params.set("pageSize", String(pageSize));
  return `/owner/access-points${params.size ? `?${params}` : ""}`;
}
