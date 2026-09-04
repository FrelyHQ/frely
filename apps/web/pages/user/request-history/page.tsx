import { MetricCard, PageHeading, StatusBadge } from "@frely/console-ui";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import type { TablePageSize } from "@frely/console-ui/pagination";
import { RequestLogFilters } from "@frely/console-ui/request-log-filters";
import { Card } from "@frely/ui/components/card";
import { RequestHistoryTable } from "../../../features/request-history";
import type { UserRequestHistoryPageData } from "./page.server";

export default function UserRequestHistoryPage({ data }: { data: UserRequestHistoryPageData }) {
  const { model } = data;
  const downloadQuery = data.downloadQuery;
  const downloadHref = `/api/user/request-logs/captures/download?${new URLSearchParams(downloadQuery)}`;
  const newestHref = requestHistoryHref(model.filter, { apiKeyPage: model.apiKeyOptions.page, apiKeyPageSize: model.apiKeyOptions.pageSize, pageSize: model.page.pageSize });
  const olderHref = model.page.nextCursor ? requestHistoryHref(model.filter, { cursor: model.page.nextCursor, pageSize: model.page.pageSize, apiKeyPage: model.apiKeyOptions.page, apiKeyPageSize: model.apiKeyOptions.pageSize }) : "";
  return (
    <>
      <PageHeading eyebrow="User / Request History" title="Request History" description="Review Gateway requests made by your API keys and download available captures."><StatusBadge tone={model.summary.downloadableCaptures > 0 ? "good" : "neutral"}>{model.summary.downloadableCaptures} downloadable</StatusBadge></PageHeading>
      <section className="summary-row">
        <MetricCard label="Loaded Requests" value={String(model.summary.loadedRequests)} detail={`Current ${model.page.pageSize}-row cursor page`} maskValue />
        <MetricCard label="Available Captures" value={String(model.summary.downloadableCaptures)} detail="Verified request and response file" maskValue />
        <MetricCard label="API Keys" value={String(data.apiKeyTotal)} detail={`${data.activeApiKeys} active`} maskValue />
        <MetricCard label="Filter" value={model.filter.status || "All"} detail={selectedApiKeyLabel(model)} maskDetail={Boolean(model.filter.apiKeyId)} />
      </section>
      <Card className="panel">
        <div className="panel-heading"><div><h2>Request History</h2></div></div>
        <RequestLogFilters action="/user/request-history" resetHref="/user/request-history" status={model.filter.status} apiKeyId={model.filter.apiKeyId} apiKeys={model.apiKeyOptions.items} model={model.filter.model} modelOptions={model.modelOptions} duration={model.filter.duration} start={model.filter.start} timeWindow={model.filter.timeWindow} downloadHref={downloadHref} canBatchDownload={Boolean(downloadQuery.start && downloadQuery.timeWindow)} hiddenParams={{ ...(model.page.pageSize === 20 ? {} : { pageSize: String(model.page.pageSize) }), ...(model.apiKeyOptions.pageSize === 20 ? {} : { apiKeyPageSize: String(model.apiKeyOptions.pageSize) }) }} />
        <MaterialTablePagination page={model.apiKeyOptions.page} pageSize={model.apiKeyOptions.pageSize} total={model.apiKeyOptions.total} totalPages={model.apiKeyOptions.totalPages} pageParam="apiKeyPage" pageSizeParam="apiKeyPageSize" previousHref={model.apiKeyOptions.page > 1 ? requestHistoryHref(model.filter, { apiKeyPage: model.apiKeyOptions.page - 1, apiKeyPageSize: model.apiKeyOptions.pageSize, pageSize: model.page.pageSize }) : ""} nextHref={model.apiKeyOptions.page < model.apiKeyOptions.totalPages ? requestHistoryHref(model.filter, { apiKeyPage: model.apiKeyOptions.page + 1, apiKeyPageSize: model.apiKeyOptions.pageSize, pageSize: model.page.pageSize }) : ""} noun="API key filter options" />
        <RequestHistoryTable rows={model.rows} />
        <MaterialTablePagination page={1} pageSize={model.page.pageSize} pageSizeParam="pageSize" resetParams={["cursor"]} total={model.rows.length} totalMode="unknown" totalPages={1} previousHref={model.page.acceptedCursor ? newestHref : ""} nextHref={olderHref} noun="requests" />
      </Card>
    </>
  );
}

type RequestHistoryFilter = Partial<Record<"status" | "apiKeyId" | "model" | "duration" | "start" | "timeWindow", string>>;

function requestHistoryHref(filter: RequestHistoryFilter, options: { cursor?: string; pageSize?: TablePageSize; apiKeyPage?: number; apiKeyPageSize?: TablePageSize }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.pageSize && options.pageSize !== 20) params.set("pageSize", String(options.pageSize));
  if ((options.apiKeyPage ?? 1) > 1) params.set("apiKeyPage", String(options.apiKeyPage));
  if (options.apiKeyPageSize && options.apiKeyPageSize !== 20) params.set("apiKeyPageSize", String(options.apiKeyPageSize));
  const query = params.toString();
  return query ? `/user/request-history?${query}` : "/user/request-history";
}

function selectedApiKeyLabel(model: { filter: { apiKeyId: string }; apiKeyOptions: { items: Array<{ id: string; name: string }> } }) {
  if (!model.filter.apiKeyId) return "All keys";
  return model.apiKeyOptions.items.find((apiKey) => apiKey.id === model.filter.apiKeyId)?.name ?? "Selected key";
}
