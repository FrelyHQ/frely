import { adminPageServices } from "../../../../lib/server";
import { normalizeTablePageSize } from "@frely/console-ui/pagination";
import { grantBatchPageData } from "./page-data";

export interface AdminPageRequest {
  params: Record<string, string>;
  search: Record<string, string | string[] | undefined>;
}

export async function loadPage(request: AdminPageRequest) {
  const searchParams = Promise.resolve(request.search);
  const admin = await adminPageServices();
  if (!admin) return null;
  const params = await searchParams;
  const batchId = (Array.isArray(params?.batchId) ? params?.batchId[0] : params?.batchId)?.trim();
  const rawPage = Array.isArray(params?.page) ? params?.page[0] : params?.page;
  const page = Math.min(10_000, Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1));
  const pageSize = normalizeTablePageSize(params?.pageSize);
  const detail = batchId
    ? await admin.application.queries.getAdminGrantBatchDetail(batchId, pageSize, (page - 1) * pageSize)
    : undefined;
  const view = detail ? grantBatchPageData(detail, page, pageSize) : undefined;
  return { view };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
