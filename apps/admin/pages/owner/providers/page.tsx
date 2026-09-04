import { Card } from "@frely/ui/components/card";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import type { TablePageSize } from "@frely/console-ui/pagination";
import { AddProviderDialog, ProvidersTable } from "../../../features/providers";
import { MetricCard, PageHeading, StatusBadge } from "../_components/ui";
import type { AdminPageData } from "./page.server";

export default function ProvidersPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { showRetained, directory, providerModels, rows, summary, hiddenRetainedCount, capabilities } = loaded;
  return (
    <>
      <PageHeading
        eyebrow="Upstream Providers"
        title="Providers"
        description="Manage upstream provider configuration and provider model catalog entries. AccessPoints own runtime access resolution."
      >
        <AddProviderDialog capabilities={capabilities} />
      </PageHeading>

      <section className="metric-grid" aria-label="Provider metrics">
        <MetricCard label="Providers" value={String(summary.providerCount)} detail={`${summary.enabledProviderCount} enabled`} {...(summary.providerCount > 0 ? { tone: "good" as const } : {})} />
        <MetricCard label="Registered Models" value={String(summary.registeredModelCount)} detail="Across configured Providers" />
      </section>

      <Card className="panel">
        <div className="panel-heading">
          <div>
            <h2>Upstream Configuration</h2>
            <p className="muted">Providers store adapter configuration. Provider models are paged independently. AccessPoints select provider models and expose them to scopes.</p>
          </div>
          <StatusBadge tone="neutral">Provider model only</StatusBadge>
        </div>
        <ProvidersTable rows={rows} showRetained={showRetained} hiddenRetainedCount={hiddenRetainedCount} />
        <MaterialTablePagination page={directory.page} pageSize={directory.pageSize} total={directory.total} totalPages={directory.totalPages} rangeStart={directory.total ? (directory.page - 1) * directory.pageSize + 1 : 0} rangeEnd={Math.min(directory.page * directory.pageSize, directory.total)} previousHref={directory.page > 1 ? providersHref(showRetained, directory.page - 1, directory.pageSize, 1, providerModels.pageSize) : ""} nextHref={directory.page < directory.totalPages ? providersHref(showRetained, directory.page + 1, directory.pageSize, 1, providerModels.pageSize) : ""} noun="providers" />
        <MaterialTablePagination page={providerModels.page} pageSize={providerModels.pageSize} total={providerModels.total} totalPages={providerModels.totalPages} rangeStart={providerModels.total ? (providerModels.page - 1) * providerModels.pageSize + 1 : 0} rangeEnd={Math.min(providerModels.page * providerModels.pageSize, providerModels.total)} previousHref={providerModels.page > 1 ? providersHref(showRetained, directory.page, directory.pageSize, providerModels.page - 1, providerModels.pageSize) : ""} nextHref={providerModels.page < providerModels.totalPages ? providersHref(showRetained, directory.page, directory.pageSize, providerModels.page + 1, providerModels.pageSize) : ""} noun="provider models" />
      </Card>
    </>
  );
}

function providersHref(showRetained: boolean, page: number, pageSize: TablePageSize, modelPage: number, modelPageSize: TablePageSize) {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (pageSize !== 20) params.set("pageSize", String(pageSize));
  if (modelPage > 1) params.set("modelPage", String(modelPage));
  if (modelPageSize !== 20) params.set("modelPageSize", String(modelPageSize));
  if (showRetained) params.set("showRetained", "1");
  return `/owner/providers?${params}`;
}
