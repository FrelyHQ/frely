import { queryRequestLogsAcrossStorageAsync } from "@frely/ui-application/server";
import { RequestLogsView, buildRequestLogsAggregate, buildRequestLogsAggregateAsync, parseRequestLogUrlState, requestLogArchiveTimeFilter } from "../../../features/logs";
import { adminPageServices } from "../../../lib/server";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const state = parseRequestLogUrlState(await searchParams);
  const logs = await buildRequestLogsAggregateAsync(
      admin.application.queries,
      admin.asyncTenancy.identity,
      admin.asyncTenancy.tenancy,
      state.status,
      state.timeWindow,
      state.start,
      state.page,
      state.pageSize,
      state.providerId,
      state.model,
      state.apiKeyId,
      state.owner,
      state.duration,
      await queryRequestLogsAcrossStorageAsync(admin.application.queries, admin.requestLogArchiveReader, requestLogArchiveTimeFilter(state.start, state.timeWindow)),
    );
  return { state, logs };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
