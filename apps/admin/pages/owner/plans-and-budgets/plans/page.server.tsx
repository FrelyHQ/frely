import { adminPageServices } from "../../../../lib/server";
import { PlansView } from "../../../../features/plans";
import { parsePlansUrlState } from "../../../../features/plans/lib/plan-url-state";

interface PlansPageProps {
  searchParams?: Promise<{ q?: string | string[]; status?: string | string[]; page?: string | string[]; pageSize?: string | string[] }>;
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
  const state = parsePlansUrlState(await searchParams);
  const directory = await application.queries.pagePlanDirectory(state);
  return { state, directory };
}

export type AdminPageData = Awaited<ReturnType<typeof loadPage>>;
