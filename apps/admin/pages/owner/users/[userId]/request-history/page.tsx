import { MetricCard, PageHeading, StatusBadge } from "@frely/console-ui";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";
import { RequestLogFilters } from "@frely/console-ui/request-log-filters";
import { UserRequestHistoryTable } from "@frely/console-ui/request-history-table";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { AdminViewSwitcher } from "../../../_components/owner-view-switcher";
import type { AdminPageData } from "./page.server";

export default function OwnerUserRequestHistoryPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { userId, model, newestHref, olderHref } = loaded;
  return (
    <>
      <PageHeading
        eyebrow="Owner / Target user preview"
        title="Request History"
        description="Preview the safe Request History facts visible to this concrete user. Capture reads and downloads are disabled."
      >
        <StatusBadge tone="info">Preview only</StatusBadge>
        <Button asChild variant="secondary">
          <a href={`/owner/users/${encodeURIComponent(userId)}?view=user`}>Back to user</a>
        </Button>
        <AdminViewSwitcher view="user" audience="user" />
      </PageHeading>

      <section className="summary-row">
        <MetricCard label="Loaded Requests" value={String(model.summary.loadedRequests)} detail={`Current ${model.page.pageSize}-row cursor page`} />
        <MetricCard label="Available Captures" value={String(model.summary.downloadableCaptures)} detail="Availability only; payload is not loaded" />
        <MetricCard label="Interaction" value="Preview" detail="No audience mutation or sensitive read port" />
        <MetricCard label="Filter" value={model.filter.status || "All"} detail={selectedApiKeyLabel(model)} />
      </section>

      <Card className="panel">
        <div className="panel-heading">
          <div><h2>Request History</h2></div>
          <StatusBadge tone="neutral">Target user</StatusBadge>
        </div>
        <RequestLogFilters
          action={`/owner/users/${encodeURIComponent(userId)}/request-history`}
          resetHref={`/owner/users/${encodeURIComponent(userId)}/request-history`}
          status={model.filter.status}
          apiKeyId={model.filter.apiKeyId}
          apiKeys={model.apiKeyOptions.items}
          model={model.filter.model}
          modelOptions={model.modelOptions}
          duration={model.filter.duration}
          start={model.filter.start}
          timeWindow={model.filter.timeWindow}
          downloadHref=""
          canBatchDownload={false}
          hiddenParams={{
            ...(model.page.pageSize === 20 ? {} : { pageSize: String(model.page.pageSize) }),
            ...(model.apiKeyOptions.pageSize === 20 ? {} : { apiKeyPageSize: String(model.apiKeyOptions.pageSize) }),
          }}
        />
        <MaterialTablePagination
          page={model.apiKeyOptions.page}
          pageSize={model.apiKeyOptions.pageSize}
          total={model.apiKeyOptions.total}
          totalPages={model.apiKeyOptions.totalPages}
          pageParam="apiKeyPage"
          pageSizeParam="apiKeyPageSize"
          previousHref={model.apiKeyOptions.page > 1
            ? requestHistoryHref(userId, model.filter, { apiKeyPage: model.apiKeyOptions.page - 1, apiKeyPageSize: model.apiKeyOptions.pageSize, pageSize: model.page.pageSize })
            : ""}
          nextHref={model.apiKeyOptions.page < model.apiKeyOptions.totalPages
            ? requestHistoryHref(userId, model.filter, { apiKeyPage: model.apiKeyOptions.page + 1, apiKeyPageSize: model.apiKeyOptions.pageSize, pageSize: model.page.pageSize })
            : ""}
          noun="API key filter options"
        />
        <UserRequestHistoryTable rows={model.rows} interactionMode="preview" />
        <MaterialTablePagination
          page={1}
          pageSize={model.page.pageSize}
          pageSizeParam="pageSize"
          resetParams={["cursor"]}
          total={model.rows.length}
          totalMode="unknown"
          totalPages={1}
          previousHref={model.page.acceptedCursor ? newestHref : ""}
          nextHref={olderHref}
          noun="requests"
        />
      </Card>
    </>
  );
}

type UserRequestHistoryFilter = {
  status: string;
  apiKeyId: string;
  model: string;
  duration: string;
  start: string;
  timeWindow: string;
};

function requestHistoryHref(
  userId: string,
  filter: UserRequestHistoryFilter,
  options: { cursor?: string; pageSize?: TablePageSize; apiKeyPage?: number; apiKeyPageSize?: TablePageSize },
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value) params.set(key, value);
  }
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.pageSize && options.pageSize !== 20) params.set("pageSize", String(options.pageSize));
  if ((options.apiKeyPage ?? 1) > 1) params.set("apiKeyPage", String(options.apiKeyPage));
  if (options.apiKeyPageSize && options.apiKeyPageSize !== 20) params.set("apiKeyPageSize", String(options.apiKeyPageSize));
  const query = params.toString();
  const route = `/owner/users/${encodeURIComponent(userId)}/request-history`;
  return query ? `${route}?${query}` : route;
}


function selectedApiKeyLabel(model: {
  filter: { apiKeyId: string };
  apiKeyOptions: { items: Array<{ id: string; name: string }> };
}) {
  if (!model.filter.apiKeyId) return "All keys";
  return model.apiKeyOptions.items.find((apiKey) => apiKey.id === model.filter.apiKeyId)?.name ?? "Selected key";
}
