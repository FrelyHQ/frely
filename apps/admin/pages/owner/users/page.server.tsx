import { Button } from "@frely/ui/components/button";
import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import Link from "@admin/navigation";
import { CreateUserDialog, UsersTable } from "../../../features/users";
import { buildOwnerUsersPageAggregate, buildOwnerUsersPageAggregateAsync, ownerUsersHref } from "../../../lib/teams";
import { adminPageServices } from "../../../lib/server";
import { DirectoryPanel } from "../_components/directory-panel";
import { MetricCard, PageHeading } from "../_components/ui";

interface UsersPageProps {
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
  const users = await buildOwnerUsersPageAggregateAsync(application.queries, { query: singleValue(params?.q), page: pageNumber(params?.page), pageSize: normalizeTablePageSize(params?.pageSize) });
  const teams = (await application.queries.listTeams())
    .filter((team) => team.status === "enabled")
    .map((team) => ({ id: team.id, name: team.name }));
  return { users, teams };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

function singleValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}


function pageNumber(value: string | string[] | undefined) {
  const raw = singleValue(value);
  return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}
