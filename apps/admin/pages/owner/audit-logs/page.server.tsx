import { buildAuditLogsAggregate } from "../../../features/logs/lib/audit-log-aggregate";
import { parseAuditLogUrlState } from "../../../features/logs/table/log-url-state";
import { adminPageServices } from "../../../lib/server";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const state = parseAuditLogUrlState(await searchParams);
  const page = await admin.application.auditQueries.pageAuditLogs(state);
  const aggregate = buildAuditLogsAggregate(page.items, { ...state, page: page.page }, page);
  return { state, page: { page: page.page }, aggregate };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
