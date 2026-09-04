import { Button } from "@frely/ui/components/button";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import Link from "@admin/navigation";
import { buildAdminKeysPageAggregate, buildAdminKeysPageAggregateAsync, ownerKeysHref } from "../../../lib/teams";
import { adminPageServices } from "../../../lib/server";
import { DirectoryPanel } from "../_components/directory-panel";
import { MetricCard, PageHeading } from "../_components/ui";
import { ApiKeysTable } from "../../../features/api-keys";

interface KeysPageProps {
  searchParams?: Promise<{ q?: string | string[]; page?: string | string[]; pageSize?: string | string[] }>;
}

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const { application } = admin;
  const params = await searchParams;
  const input = { query: singleValue(params?.q), page: pageNumber(params?.page), pageSize: normalizeTablePageSize(params?.pageSize) };
  const keys = await buildAdminKeysPageAggregateAsync(application.queries, input);
  return { keys };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

function pageNumber(value: string | string[] | undefined) {
  const raw = singleValue(value);
  return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}


function singleValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
