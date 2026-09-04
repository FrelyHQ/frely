import { MaterialTablePagination } from "@frely/console-ui/material-table-pagination";
import { adminTeamsHref, buildAdminTeamsAggregate, buildAdminTeamsAggregateAsync, parseAdminTeamsSearch } from "../../../lib/teams";
import { adminPageServices } from "../../../lib/server";
import { DirectoryPanel } from "../_components/directory-panel";
import { MetricCard, PageHeading } from "../_components/ui";
import { CreateTeamDialog, TeamsTable } from "../../../features/teams";
import { traceRscPreparation } from "@frely/observability/server";

interface TeamsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const prepared = await traceRscPreparation("/owner/teams", async () => {
    const admin = await adminPageServices();
    if (!admin) return null;
    const params = await searchParams;
    const search = parseAdminTeamsSearch(params);
    return buildAdminTeamsAggregateAsync(admin.application.queries, search);
  });
  if (!prepared) return null;
  const teams = prepared;
  return { teams };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
