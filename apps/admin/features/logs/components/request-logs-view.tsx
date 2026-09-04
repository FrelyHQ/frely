import type { ComponentProps } from "react";
import { RequestLogFilters } from "@frely/console-ui/request-log-filters";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { Card } from "@frely/ui/components/card";
import { MetricCard, PageHeading, StatusBadge } from "../../../pages/owner/_components/ui";
import type { RequestLogsAggregate } from "../lib/request-log-aggregate";
import { requestCaptureDownloadQuery, requestLogsHref, type RequestLogUrlState } from "../table/log-url-state";
import { RequestLogsTable } from "./request-logs-table";

export function RequestLogsView({ logs, state }: { logs: RequestLogsAggregate; state: RequestLogUrlState }) {
  const normalizedState = { ...state, status: logs.queryStatus, providerId: logs.queryProviderId, model: logs.queryModel, apiKeyId: logs.queryApiKeyId, owner: logs.queryOwner, duration: logs.queryDuration, timeWindow: logs.queryTimeWindow, start: logs.queryEnd, page: logs.page };
  const windowLabel = logs.queryStart && logs.queryEnd ? `${logs.queryStart} - ${logs.queryEnd}` : "all time";
  const downloadQuery = requestCaptureDownloadQuery(normalizedState);
  const downloadHref = `/api/owner/request-logs/captures/download?${new URLSearchParams(downloadQuery)}`;
  return <>
    <PageHeading eyebrow="Gateway Requests" title="Request Logs" description="Inspect recent Gateway request outcomes, provider resolution, and error codes." />
    <section className="summary-row" aria-label="Request log metrics">
      <MetricCard label="Requests" value={String(logs.total)} detail={windowLabel} href={requestLogsHref(normalizedState)} tone={logs.total === 0 ? "warn" : "good"} />
      <MetricCard label="Failed Requests" value={String(logs.failed)} detail={windowLabel} href={requestLogsHref(normalizedState, { status: "failed", page: 1 })} tone={logs.failed > 0 ? "bad" : "good"} />
    </section>
    <Card className="panel">
      <div className="panel-heading"><div><h2>Request History</h2></div>{logs.queryStatus ? <StatusBadge tone="info">Status: {logs.queryStatus}</StatusBadge> : <StatusBadge tone="neutral">All statuses</StatusBadge>}</div>
      <RequestLogFilters action="/owner/request-logs" resetHref="/owner/request-logs" status={logs.queryStatus} providerId={logs.queryProviderId} providerOptions={logs.providerOptions} model={logs.queryModel} modelOptions={logs.modelOptions} apiKeyId={logs.queryApiKeyId} apiKeys={logs.apiKeyOptions} owner={logs.queryOwner} ownerOptions={logs.ownerOptions} duration={logs.queryDuration} start={state.start} timeWindow={logs.queryTimeWindow} downloadHref={downloadHref} canBatchDownload={Boolean(downloadQuery.start && downloadQuery.timeWindow)} hiddenParams={state.pageSize === 20 ? {} : { pageSize: String(state.pageSize) }} />
      <RequestLogsTable rows={logs.rows} />
      <MaterialTablePagination page={logs.page} pageSize={state.pageSize} totalPages={logs.totalPages} total={logs.total} previousHref={logs.hasPreviousPage ? requestLogsHref(normalizedState, { page: logs.page - 1 }) : ""} nextHref={logs.hasNextPage ? requestLogsHref(normalizedState, { page: logs.page + 1 }) : ""} noun="requests" />
    </Card>
  </>;
}

export function Pagination(props: ComponentProps<typeof MaterialTablePagination>) {
  return <MaterialTablePagination {...props} />;
}
