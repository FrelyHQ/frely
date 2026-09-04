import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import { Input } from "@frely/ui/components/input";
import { SearchSelect } from "@frely/console-ui/search-select";
import { PageHeading, StatusBadge } from "../../../pages/owner/_components/ui";
import type { AuditLogRow } from "../lib/audit-log-aggregate";
import { auditLogsHref, type AuditLogUrlState } from "../table/log-url-state";
import { AuditLogsTable } from "./audit-logs-table";
import { Pagination } from "./request-logs-view";

export function AuditLogsView({ rows, state, page, pageSize, totalPages, total, hasPreviousPage, hasNextPage }: { rows: AuditLogRow[]; state: AuditLogUrlState; page: number; pageSize: AuditLogUrlState["pageSize"]; totalPages: number; total: number; hasPreviousPage: boolean; hasNextPage: boolean }) {
  return <>
    <PageHeading eyebrow="Audit Logs" title="Audit Logs" description="Inspect administrative actions, policy decisions, and access resolution events across the relay." />
    <Card className="panel">
      <div className="panel-heading"><div><h2>Recent Events</h2><p className="muted">Administrative and system events captured for review.</p></div><StatusBadge tone="info">Retention: 180 days</StatusBadge></div>
      <form action="/owner/audit-logs" method="get" className="filter-grid" aria-label="Audit log filters">
        {state.pageSize !== 20 ? <input type="hidden" name="pageSize" value={state.pageSize} /> : null}
        <label>Actor<Input name="actor" defaultValue={state.actor} maxLength={160} /></label>
        <label>Source<SearchSelect name="source" defaultValue={state.source} searchable={false} options={[{ value: "", label: "All sources" }, { value: "owner", label: "Admin" }, { value: "web", label: "Web" }, { value: "gateway", label: "Gateway" }, { value: "system", label: "System" }]} /></label>
        <label>Action<Input name="action" defaultValue={state.action} maxLength={120} /></label>
        <label>Resource<Input name="resource" defaultValue={state.resource} maxLength={160} /></label>
        <label>Result<SearchSelect name="result" defaultValue={state.result} searchable={false} options={[{ value: "", label: "All results" }, { value: "success", label: "Success" }, { value: "failure", label: "Failure" }, { value: "denied", label: "Denied" }]} /></label>
        <div className="heading-actions"><Button type="submit">Apply</Button><Button asChild type="button" variant="secondary"><a href="/owner/audit-logs">Reset</a></Button></div>
      </form>
      <AuditLogsTable rows={rows} />
      <Pagination page={page} pageSize={pageSize} totalPages={totalPages} total={total} noun="events" previousHref={hasPreviousPage ? auditLogsHref(state, { page: page - 1 }) : ""} nextHref={hasNextPage ? auditLogsHref(state, { page: page + 1 }) : ""} />
    </Card>
  </>;
}
