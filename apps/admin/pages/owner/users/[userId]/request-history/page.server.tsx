import { MetricCard, PageHeading, StatusBadge } from "@frely/console-ui";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { normalizeTablePageSize, type TablePageSize } from "@frely/console-ui/pagination";
import { RequestLogFilters } from "@frely/console-ui/request-log-filters";
import { UserRequestHistoryTable } from "@frely/console-ui/request-history-table";
import { Button } from "@frely/ui/components/button";
import { Card } from "@frely/ui/components/card";
import {
  loadUserRequestHistoryAudienceAsync,
  type UserRequestHistoryFilter,
} from "@frely/tenancy/audience-server";
import { notFound } from "@admin/navigation";
import { AdminViewSwitcher } from "../../../_components/owner-view-switcher";
import { adminPageServices } from "../../../../../lib/server";

interface OwnerUserRequestHistoryPageProps {
  params: Promise<{ userId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const params = Promise.resolve(request.params);
  const searchParams = Promise.resolve(request.search);
  const { userId } = await params;
  if (!userId) notFound();
  const query = await searchParams;
  const admin = await adminPageServices();
  if (!admin) return null;
  const model = await loadUserRequestHistoryAudienceAsync({
      repo: admin.application.queries,
      identity: admin.asyncTenancy.identity,
      archiveReader: admin.requestLogArchiveReader,
      capturePresenceReader: admin.requestCaptureReader,
      captureSummaryReader: admin.requestCaptureClient.repo,
      viewerUserId: userId,
      targetUserId: userId,
      cursor: singleValue(query?.cursor).slice(0, 2_000),
      pageSize: normalizeTablePageSize(query?.pageSize),
      apiKeyPage: pageNumber(singleValue(query?.apiKeyPage)),
      apiKeyPageSize: normalizeTablePageSize(query?.apiKeyPageSize),
      filter: requestHistoryFilter(query),
    });
  if (!model) notFound();
  const newestHref = requestHistoryHref(userId, model.filter, {
    apiKeyPage: model.apiKeyOptions.page,
    apiKeyPageSize: model.apiKeyOptions.pageSize,
    pageSize: model.page.pageSize,
  });
  const olderHref = model.page.nextCursor
    ? requestHistoryHref(userId, model.filter, {
        cursor: model.page.nextCursor,
        pageSize: model.page.pageSize,
        apiKeyPage: model.apiKeyOptions.page,
        apiKeyPageSize: model.apiKeyOptions.pageSize,
      })
    : "";
  return { userId, model, newestHref, olderHref };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

function requestHistoryFilter(
  params: Record<string, string | string[] | undefined> | undefined,
): Partial<Record<keyof UserRequestHistoryFilter, string>> {
  return {
    status: singleValue(params?.status),
    apiKeyId: singleValue(params?.apiKeyId),
    model: singleValue(params?.model),
    duration: singleValue(params?.duration),
    start: singleValue(params?.start),
    timeWindow: singleValue(params?.timeWindow),
  };
}


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


function pageNumber(value: string) {
  const page = Number(value);
  return Number.isFinite(page) ? Math.max(1, Math.min(10_000, Math.trunc(page))) : 1;
}


function singleValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
