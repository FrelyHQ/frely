import { notFound } from "@web/navigation";
import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { loadUserRequestHistoryAudienceAsync, requestHistoryBatchDownloadQuery, type UserRequestHistoryFilter } from "@frely/tenancy/audience-server";
import { requireWebUserPage } from "../../../lib/web-page";

export async function loadPage(search: Record<string, string | string[] | undefined>) {
  const { services, claims, view } = await requireWebUserPage("/user/request-history");
  const filter = requestHistoryFilter(search);
  const model = await loadUserRequestHistoryAudienceAsync({
    repo: services.application.queries,
    identity: services.asyncTenancy.identity,
    archiveReader: services.requestLogArchiveReader,
    capturePresenceReader: services.requestCaptureReader,
    captureSummaryReader: services.requestCaptureClient.repo,
    viewerUserId: claims.sub,
    targetUserId: claims.sub,
    cursor: singleValue(search.cursor).slice(0, 2_000),
    pageSize: normalizeTablePageSize(search.pageSize),
    apiKeyPage: pageNumber(singleValue(search.apiKeyPage)),
    apiKeyPageSize: normalizeTablePageSize(search.apiKeyPageSize),
    filter,
  });
  if (!model) notFound();
  return {
    model,
    downloadQuery: requestHistoryBatchDownloadQuery(model.filter),
    apiKeyTotal: view.apiKeyTotal,
    activeApiKeys: view.activeApiKeys,
  };
}

export type UserRequestHistoryPageData = Awaited<ReturnType<typeof loadPage>>;

function requestHistoryFilter(params: Record<string, string | string[] | undefined>): Partial<Record<keyof UserRequestHistoryFilter, string>> {
  return {
    status: singleValue(params.status),
    apiKeyId: singleValue(params.apiKeyId),
    model: singleValue(params.model),
    duration: singleValue(params.duration),
    start: singleValue(params.start),
    timeWindow: singleValue(params.timeWindow),
  };
}

function pageNumber(value: string) {
  const page = Number(value);
  return Number.isFinite(page) ? Math.max(1, Math.min(10_000, Math.trunc(page))) : 1;
}

function singleValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
