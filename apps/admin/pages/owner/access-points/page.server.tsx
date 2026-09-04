import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { adminPageServices } from "../../../lib/server";
import type { AccessPointPageData } from "../../../features/access-points/types";
import { accessPointBoundaryData } from "./page-data";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const params = await searchParams;
  const page = pageNumber(params?.page);
  const pageSize = normalizeTablePageSize(params?.pageSize);
  const directory = await admin.application.queries.pageAccessPointDirectory({ page, pageSize });
  const accessPoints = await Promise.all(directory.items.map(async (row) => {
    const [source, impact] = await Promise.all([
      admin.application.modelAccessQueries.getAccessPointWithRouting(row.id),
      admin.application.queries.accessPointPlanImpact(row.id),
    ]);
    if (!source) throw new Error("access_point_routing_missing");
    return accessPointBoundaryData(source, impact);
  })) satisfies AccessPointPageData["accessPoints"];
  const data = {
    accessPoints,
    currentUserScopeRef: `user:${admin.claims.sub}`,
  } satisfies AccessPointPageData;
  return {
    directory: {
      page: directory.page,
      pageSize: directory.pageSize,
      total: directory.total,
      totalPages: directory.totalPages,
    },
    data,
  };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;

function pageNumber(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return /^\d+$/.test(raw) ? Math.max(1, Math.min(10_000, Number(raw))) : 1;
}
